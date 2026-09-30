// Fake JustGo data shaped exactly like the published OpenAPI 2.2 schemas (validated in e2e.mjs; every
// schema there sets additionalProperties: false, so an undeclared key fails validation).
// IDs are obviously fake, low-entropy UUIDs: a one-letter kind, zeros, and a counter.
export const uid = (kind, n) => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ts = (day, h = 9) => `2026-08-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;

// ---- Organisations (ClubDtoV2_2 for lists, ClubSingleDtoV2_2 for detail) ----
export const RIVERSIDE = uid("f", 1);
export const HILLTOP = uid("f", 2);
const club = (id, number, name, type, email, phone, line1, postcode, town, day) => ({
  id,
  organisationNumber: number,
  organisationName: name,
  emailAddress: email,
  phoneNumber: phone,
  organisationType: type,
  organisationStatus: "Active",
  addressLine1: line1,
  addressLine2: null,
  addressLine3: null,
  organisationCountry: "United Kingdom",
  organisationPostCode: postcode,
  organisationTown: town,
  registerDate: ts(day),
  region: "South West",
  latlng: "51.4545,-2.5879",
  website: "https://riverside.example.org",
  joinUrl: "https://example.justgo.test/join/riverside",
  lastModificationDate: ts(day + 1),
});
export const organisations = [
  club(RIVERSIDE, "CLB-0001", "Riverside Swimming Club", "Club", "secretary.riverside@example.com", "07700 900456", "12 Mill Lane", "BS1 4AA", "Bristol", 1),
  club(HILLTOP, "CLB-0002", "Hilltop Juniors", "Club", "hilltop@example.org", "0117 496 0000", "3 Station Road", "BA1 1AA", "Bath", 2),
  club(uid("f", 3), "REG-0001", "South West Region", "Region", "region@example.org", "+44 20 7946 0958", "1 High Street", "EX1 1AA", "Exeter", 3),
];
export const organisationDetails = {
  [RIVERSIDE]: {
    ...organisations[0],
    awards: [{ id: uid("7", 1), definitionId: uid("4", 11), clubDocId: 501, reference: "SWIM-MARK-01", name: "SwimMark Accreditation", type: "Club Award", grantedDate: "2025-01-15", expiryDate: "2027-01-14", status: "Active" }],
    memberships: [{ id: uid("8", 1), clubDocId: 501, reference: "AFF-2026", name: "Club Affiliation 2026", type: "Affiliation", startDate: "2026-01-01", endDate: "2026-12-31", status: "Active" }],
    additionalDetails: { welfareOfficerHomePhone: "07700 900999" },
  },
  [HILLTOP]: { ...organisations[1], awards: [], memberships: [], additionalDetails: null },
  [organisations[2].id]: { ...organisations[2], awards: null, memberships: null, additionalDetails: null },
};

// ---- Members (MemberListV2_2Dto for lists, MemberV2_2Dto for detail) ----
export const JO = uid("a", 1);
export const SAM = uid("a", 2);
export const LEE = uid("a", 3);
export const ALEX = uid("a", 4);
export const KIM = uid("a", 5);
const member = (id, number, first, last, email, dob, extra = {}) => ({
  id,
  memberNumber: number,
  firstName: first,
  lastName: last,
  emailAddress: email,
  dob,
  gender: "Prefer not to say",
  address1: "221 Example Road",
  address2: null,
  town: "Bristol",
  county: "Avon",
  postCode: "BS2 0ZZ",
  country: "United Kingdom",
  phoneNumber: "07700 900123",
  memberStatus: "Active",
  registerDate: ts(3),
  lastModificationDate: ts(20),
  lastLoginDate: ts(25),
  userName: email,
  parentFirstName: null,
  parentLastName: null,
  parentEmailAddress: null,
  suspensionLevel: null,
  emailVerified: true,
  ...extra,
});
const named = [
  member(JO, "JG000001", "Jo", "Bloggs", "jo.bloggs@example.com", "1985-04-02"),
  // A junior member: the parent's details identify the family and must stay out of default output.
  member(SAM, "JG000002", "Sam", "Evans", "sam.evans.family@example.com", "2014-06-10", { parentFirstName: "Priya", parentLastName: "Evans", parentEmailAddress: "priya.evans@example.com", phoneNumber: "+44 7700 900321", emailVerified: false }),
  // A last name with an email typed into it, to prove names are redacted by default.
  member(LEE, "JG000003", "Lee", "Chen (lee.chen@example.net)", "lee.chen@example.net", "1990-11-30"),
  member(ALEX, "JG000004", "Alex", "Suspended", "alex.s@example.com", "1979-02-14", { memberStatus: "Suspended", suspensionLevel: "Full" }),
  // A first name with a phone number typed into it; Kim also books the gala, so the booking carries it too.
  member(KIM, "JG000005", "Kim 07700 900444", "Patel", "kim.patel@example.com", "2012-03-03"),
];
// 115 more members so the list spans three pages of 50, or exactly three of 40 (total 120).
const bulk = Array.from({ length: 115 }, (_, i) => member(uid("a", 100 + i), `JG${String(100 + i).padStart(6, "0")}`, `Person${i}`, `Surname${i}`, `person${i}@example.org`, "2000-01-01"));
export const members = [...named, ...bulk];

// ---- Memberships (MemberMembershipListDtoV2_2 / MemberSingleMembershipDtoV2_2) ----
export const JO_MEMBERSHIP = uid("b", 1);
export const SAM_MEMBERSHIP = uid("b", 2);
export const NO_DATES_MEMBERSHIP = uid("b", 4);
const membershipRec = (id, memberId, name, category, status, start, end, number) => ({
  id,
  definitionId: uid("4", 1),
  name,
  category,
  classification: "Individual",
  startDate: start,
  endDate: end,
  status,
  type: "Annual",
  ownerId: RIVERSIDE,
  ownerType: "Club",
  memberId,
  lastModificationDate: ts(10),
  membershipNumber: number,
});
export const memberships = [
  membershipRec(JO_MEMBERSHIP, JO, "Adult Competitive 2026", "Competitive", "Active", "2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z", "M-0001"),
  membershipRec(SAM_MEMBERSHIP, SAM, "Junior 2026", "Junior", "Active", "2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z", "M-0002"),
  membershipRec(uid("b", 3), ALEX, "Adult Recreational 2025", "Recreational", "Expired", "2025-01-01T00:00:00Z", "2025-12-31T23:59:59Z", "M-0003"),
  membershipRec(NO_DATES_MEMBERSHIP, LEE, "Pending Application", "Recreational", "Pending", null, null, "M-0004"),
];

// ---- Credentials (MemberCredentialDtoV2_2) ----
const credentialRec = (n, memberId, name, type, status, start, end) => ({
  id: uid("c", n),
  definitionId: uid("4", 20 + n),
  referenceNumber: `CR-${String(n).padStart(4, "0")}`,
  name,
  type,
  startDate: start,
  endDate: end,
  status,
  lastModificationDate: ts(12),
  memberId,
});
export const credentials = [
  credentialRec(1, JO, "Level 2 Swimming Coach", "Coaching", "Active", "2024-03-01", "2027-02-28"),
  credentialRec(2, JO, "Pool Lifeguard", "Qualification", "Active", "2024-10-01", "2026-10-15"),
  credentialRec(3, ALEX, "Level 1 Official", "Officiating", "Expired", "2021-05-01", "2024-04-30"),
];

// ---- Events (EventResponseDtoListV2_2 / EventDtoSingleV2_2) and bookings (EventCandidateDtoV2_2) ----
export const GALA = uid("e", 1);
export const COURSE = uid("e", 2);
const stageAttr = (n, eventDocId, name) => ({ id: uid("3", n), fixtureId: uid("3", 100 + n), eventDocId, fixtureName: name, fixtureCategory: "Heat", fixtureType: "Race", fixtureDate: "2026-10-18T10:00:00Z", fixtureTime: "10:00", venue: "Main pool", description: "Warm-up from 09:30; queries to gala.desk@example.com" });
const eventCommon = (id, name, number, category, sub, status, start, detail) => ({
  id,
  eventName: name,
  eventLocation: "Riverside Leisure Centre",
  locationType: "Venue",
  address1: "Riverside Leisure Centre",
  address2: "Quay Street",
  town: "Bristol",
  county: "Avon",
  postcode: "BS1 5AA",
  startDate: start,
  startTime: "09:00",
  eventDetail: detail,
  eventNumber: number,
  bookingDeadline: "2026-10-10T23:59:00Z",
  eventCategory: category,
  courseProvider: "South West Region",
  country: "United Kingdom",
  subCategory: sub,
  directLink: `https://example.justgo.test/events/${number}`,
  bookingDeadlineTime: "23:59",
  eventOwner: "Riverside Swimming Club",
  status,
  latlng: "51.4500,-2.5900",
  lastModificationDate: ts(15),
  endDate: start,
  endTime: "17:00",
});
export const events = [
  { ...eventCommon(GALA, "Autumn Gala 2026", "EV-1001", "Competition", "Gala", "Published", "2026-10-18T00:00:00Z", "Entries close 10 October. Questions: call 07700 900789 or email entries@example.com. Overseas entries: +1 (555) 222-3333."), organizationId: RIVERSIDE, organizationName: "Riverside Swimming Club", stages: [stageAttr(1, 9001, "50m Freestyle heats")] },
  { ...eventCommon(COURSE, "Level 1 Coach Course", "EV-1002", "Course", "Coaching", "Published", "2026-11-07T00:00:00Z", "Two-day course."), organizationId: RIVERSIDE, organizationName: "Riverside Swimming Club", stages: [] },
  { ...eventCommon(uid("e", 3), "Spring Open 2026", "EV-0990", "Competition", "Open Meet", "Closed", "2026-04-12T00:00:00Z", "Results published."), organizationId: HILLTOP, organizationName: "Hilltop Juniors", stages: null },
];
const stageFull = ({ eventDocId: _drop, ...rest }) => rest; // EventFixtureDtoV2_2 has no eventDocId
export const eventDetails = Object.fromEntries(
  events.map((e) => {
    const { organizationId: _o, organizationName, stages, ...rest } = e;
    return [
      e.id,
      {
        ...rest,
        eventPrivacy: "Public",
        organisationName: organizationName,
        totalCount: e.id === GALA ? 3 : 0,
        additionalDetails: e.id === GALA ? { medicalOfficer: "Dr A Example, 07700 900555", safeguardingLead: "welfare@example.com" } : null,
        tickets: e.id === GALA ? [{ id: uid("1", 1), ticketName: "Swimmer entry", totalBooked: 3, remainingPlaces: 117, price: 12.5, ticketCode: "SWIM", endDate: "2026-10-10" }] : [],
        promoters:
          e.id === GALA
            ? [{ id: uid("2", 1), memberNumber: "JG000001", firstName: "Jo", lastName: "Bloggs", emailAddress: "jo.bloggs@example.com", phoneNumber: "07700 900123", role: "Organiser (call 07700 900654)", isPublished: true, promoterId: 71 }]
            : [],
        stages: Array.isArray(stages) ? stages.map(stageFull) : null,
      },
    ];
  }),
);

const candidate = (n, eventId, member, status, ticketCode, courseName, eventNumber) => ({
  id: uid("d", n),
  ticketId: uid("1", 1),
  candidateId: member.id,
  bookingId: uid("9", n),
  memberNumber: member.memberNumber,
  firstName: member.firstName,
  lastName: member.lastName,
  emailAddress: member.emailAddress,
  ticketCode,
  courseName,
  eventNumber,
  bookingDate: ts(21),
  courseDate: "2026-10-18T00:00:00Z",
  quantity: 1,
  registerDate: ts(21),
  lastModificationDate: ts(22),
  status,
  _eventId: eventId, // mock-only link, stripped before serving
});
export const candidatesRaw = [
  candidate(1, GALA, named[0], "Confirmed", "SWIM", "Autumn Gala 2026", "EV-1001"),
  candidate(2, GALA, named[1], "Confirmed", "SWIM", "Autumn Gala 2026", "EV-1001"),
  candidate(3, COURSE, named[2], "Pending", "L1", "Level 1 Coach Course", "EV-1002"),
  candidate(4, GALA, named[4], "Confirmed", "SWIM", "Autumn Gala 2026", "EV-1001"),
];
export const candidates = candidatesRaw.map(({ _eventId, ...rest }) => rest);

// ---- Member detail records (MemberV2_2Dto) ----
const license = (m) => ({ id: m.id, definitionId: m.definitionId, name: m.name, status: m.status, startDate: m.startDate?.slice(0, 10) ?? null, endDate: m.endDate?.slice(0, 10) ?? null });
const bookingOf = (c) => {
  const { bookingId: _b, status: _s, ...rest } = c; // EventBookingDtoV2_2 has neither
  return rest;
};
export const memberDetails = Object.fromEntries(
  members.map((m) => {
    const detail = {
      ...m,
      memberDocId: 1000 + members.indexOf(m),
      userId: 5000 + members.indexOf(m),
      memberships: memberships.filter((x) => x.memberId === m.id).map(license),
      organisations: [{ id: RIVERSIDE, organisationName: "Riverside Swimming Club", roles: m.id === JO ? "Head Coach, Welfare Officer" : "Member", isPrimary: true, isAdmin: m.id === JO }],
      credentials: credentials.filter((c) => c.memberId === m.id),
      bookings: candidates.filter((c) => c.candidateId === m.id).map(bookingOf),
      optin: m.id === SAM ? { marketingEmails: false, photoConsent: "No photos: contact parent on 07700 900888" } : null,
      linkedFamilyMember: m.id === SAM ? [{ id: uid("6", 1), reference: "FAM-01", memberId: "JG000009", firstName: "Mia (mia.evans@example.com)", lastName: "Evans", emailAddress: "mia.evans@example.com", dob: "2016-09-01" }] : [],
      // Free-form custom-form answers: the kind of data (medical, emergency contact) that must never be returned.
      additionalDetails: m.id === SAM ? { medicalConditions: "Asthma: inhaler in bag", emergencyContact: "Priya Evans 07700 900777" } : null,
    };
    return [m.id, detail];
  }),
);
