#!/usr/bin/env node
// JustGo MCP server: lets Claude, ChatGPT and other MCP clients look up members, memberships,
// credentials, events, event bookings and organisations in a JustGo sports membership platform.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JustGoClient, JustGoError, MAX_PAGE_SIZE, type QueryValue } from "./client.js";
import * as fmt from "./format.js";

const secret = process.env.JUSTGO_SECRET?.trim();
if (!secret) {
  console.error("JUSTGO_SECRET is not set. Use the API secret JustGo issued for your organisation's account.");
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.JUSTGO_ALLOW_WRITES ?? "");
const api = new JustGoClient(secret, process.env.JUSTGO_BASE_URL || undefined);

const server = new McpServer(
  { name: "justgo", version: "0.1.0" },
  {
    instructions: [
      "Tools for a JustGo sports membership platform (members, memberships, credentials such as coaching qualifications, events and their bookings, clubs and other organisations).",
      "Every record is identified by a UUID. Search with find_members, list_events or list_organisations, then use the id with the get_ tools or as a filter on the list_ tools.",
      "Typical flow for 'which of Jo Bloggs's qualifications expire soon?': find_members with last_name, then list_member_credentials with the member's id and read end_date.",
      "Members can be children. Names and membership status are returned by default; emails, phone numbers, addresses, dates of birth, gender, login names and parents' details only when explicitly requested with include_contact_details. Free-form additional details and opt-in answers are never returned.",
      "Filter values such as status, category and type are passed to JustGo as given; the spec does not list the allowed values.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;

// Every ID on the endpoints this server calls is typed `string, format: uuid` in the spec.
const uuid = (what: string) => z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, `${what} IDs are UUIDs, e.g. 3f2b8c1e-7a4d-4e21-9c55-1b2a3c4d5e6f`);
// RFC 3339 date-time with seconds and a time zone: what the spec's `format: date-time` means.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// ModifiedAfter/ModifiedBefore are typed `date-time` in the spec. A full date-time with a time zone is
// sent as given; a bare date is sent as midnight UTC that day (see asDateTime). A date-time without
// seconds or a time zone is refused rather than guessed.
const isoDate = z
  .string()
  .refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || DATE_TIME.test(s), "Use a date such as 2026-09-01 (sent as 2026-09-01T00:00:00Z) or a date-time with seconds and a time zone such as 2026-09-01T00:00:00Z")
  .refine((s) => !Number.isNaN(Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s)) && validCalendarDate(s.slice(0, 10)), "Not a real calendar date");
const asDateTime = (s: string | undefined) => (s && s.length === 10 ? `${s}T00:00:00Z` : s);
const modifiedQuery = (a: { modified_after?: string; modified_before?: string }) => ({ ModifiedAfter: asDateTime(a.modified_after), ModifiedBefore: asDateTime(a.modified_before) });
function validCalendarDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}
// `max` is the parameter's maxLength in the spec; where the spec gives none, OWN_MAX is this server's own cap.
const text = (max: number) => z.string().trim().min(1).max(max);
const OWN_MAX = 500;
// Every tool's arguments are checked strictly: an unknown or misspelt argument is refused with its name
// instead of being dropped, so a mistyped filter never turns into an unfiltered search.
const input = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();

const paging = {
  page: z.number().int().min(1).default(1).describe("Page to start from (1 is the first page; use next_page from a previous call to continue)"),
  page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50).describe(`Records per page (1-${MAX_PAGE_SIZE})`),
  max_pages: z.number().int().min(1).max(20).default(2).describe("How many pages to fetch in this call"),
};
const modified = {
  modified_after: isoDate.optional().describe("Only records modified after this date-time (ModifiedAfter). A bare date is sent as midnight UTC that day."),
  modified_before: isoDate.optional().describe("Only records modified before this date-time (ModifiedBefore). A bare date is sent as midnight UTC that day."),
};
const includeContact = (what: string) => z.boolean().default(false).describe(what);

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof JustGoError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

type Paged = { page: number; page_size: number; max_pages: number };
async function pagedList(path: string, args: Paged, query: Record<string, QueryValue>) {
  const r = await api.list(path, { page: args.page, pageSize: args.page_size, maxPages: args.max_pages, query });
  return {
    meta: {
      count: r.items.length,
      first_page: args.page,
      page_size: args.page_size,
      page_size_applied: r.page_size_applied,
      total_records: r.total_records,
      total_pages: r.total_pages,
      complete: r.complete,
      next_page: r.next_page,
      note: r.complete ? undefined : `More results exist; call again with page ${r.next_page} and the same page_size to continue.`,
    },
    items: r.items,
  };
}

server.registerTool(
  "find_members",
  {
    title: "Find members",
    description:
      "Search members with JustGo's documented member filters (email, member number, login ID, last name, organisation, credential, event, membership, suspension status, modified dates). Returns ID, member number, name, member status and suspension level; contact details, date of birth, address and parents' details only with include_contact_details. Note that a match on an email filter still confirms that such an address is registered, even though the address itself is not shown.",
    inputSchema: input({
      email: z.string().trim().email().max(500).optional().describe("Email (exact value passed as Email)"),
      member_number: text(255).optional().describe("Member number (memberNumber)"),
      login_id: text(500).optional().describe("Login ID (LoginId)"),
      last_name: text(500).optional().describe("Last name (LastName)"),
      organisation_id: uuid("Organisation").optional().describe("Members of this organisation (OrganisationId)"),
      credential_id: uuid("Credential").optional().describe("Members holding this credential (CredentialId)"),
      event_id: uuid("Event").optional().describe("Members linked to this event (EventId)"),
      membership: text(500).optional().describe("Membership name (Membership)"),
      suspend_status: text(OWN_MAX).optional().describe("Suspension status (SuspendStatus); allowed values are not documented"),
      ...modified,
      ...paging,
      include_contact_details: includeContact("Include email, phone, address, date of birth, gender, login name, last login and parents' details, and stop redacting emails and phone numbers from names"),
    }),
    annotations: READ,
  },
  safe(async (a) => {
    const { meta, items } = await pagedList("/Members/FindByAttributes", a, {
      Email: a.email,
      memberNumber: a.member_number,
      LoginId: a.login_id,
      LastName: a.last_name,
      OrganisationId: a.organisation_id,
      CredentialId: a.credential_id,
      EventId: a.event_id,
      Membership: a.membership,
      SuspendStatus: a.suspend_status,
      ...modifiedQuery(a),
    });
    return { ...meta, members: items.map((m) => fmt.memberSummary(m, a.include_contact_details)) };
  }),
);

server.registerTool(
  "get_member",
  {
    title: "Get member",
    description:
      "One member with their memberships, organisations (with roles), credentials, event bookings and linked family members. Names and statuses by default; contact details, date of birth, address and parents' details only with include_contact_details. Free-form additional details and opt-in answers are never returned.",
    inputSchema: input({
      member_id: uuid("Member").describe("Member ID (UUID, from find_members)"),
      include_contact_details: includeContact("Include the member's and linked family members' contact details and dates of birth, and bookers' emails"),
    }),
    annotations: READ,
  },
  safe(async ({ member_id, include_contact_details }) => ({ member: fmt.memberDetail(await api.getRecord(`/Members/${member_id}`), include_contact_details) })),
);

server.registerTool(
  "list_member_memberships",
  {
    title: "List member memberships",
    description: "Memberships held by members (name, category, classification, status, start and end dates, owning organisation), filtered with the documented parameters. Pass member_id for one member's memberships.",
    inputSchema: input({
      member_id: uuid("Member").optional().describe("Only this member's memberships (MemberId)"),
      status: text(OWN_MAX).optional().describe("Membership status (Status)"),
      category: text(OWN_MAX).optional().describe("Category (Category)"),
      classification: text(OWN_MAX).optional().describe("Classification (Classification)"),
      owner_type: text(OWN_MAX).optional().describe("Owner type (OwnerType)"),
      owner_id: uuid("Owner").optional().describe("Owning organisation (OwnerId)"),
      definition_id: uuid("Membership definition").optional().describe("Membership definition (DefinitionId)"),
      ...modified,
      ...paging,
    }),
    annotations: READ,
  },
  safe(async (a) => {
    const { meta, items } = await pagedList("/Memberships/Member/FindByAttributes", a, {
      MemberId: a.member_id,
      Status: a.status,
      Category: a.category,
      Classification: a.classification,
      OwnerType: a.owner_type,
      OwnerId: a.owner_id,
      DefinitionId: a.definition_id,
      ...modifiedQuery(a),
    });
    return { ...meta, memberships: items.map(fmt.membership) };
  }),
);

server.registerTool(
  "list_member_credentials",
  {
    title: "List member credentials",
    description: "Credentials held by members, such as coaching or officiating qualifications and licences, with status, reference number, start date and end (expiry) date. Pass member_id for one member's credentials.",
    inputSchema: input({
      member_id: uuid("Member").optional().describe("Only this member's credentials (MemberId)"),
      definition_id: uuid("Credential definition").optional().describe("Credential definition (DefinitionId)"),
      status: text(100).optional().describe("Credential status (Status)"),
      category: text(500).optional().describe("Category (Category)"),
      ...modified,
      ...paging,
    }),
    annotations: READ,
  },
  safe(async (a) => {
    const { meta, items } = await pagedList("/Credentials/Member/FindByAttributes", a, {
      MemberId: a.member_id,
      DefinitionId: a.definition_id,
      Status: a.status,
      Category: a.category,
      ...modifiedQuery(a),
    });
    return { ...meta, credentials: items.map(fmt.credential) };
  }),
);

server.registerTool(
  "list_events",
  {
    title: "List events",
    description: "Events (courses, competitions and the like) with dates, booking deadline, venue, category, status, organiser and stages, filtered with the documented parameters.",
    inputSchema: input({
      organisation_id: text(500).optional().describe("Organisation (OrganisationId; typed as a plain string in the spec)"),
      category: text(500).optional().describe("Event category (EventCategory)"),
      sub_category: text(500).optional().describe("Event sub-category (EventSubcategory)"),
      status: text(500).optional().describe("Event status (Status)"),
      event_number: text(OWN_MAX).optional().describe("Event number (EventNumber)"),
      ...modified,
      ...paging,
      include_contact_details: includeContact("Stop redacting emails and phone numbers from event names, details, venue text and stage descriptions"),
    }),
    annotations: READ,
  },
  safe(async (a) => {
    const { meta, items } = await pagedList("/Events/FindByAttributes", a, {
      OrganisationId: a.organisation_id,
      EventCategory: a.category,
      EventSubcategory: a.sub_category,
      Status: a.status,
      EventNumber: a.event_number,
      ...modifiedQuery(a),
    });
    return { ...meta, events: items.map((e) => fmt.eventSummary(e, a.include_contact_details)) };
  }),
);

server.registerTool(
  "get_event",
  {
    title: "Get event",
    description: "One event with its tickets (price, places booked and remaining), promoters (names and roles; contact details only on request) and stages.",
    inputSchema: input({
      event_id: uuid("Event").describe("Event ID (UUID, from list_events)"),
      include_contact_details: includeContact("Include promoters' email addresses and phone numbers, and stop redacting emails and phone numbers from free text"),
    }),
    annotations: READ,
  },
  safe(async ({ event_id, include_contact_details }) => ({ event: fmt.eventDetail(await api.getRecord(`/Events/${event_id}`), include_contact_details) })),
);

server.registerTool(
  "list_event_bookings",
  {
    title: "List event bookings",
    description: "Bookings (candidates) on events: who booked which ticket, booking status and dates. Names by default, email addresses only with include_contact_details.",
    inputSchema: input({
      event_id: uuid("Event").optional().describe("Only bookings on this event (EventId)"),
      booking_status: text(500).optional().describe("Booking status (BookingStatus)"),
      category: text(500).optional().describe("Event category (Category)"),
      sub_category: text(500).optional().describe("Event sub-category (SubCategory)"),
      ...modified,
      ...paging,
      include_contact_details: includeContact("Include bookers' email addresses and stop redacting emails and phone numbers from names"),
    }),
    annotations: READ,
  },
  safe(async (a) => {
    const { meta, items } = await pagedList("/Events/Candidate/FindByAttributes", a, {
      BookingStatus: a.booking_status,
      EventId: a.event_id,
      Category: a.category,
      SubCategory: a.sub_category,
      ...modifiedQuery(a),
    });
    return { ...meta, bookings: items.map((b) => fmt.booking(b, a.include_contact_details)) };
  }),
);

server.registerTool(
  "list_organisations",
  {
    title: "List organisations",
    description: "Clubs and other organisations with number, type, status, town, region, website and join link. Email, phone, street address, postcode and map position only with include_contact_details (a club's contact details are often a volunteer's own).",
    inputSchema: input({
      organisation_number: text(500).optional().describe("Organisation number (OrganisationNumber)"),
      status: text(500).optional().describe("Status (Status)"),
      type: text(255).optional().describe("Organisation type (Type)"),
      credential_id: uuid("Credential").optional().describe("Organisations holding this credential (CredentialId)"),
      membership_name: text(500).optional().describe("Membership name (MembershipName)"),
      organisation_id: uuid("Organisation").optional().describe("One organisation (OrganisationId)"),
      ...modified,
      ...paging,
      include_contact_details: includeContact("Include email, phone, street address, postcode and map position"),
    }),
    annotations: READ,
  },
  safe(async (a) => {
    const { meta, items } = await pagedList("/Organisations/FindByAttributes", a, {
      OrganisationNumber: a.organisation_number,
      Status: a.status,
      Type: a.type,
      CredentialId: a.credential_id,
      MembershipName: a.membership_name,
      OrganisationId: a.organisation_id,
      ...modifiedQuery(a),
    });
    return { ...meta, organisations: items.map((o) => fmt.organisationSummary(o, a.include_contact_details)) };
  }),
);

server.registerTool(
  "get_organisation",
  {
    title: "Get organisation",
    description: "One club or organisation with its awards (organisation credentials, with granted and expiry dates) and memberships.",
    inputSchema: input({
      organisation_id: uuid("Organisation").describe("Organisation ID (UUID, from list_organisations)"),
      include_contact_details: includeContact("Include email, phone, street address, postcode and map position"),
    }),
    annotations: READ,
  },
  safe(async ({ organisation_id, include_contact_details }) => ({ organisation: fmt.organisationDetail(await api.getRecord(`/Organisations/${organisation_id}`), include_contact_details) })),
);

if (allowWrites) {
  // PUT replaces the stored dates: the old values are returned so the change can be undone, but the
  // tool is honestly marked destructive. Repeating it with the same dates changes nothing further.
  const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;
  const dateTime = z
    .string()
    .regex(DATE_TIME, "Use an ISO 8601 date-time with seconds and a time zone, e.g. 2027-03-31T23:59:59Z")
    .refine((s) => validCalendarDate(s.slice(0, 10)), "Not a real calendar date");

  server.registerTool(
    "update_membership_dates",
    {
      title: "Change a membership's dates",
      description:
        "Change the start and/or end date of one member's membership (PUT /Memberships/Member/{membershipId}, body { startDate, endDate }). The current membership is fetched first; a date that is not given is sent unchanged, and the previous dates are returned so the change can be reverted. Refused locally when the end would be before the start. If JustGo answers with a gateway error (502/503/504) the request is NOT retried: check with list_member_memberships before calling again. Only available when JUSTGO_ALLOW_WRITES=true.",
      inputSchema: input({
        membership_id: uuid("Membership").describe("Membership ID (the id from list_member_memberships)"),
        start_date: dateTime.optional().describe("New start date-time"),
        end_date: dateTime.optional().describe("New end date-time"),
      }),
      annotations: OVERWRITE,
    },
    safe(async ({ membership_id, start_date, end_date }) => {
      if (!start_date && !end_date) throw new JustGoError("Not changed: give start_date, end_date or both.");
      const current = await api.getRecord(`/Memberships/Member/${membership_id}`);
      const previous = { start_date: typeof current.startDate === "string" ? current.startDate : undefined, end_date: typeof current.endDate === "string" ? current.endDate : undefined };
      const startDate = start_date ?? previous.start_date;
      const endDate = end_date ?? previous.end_date;
      if (!startDate || !endDate) {
        throw new JustGoError(`Not changed: the membership has no stored ${!startDate ? "start" : "end"} date, so both start_date and end_date must be given.`);
      }
      if (Date.parse(endDate) < Date.parse(startDate)) throw new JustGoError(`Not changed: the end date ${endDate} is before the start date ${startDate}.`);
      // Body shape: spec MemberLicensePutDto { startDate: date-time, endDate: date-time }.
      const res = await api.request("PUT", `/api/v2.2/Memberships/Member/${membership_id}`, { body: { startDate, endDate } });
      return {
        result: "updated",
        membership_id,
        membership: fmt.redactContacts(current.name, false),
        previous,
        new: { start_date: startDate, end_date: endDate },
        message: fmt.redactContacts(res?.message, false),
      };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`JustGo MCP server running (writes ${allowWrites ? "enabled" : "disabled"}).`);
