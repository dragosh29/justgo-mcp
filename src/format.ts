// Turn JustGo API records into compact objects an assistant can read quickly.
// Field names follow the schemas in JustGo's OpenAPI 2.2 spec (MemberListV2_2Dto, MemberV2_2Dto,
// MemberMembershipListDtoV2_2, MemberCredentialDtoV2_2, EventResponseDtoListV2_2, EventDtoSingleV2_2,
// EventCandidateDtoV2_2, ClubDtoV2_2, ClubSingleDtoV2_2 and the records they embed).
//
// Members of sports governing bodies and clubs include children. By default a person is identified by
// ID, member number and name only. Email addresses, phone numbers, postal addresses, dates of birth,
// gender, login names, last-login times and parents' details come back only with
// include_contact_details. The untyped `additionalDetails` and `optin` members (free-form data that can
// hold medical, safeguarding, emergency-contact or consent answers) are never returned.

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Three shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional bracketed trunk prefix or area
//     code of 1-4 digits, then 6-14 digits (+44 7700 900123, +447700900321, +44 (0)7700 900123,
//     0044 20 7946 0958, +1 (555) 123-4567, +61 (02) 9876 5432);
//   bracketed area code: a UK "(0...)" code or a North American "(ddd)" code, then 5-10 digits
//     ((020) 7946 0958, (0117) 496 0000, (555) 123-4567);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so UUIDs, numeric IDs, timestamps and
// hyphenated references are left alone. Any other 9-11 digit string starting with 0 is redacted too.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(\d{1,4}\))?(?:[ .-]?\d){6,14}|\((?:0\d{0,4}|[2-9]\d{2})\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;

const redactString = (text: string) => text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]");

/**
 * Replace email addresses and phone-number-like sequences inside free text (names, event details,
 * stage descriptions, venue text, error messages) unless contact details were requested. Callers pass
 * `false` for text that is always redacted: names of memberships, credentials, tickets and awards,
 * club and promoter roles, family-member references and error messages.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? text : redactString(text);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

// Members of the untyped kind that are never passed on. Listed by name in the output when present, so
// the assistant can tell the user the record holds more than it was shown.
const NEVER_RETURNED = ["additionalDetails", "optin"];
const withheld = (r: Rec) => {
  const present = NEVER_RETURNED.filter((k) => r[k] !== undefined && r[k] !== null);
  return present.length ? present : undefined;
};

// ---- Members (MemberListV2_2Dto, MemberV2_2Dto) ----

function memberContact(m: Rec) {
  return {
    email: str(m.emailAddress),
    phone: str(m.phoneNumber),
    date_of_birth: str(m.dob),
    gender: str(m.gender),
    address: {
      line1: str(m.address1),
      line2: str(m.address2),
      town: str(m.town),
      county: str(m.county),
      postcode: str(m.postCode),
      country: str(m.country),
    },
    username: str(m.userName),
    last_login: str(m.lastLoginDate),
    parent: {
      first_name: str(m.parentFirstName),
      last_name: str(m.parentLastName),
      email: str(m.parentEmailAddress),
    },
  };
}

export function memberSummary(m: Rec, includeContact: boolean) {
  return {
    id: str(m.id),
    member_number: str(m.memberNumber),
    first_name: redactContacts(m.firstName, includeContact),
    last_name: redactContacts(m.lastName, includeContact),
    status: str(m.memberStatus),
    suspension_level: str(m.suspensionLevel),
    email_verified: bool(m.emailVerified),
    registered: str(m.registerDate),
    last_modified: str(m.lastModificationDate),
    ...(includeContact ? memberContact(m) : {}),
  };
}

// MemberLicenseDtoV2_2 (a membership as embedded in MemberV2_2Dto).
export function memberLicense(l: Rec) {
  return { id: str(l.id), definition_id: str(l.definitionId), name: redactContacts(l.name, false), status: str(l.status), start_date: str(l.startDate), end_date: str(l.endDate) };
}

// ClubMemberDtoV2_2 (an organisation the member belongs to). Roles are free text and always redacted.
export function memberOrganisation(o: Rec) {
  return { id: str(o.id), name: redactContacts(o.organisationName, false), roles: redactContacts(o.roles, false), is_primary: bool(o.isPrimary), is_admin: bool(o.isAdmin) };
}

// EventBookingDtoV2_2 (a booking embedded in MemberV2_2Dto) and EventCandidateDtoV2_2 (an event booking).
export function booking(b: Rec, includeContact: boolean) {
  return {
    id: str(b.id),
    booking_id: str(b.bookingId),
    ticket_id: str(b.ticketId),
    candidate_id: str(b.candidateId),
    member_number: str(b.memberNumber),
    first_name: redactContacts(b.firstName, includeContact),
    last_name: redactContacts(b.lastName, includeContact),
    ticket_code: str(b.ticketCode),
    course_name: redactContacts(b.courseName, includeContact),
    event_number: str(b.eventNumber),
    status: str(b.status),
    booking_date: str(b.bookingDate),
    course_date: str(b.courseDate),
    quantity: num(b.quantity),
    registered: str(b.registerDate),
    last_modified: str(b.lastModificationDate),
    ...(includeContact ? { email: str(b.emailAddress) } : {}),
  };
}

// FamilyMemberDtoV2_2: linked family members, often children. The reference is free text and always redacted.
export function familyMember(f: Rec, includeContact: boolean) {
  return {
    id: str(f.id),
    member_id: str(f.memberId),
    reference: redactContacts(f.reference, false),
    first_name: redactContacts(f.firstName, includeContact),
    last_name: redactContacts(f.lastName, includeContact),
    ...(includeContact ? { email: str(f.emailAddress), date_of_birth: str(f.dob) } : {}),
  };
}

export function memberDetail(m: Rec, includeContact: boolean) {
  return {
    ...memberSummary(m, includeContact),
    memberships: arr(m.memberships).map(memberLicense),
    organisations: arr(m.organisations).map(memberOrganisation),
    credentials: arr(m.credentials).map(credential),
    bookings: arr(m.bookings).map((b) => booking(b, includeContact)),
    linked_family_members: arr(m.linkedFamilyMember).map((f) => familyMember(f, includeContact)),
    not_returned: withheld(m),
  };
}

// ---- Memberships (MemberMembershipListDtoV2_2, MemberSingleMembershipDtoV2_2) ----

export function membership(r: Rec) {
  return {
    id: str(r.id),
    definition_id: str(r.definitionId),
    name: redactContacts(r.name, false),
    category: str(r.category),
    classification: str(r.classification),
    type: str(r.type),
    status: str(r.status),
    start_date: str(r.startDate),
    end_date: str(r.endDate),
    membership_number: str(r.membershipNumber),
    member_id: str(r.memberId),
    owner_id: str(r.ownerId),
    owner_type: str(r.ownerType),
    last_modified: str(r.lastModificationDate),
  };
}

// ---- Credentials (MemberCredentialDtoV2_2): qualifications and licences ----

export function credential(c: Rec) {
  return {
    id: str(c.id),
    definition_id: str(c.definitionId),
    name: redactContacts(c.name, false),
    type: str(c.type),
    status: str(c.status),
    reference_number: str(c.referenceNumber),
    start_date: str(c.startDate),
    end_date: str(c.endDate),
    member_id: str(c.memberId),
    last_modified: str(c.lastModificationDate),
  };
}

// ---- Events (EventResponseDtoListV2_2, EventDtoSingleV2_2) ----

// EventFixtureAttributeDtoV2_2 / EventFixtureDtoV2_2.
export function stage(s: Rec, includeContact: boolean) {
  return {
    id: str(s.id),
    fixture_id: str(s.fixtureId),
    name: redactContacts(s.fixtureName, includeContact),
    category: str(s.fixtureCategory),
    type: str(s.fixtureType),
    date: str(s.fixtureDate),
    time: str(s.fixtureTime),
    venue: redactContacts(s.venue, includeContact),
    description: redactContacts(s.description, includeContact),
  };
}

// The event's venue is returned by default (it is where the event takes place, not a person's home
// address); contact details typed into any of its free-text fields are redacted like any other text.
export function eventSummary(e: Rec, includeContact: boolean) {
  const t = (v: unknown) => redactContacts(v, includeContact);
  return {
    id: str(e.id),
    name: t(e.eventName),
    event_number: str(e.eventNumber),
    category: str(e.eventCategory),
    sub_category: str(e.subCategory),
    status: str(e.status),
    privacy: str(e.eventPrivacy),
    start_date: str(e.startDate),
    start_time: str(e.startTime),
    end_date: str(e.endDate),
    end_time: str(e.endTime),
    booking_deadline: str(e.bookingDeadline),
    booking_deadline_time: str(e.bookingDeadlineTime),
    location: t(e.eventLocation),
    location_type: str(e.locationType),
    venue_address: { line1: t(e.address1), line2: t(e.address2), town: t(e.town), county: t(e.county), postcode: t(e.postcode), country: t(e.country) },
    organisation_id: str(e.organizationId),
    organisation_name: t(e.organizationName ?? e.organisationName),
    owner: t(e.eventOwner),
    course_provider: t(e.courseProvider),
    detail: t(e.eventDetail),
    direct_link: str(e.directLink),
    last_modified: str(e.lastModificationDate),
    stages: arr(e.stages).map((s) => stage(s, includeContact)),
  };
}

// EventTicketDtoV2_2.
export function ticket(t: Rec) {
  return { id: str(t.id), name: redactContacts(t.ticketName, false), code: str(t.ticketCode), price: num(t.price), total_booked: num(t.totalBooked), remaining_places: num(t.remainingPlaces), end_date: str(t.endDate) };
}

// EventPromoterAttributeDtoV2_2: the people who run the event. The role is free text and always redacted.
export function promoter(p: Rec, includeContact: boolean) {
  return {
    id: str(p.id),
    promoter_id: num(p.promoterId),
    member_number: str(p.memberNumber),
    first_name: redactContacts(p.firstName, includeContact),
    last_name: redactContacts(p.lastName, includeContact),
    role: redactContacts(p.role, false),
    is_published: bool(p.isPublished),
    ...(includeContact ? { email: str(p.emailAddress), phone: str(p.phoneNumber) } : {}),
  };
}

export function eventDetail(e: Rec, includeContact: boolean) {
  return {
    ...eventSummary(e, includeContact),
    total_count: num(e.totalCount),
    tickets: arr(e.tickets).map(ticket),
    promoters: arr(e.promoters).map((p) => promoter(p, includeContact)),
    not_returned: withheld(e),
  };
}

// ---- Organisations (ClubDtoV2_2, ClubSingleDtoV2_2) ----

// A club's email, phone number, street address, postcode and map position are often a volunteer's own,
// so they are treated as contact details: only on request. Town, region and country are returned.
export function organisationSummary(o: Rec, includeContact: boolean) {
  return {
    id: str(o.id),
    organisation_number: str(o.organisationNumber),
    name: redactContacts(o.organisationName, includeContact),
    type: str(o.organisationType),
    status: str(o.organisationStatus),
    town: str(o.organisationTown),
    region: str(o.region),
    country: str(o.organisationCountry),
    website: str(o.website),
    join_url: str(o.joinUrl),
    registered: str(o.registerDate),
    last_modified: str(o.lastModificationDate),
    ...(includeContact
      ? {
          email: str(o.emailAddress),
          phone: str(o.phoneNumber),
          address: { line1: str(o.addressLine1), line2: str(o.addressLine2), line3: str(o.addressLine3), postcode: str(o.organisationPostCode) },
          latlng: str(o.latlng),
        }
      : {}),
  };
}

// ClubCredentialAttributeDtoV2_2 (awards) and ClubMembershipAttributeDtoV2_2.
export function clubAward(a: Rec) {
  return { id: str(a.id), definition_id: str(a.definitionId), reference: str(a.reference), name: redactContacts(a.name, false), type: str(a.type), status: str(a.status), granted: str(a.grantedDate), expires: str(a.expiryDate) };
}
export function clubMembership(m: Rec) {
  return { id: str(m.id), reference: str(m.reference), name: redactContacts(m.name, false), type: str(m.type), status: str(m.status), start_date: str(m.startDate), end_date: str(m.endDate) };
}

export function organisationDetail(o: Rec, includeContact: boolean) {
  return {
    ...organisationSummary(o, includeContact),
    awards: arr(o.awards).map(clubAward),
    memberships: arr(o.memberships).map(clubMembership),
    not_returned: withheld(o),
  };
}
