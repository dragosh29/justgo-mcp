# JustGo MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients look things up in a JustGo sports membership platform: members, their memberships and credentials (coaching and officiating qualifications, licences, with expiry dates), events and event bookings, and clubs and other organisations. With writes enabled, it can also change the dates of one member's membership. It is built from JustGo's public API documentation only: the OpenAPI 3.0.1 document "JustGo API" 2.2 at `api.justgo.com/swagger/v2.2/swagger.json`, shown in the Swagger UI at [api.justgo.com/index.html](https://api.justgo.com/index.html). The spec has no `servers` block; the base URL `https://api.justgo.com` is inferred from where the spec is served.

Once it's connected, someone at a governing body or club can ask things like:

- "Is Jo Bloggs's membership active, and which clubs is she in?"
- "Which of Jo's coaching qualifications expire before the end of the year?"
- "Which members are suspended?"
- "What competitions are published, how many places are left on the Autumn Gala, and who has booked?"
- "Which clubs in the South West hold the SwimMark accreditation, and when does it expire?"
- With writes enabled: "Extend Jo's Adult Competitive membership to 31 March 2027."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `find_members` | Search members with every filter the endpoint documents: `Email`, `memberNumber`, `LoginId`, `LastName`, `OrganisationId`, `CredentialId`, `EventId`, `Membership`, `SuspendStatus`, `ModifiedAfter`, `ModifiedBefore`. Returns ID, member number, name, member status and suspension level. Pages by `PageNumber`/`PageSize`. | `GET /api/v2.2/Members/FindByAttributes` |
| `get_member` | One member with their memberships, organisations (with roles), credentials, event bookings and linked family members. | `GET /api/v2.2/Members/{memberId}` |
| `list_member_memberships` | Memberships held by members: name, category, classification, type, status, start and end dates, membership number, owner. Filters `MemberId`, `Status`, `Category`, `Classification`, `OwnerType`, `OwnerId`, `DefinitionId`, `ModifiedAfter`, `ModifiedBefore`. | `GET /api/v2.2/Memberships/Member/FindByAttributes` |
| `list_member_credentials` | Credentials held by members: name, type, status, reference number, start and end (expiry) dates. Filters `MemberId`, `DefinitionId`, `Status`, `Category`, `ModifiedAfter`, `ModifiedBefore`. | `GET /api/v2.2/Credentials/Member/FindByAttributes` |
| `list_events` | Events with dates, booking deadline, venue, category, status, organiser, details and stages. Filters `OrganisationId`, `EventCategory`, `EventSubcategory`, `Status`, `EventNumber`, `ModifiedAfter`, `ModifiedBefore`. | `GET /api/v2.2/Events/FindByAttributes` |
| `get_event` | One event with its tickets (price, booked, remaining places), promoters and stages. | `GET /api/v2.2/Events/{eventId}` |
| `list_event_bookings` | Bookings (the API calls them candidates): who booked which ticket, booking status and dates. Filters `BookingStatus`, `EventId`, `Category`, `SubCategory`, `ModifiedAfter`, `ModifiedBefore`. | `GET /api/v2.2/Events/Candidate/FindByAttributes` |
| `list_organisations` | Clubs and other organisations: number, type, status, town, region, country, website, join link. Filters `OrganisationNumber`, `Status`, `Type`, `CredentialId`, `MembershipName`, `OrganisationId`, `ModifiedAfter`, `ModifiedBefore`. | `GET /api/v2.2/Organisations/FindByAttributes` |
| `get_organisation` | One organisation with its awards (organisation credentials, granted and expiry dates) and memberships. | `GET /api/v2.2/Organisations/{organisationId}` |
| `update_membership_dates` | Changes the start and/or end date of one member's membership. Reads the membership first, sends the date that was not given unchanged, refuses locally when the end would be before the start, and returns the previous dates so the change can be reverted. Only registered when writes are enabled. | `GET /api/v2.2/Memberships/Member/{membershipId}`, `PUT /api/v2.2/Memberships/Member/{membershipId}` |

The list tools take `page` (default 1), `page_size` (1 to 100, default 50) and `max_pages` (default 2). The page size stays fixed within a call so page numbers line up; when more remains, the result says which `page` to continue from. If the API applies a smaller page size than the one asked for, the result reports it as `page_size_applied`.

Not covered on purpose: every other write (creating or updating members, suspending members, adding members to clubs, creating credentials, memberships, events, stages, promoters and bookings, deleting anything), profile image upload, `Members/LogInCheck`, `Members/PasswordReset` and `Members/ChangePassword` (end users' passwords), competitions and rankings, shops and orders, rewards links, the `/Schema` endpoints, credential and membership definitions, and organisation-level credentials and memberships.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need the API secret JustGo issues for your organisation's account. The spec documents the exchange but not how the secret is issued: the "Published API" appears as a plan capability on justgo.com, so ask JustGo. The server posts the secret to `POST /api/v2.2/Auth` as `{"secret": "..."}` and sends the JWT it gets back as `Authorization: Bearer …` on every other request.

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "justgo": {
      "command": "node",
      "args": ["/absolute/path/to/justgo-mcp/dist/index.js"],
      "env": { "JUSTGO_SECRET": "your-secret" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add justgo -e JUSTGO_SECRET=your-secret -- node /absolute/path/to/justgo-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `JUSTGO_SECRET` | yes | The API secret, exchanged at `POST /api/v2.2/Auth` for a JWT. |
| `JUSTGO_ALLOW_WRITES` | no | `true` to register `update_membership_dates`. Off by default. |
| `JUSTGO_BASE_URL` | no | Defaults to `https://api.justgo.com` (inferred; the spec has no `servers` block). Used by the tests. |

## Safety defaults

- Read-only unless `JUSTGO_ALLOW_WRITES=true`. The nine read tools carry the MCP `readOnlyHint` annotation. `update_membership_dates` is marked `destructiveHint: true` (it overwrites the stored dates) and `idempotentHint: true` (repeating it with the same dates changes nothing further).
- Members of sports governing bodies and clubs include children, so by default a person (member, linked family member, booker, event promoter) is identified by ID, member number and name only. Email addresses, phone numbers, postal addresses, dates of birth, gender, login names, last-login times and parents' names and emails are only returned when a tool is called with `include_contact_details=true`. A club's email, phone number, street address, postcode and map position are treated the same way, because they are often a volunteer's own; its town, region, country, website and join link are returned. An event's venue address is returned by default: it is where the event takes place.
- Never returned, even on request: the untyped `additionalDetails` member of members, events and organisations and the untyped `optin` member of members. The spec gives them no schema, and custom-form answers of this kind can hold medical, safeguarding, emergency-contact or consent information. When a record has them, the output lists their names under `not_returned`, so the assistant can say the record holds more than it was shown. No file is ever downloaded, and no bank, card or payment data is requested: none of the endpoints used returns it.
- In free text, email addresses are replaced with `[email redacted]` and phone-number-like sequences with `[phone redacted]`. In people's names (members, linked family members, bookers, promoters), event and course names and details, venue and location text, stage names and descriptions, and the organisation names shown by the organisation and event tools this is the default, and the raw text is returned with `include_contact_details`. Some free text is always redacted, even on request: the names of memberships, credentials, tickets, awards and club memberships, the names of the organisations on a member's record, the roles of club members and event promoters, linked family members' references, and JustGo's own error messages. The phone match is a heuristic: it covers international numbers written with `+` or `00`, with or without a bracketed trunk prefix or area code (`+44 (0)7700 …`, `+1 (555) 123-4567`, `+61 (02) 9876 5432`), numbers with a bracketed UK or North American area code such as `(020) 7946 0958` or `(555) 123-4567`, and UK-style `0…` numbers of 9 to 11 digits with spaces, dots or hyphens between groups. Other digit strings starting with `0` are redacted too, while UUIDs, numeric IDs, timestamps and hyphenated references are left alone. Credential reference numbers, ticket codes, award and club-membership references and websites are structured values and are returned unredacted. Note that a `find_members` search on an email address still confirms that the address is registered, even though it is not shown.
- The secret and the JWT are never written to a log or an error message; if JustGo ever echoed the secret or the current token in an error, it would be replaced with `[redacted]`. From an error response only the documented JSON fields (`message`, and the `errors` and `details` maps) are passed on; a non-JSON body (a gateway page, a login page) is never quoted.
- Arguments are checked before any call. An argument a tool does not declare (a misspelt or invented filter such as `first_name` or `lastName`) is refused with its name, so it never turns into an unfiltered search. Every ID on the endpoints used is typed `format: uuid` in the spec, so only UUIDs are accepted; the one exception is `list_events`'s `organisation_id`, which the spec types as a plain string of up to 500 characters and which is passed as given. String filters use the spec's `maxLength` where it gives one; where it gives none (`SuspendStatus`, `EventNumber`, and the membership `Status`, `Category`, `Classification` and `OwnerType`), 500 characters is this server's own cap. `modified_after`/`modified_before` are typed `date-time` in the spec: a date-time with seconds and a time zone (`2026-09-01T00:00:00Z`, `2026-09-01T10:30:00+01:00`) is sent as given, a bare date (`2026-09-01`) is sent as midnight UTC that day (`2026-09-01T00:00:00Z`), and a date-time without seconds or a time zone is refused rather than guessed; impossible dates such as 2026-02-30 are refused. The dates for `update_membership_dates` must be full date-times with seconds and a time zone, for the same reason.
- JustGo documents no rate limit: neither the spec nor the Swagger UI says anything about one. Requests are spaced 250 ms apart (about four per second). A 429 is retried at most twice for any method, on the assumption that a rate-limited request was not processed, waiting for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent or unreadable). Each wait is capped at 10 seconds; if JustGo asks for a longer wait the call gives up at once and the message says how long to wait. A tool call that makes several requests (pages, lookups) can still run past the MCP client's default 60-second request timeout.
- 502, 503 and 504 are retried the same way for `GET` and for `POST /Auth` (asking for a token again changes nothing). When all three attempts fail the error says the service may be unavailable. The membership `PUT` is never retried after a gateway error, because it may already have been applied; the error says to check the membership first.
- The JWT is cached. If its `exp` claim is present (read, not verified), a new one is fetched a minute before it expires (or halfway through its remaining life when that is under two minutes); without `exp` it is kept until the API answers 401. On a 401 the server fetches one fresh JWT and retries once; if that is refused too, the message says to check that the secret is still active.
- A 200 whose body is not a JSON object is reported as an error naming `JUSTGO_BASE_URL`, never as an empty list. A get-by-ID that answers 200 without a record is reported as not found.

## Tests

```bash
npm test
```

The suite builds the server and runs `test/e2e.mjs` (32 checks, about 40 seconds):

1. Validates every fixture record against the component schemas in JustGo's published spec (`MemberListV2_2Dto`, `MemberV2_2Dto`, `MemberMembershipListDtoV2_2`, `MemberSingleMembershipDtoV2_2`, `MemberCredentialDtoV2_2`, `EventResponseDtoListV2_2`, `EventDtoSingleV2_2`, `EventCandidateDtoV2_2`, `ClubDtoV2_2`, `ClubSingleDtoV2_2` and everything they embed) with Ajv and `ajv-formats`. Every one of these schemas sets `additionalProperties: false`, so a fixture key the spec does not declare fails; negative controls prove an undeclared key and a malformed UUID are rejected. One deliberate loosening: OpenAPI 3.0 allows `nullable: true` without a type, which Ajv refuses, so on the spec's eleven untyped members (the `additionalDetails`, `optin`, `additionalData` and one `data` member) that marker is dropped and they are validated as "any value". The spec is saved as `spec.json` and downloaded from `api.justgo.com/swagger/v2.2/swagger.json` on the first run when missing. The spec has no examples, so the fixture values are invented; only their shape comes from the spec. It then checks the built redaction helper on UK, international and North American phone forms (and that UUIDs, timestamps and references are left alone), that a dotted string such as `api.justgo.com` or `2.2.0` is not taken for a JWT, and when a cached JWT is replaced for a given `exp` (a minute early, or halfway through when under two minutes remain).
2. Starts a local mock of the API: `POST /api/v2.2/Auth` taking `{ secret }` and returning a JWT built at run time (401 for a wrong secret, 400 for an empty one), `Bearer` checks on every other route with 401 for an unknown token, the documented `PageNumber`/`PageSize` paging with `pageNumber`, `pageSize`, `totalPages` and `totalRecords` (each of the last three can be left out, and the page size capped, to test the fallbacks), 400 for a `ModifiedAfter`/`ModifiedBefore` that is not an RFC 3339 date-time, the documented single-record envelope `{ statusCode, message, object, data }`, 400 in the documented `Http400BadRequestResponse` shape for a malformed ID, 404 in the `Http404NotFoundResponse` shape for an unknown one, a one-off 429 with `Retry-After`, and it records every request (method, path, query, headers, body). The mock's list, detail, update, 400, 401 (in the `Http401UnAuthorizedResponse` shape, which the spec documents for 403) and 404 responses are validated against the schemas the spec names for each operation. One mock answer is deliberately outside the spec: a get-by-ID answering 200 with `data: null`, to test the server's handling of an unknown ID in that form; the suite asserts that this answer does not match the documented schema.
3. Drives the built server over stdio with the official MCP client: tools/list and annotations; writes absent with `JUSTGO_ALLOW_WRITES` unset or `false`; the token request in its documented form, without an `Authorization` header, with the JWT reused across calls; paging across pages 1, 2 and 3 with a full last page, stopping at `totalPages` with no fourth request, with requests at least 250 ms apart; without `totalPages`, stopping once `totalRecords` records are fetched, following a smaller page size the API applies (reported in `pageSize` or not), and without `totalRecords` either, stopping at a short page or after an empty one; continuation from `next_page`; every documented filter of all six list tools passed through under its documented name and value, with bare dates sent as midnight-UTC date-times; redaction of contact details, dates of birth, addresses and parents' details by default and their return on request; emails and phone numbers typed into a member's first or last name, a linked family member's name, a booker's name and a promoter's role redacted by default (the role even on request); `additionalDetails` and `optin` content never returned, even on request; club contact details and promoters' contacts only on request; emails and phone numbers (including a `+1 (555) …` number) in event details and stage descriptions redacted; ID and date validation before any call, including date-times without seconds or a time zone and unknown or misspelt argument names; the not-found message for a 404 and for a 200 without a record; the membership `PUT` preceded by a `GET`, its body validated against `MemberLicensePutDto`, the unchanged date carried over and the change visible afterwards; the local refusals (end before start, no stored date, nothing to change) with no `PUT` sent; a 429 on the `PUT` retried once and a 502 on the `PUT` not retried; a 400's message and `errors` passed on with contact details redacted and the secret scrubbed, and the current JWT scrubbed when a message echoes it; the 403 message; a revoked JWT replaced once on 401 and a persistent 401 reported without a loop; the JWT found in a text, JSON-string or JSON-object `/Auth` response, including one whose envelope also holds dotted strings such as `api.justgo.com`, and a response without one reported by its keys only; a 429 and a 502 from `/Auth` retried; two parallel first calls sharing one token request; a JWT refreshed from its `exp` claim and one without `exp` reused; the 429 retry waiting for `Retry-After` in the seconds, fractional-seconds and HTTP-date forms, giving up after three attempts on a persistent 429 and at once on a wait above the cap; a 502 retried for `GET`; three 503s reported with advice and without the gateway HTML; a non-JSON 200 reported as an error; a wrong secret reported with a message naming `JUSTGO_SECRET` and not repeating it; and, as the last check, that every request the MCP servers made during the run used a documented method, path and query parameter names, with a JWT the mock issued as `Bearer` on every call except `/Auth`.

The mock applies only some filters to its data (`LastName`, `Email`, `memberNumber`, `MemberId`, `Status`, `EventCategory`, `EventId`, `BookingStatus`, `Type`, `OrganisationId`, and the modified dates on members, credentials, events and organisations); for the others the suite checks that they reach the API exactly as documented, not what JustGo does with them.

## Status

This is a working prototype. It has **not been run against the live API**, because it was built without a JustGo account (JustGo offers no trial; the API is a plan capability). Everything below comes from the published spec and should be confirmed on a real account:

- The `/Auth` response. The spec documents only "200 Success" with no body, so the server looks for a JWT (the whole body, or a string inside a JSON object's `data` member or at its top level, members named like `token` first) and only accepts a value whose first segment decodes to a JWT header with an `alg`. Which form JustGo uses, whether the JWT carries `exp`, how long it lasts, and what a wrong secret gets (the mock answers 401; during research an empty secret got 400 from the live API) are unconfirmed.
- How the secret is issued, what it can see (one organisation or a whole governing body) and when the API answers 403.
- Paging: that `PageNumber` is 1-based (assumed), the default and maximum `PageSize` (the server sends at most 100, its own cap), that `pageSize`, `totalPages` and `totalRecords` are always filled (the spec lists them but marks none required), and what a page past the end returns. Without `totalPages` the server stops once `totalRecords` records are accounted for, and without either at a page shorter than the page size. If the API applied a smaller page size than asked without reporting it in `pageSize`, the server infers it from a short page while `totalRecords` says more follow; a call that starts past page 1 in that situation could stop early.
- What the API answers for an unknown ID. The spec documents no 404 for these endpoints (only `GET /Events/{eventId}/Promoters` has one); the server handles a 404 and a 200 without a record, and a 400 is passed on with JustGo's message.
- Filter semantics: whether `LastName`, `Email`, `Membership` and `MembershipName` match exactly or partially, the allowed values of `Status`, `Category`, `Classification`, `OwnerType`, `SuspendStatus`, `BookingStatus`, `Type` and `EventSubcategory` (the spec lists none), whether `ModifiedAfter`/`ModifiedBefore` are inclusive and whether the API reads them in UTC (the server sends a bare date as midnight UTC, which is an hour off UK local midnight in summer), and whether `list_events`'s `OrganisationId` takes a UUID or an organisation number (it is typed as a plain string).
- The sort order of every list. The spec documents none; the server returns whatever order the API uses.
- Date formats. The spec types dates as `date` or `date-time`; the fixtures use `2026-08-01` and `2026-08-01T09:00:00Z`. If the live API emits date-times without a time zone (common for .NET services) or dates of birth as date-times, the server passes them through unchanged, but the suite's schema check would fail on such values.
- Which fields the live API actually fills, and what `additionalDetails` and `optin` contain. The server never returns either.
- `PUT /Memberships/Member/{membershipId}`: whether both `startDate` and `endDate` are required (the server always sends both), how the time zone is read, whether the change triggers emails, renewals, payments or status changes in JustGo, whether `application/json` is accepted (the spec lists it alongside `application/json-patch+json`), and what the 201 body contains (the spec says `Http200UpdateResponse`).
- The wording of JustGo's error messages and whether any of them echo request data; the texts in the mock are its own, because the spec has no examples.
- A 429 is retried for the `PUT` too, on the assumption that a rate-limited request was not applied; JustGo documents no 429 at all.
- How many requests per second the API tolerates; nothing is documented, so the 250 ms spacing is a guess on the polite side.

## Going to production

This version runs locally over stdio with the organisation's own API secret. For governing bodies and clubs to connect from claude.ai or ChatGPT without handling secrets, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by JustGo, so each user's own permissions apply, and then a listing in the Claude and ChatGPT connector directories. Further write tools (suspensions, credential updates, bookings) can follow once they can be tested on a real account.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
