// End-to-end test: fixtures are validated against JustGo's published OpenAPI 2.2 schemas, then the
// built MCP server is driven over stdio by a real MCP client against a local mock of the API.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, makeJwt, SECRET, PREFIX, NULL_MEMBER } from "./mock-server.mjs";
import { redactContacts } from "../dist/format.js";
import { expiryOf, findJwt, isJwt } from "../dist/client.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://api.justgo.com/swagger/v2.2/swagger.json";
if (!existsSync(`${root}spec.json`)) {
  try {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(`${root}spec.json`, await res.text());
  } catch (err) {
    console.error(`Could not download the JustGo spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.json ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
// OpenAPI 3.0 lets a schema say `nullable: true` without a type (the spec's untyped `additionalDetails`
// and `optin` members): that means "any value, or null". Ajv refuses `nullable` without `type`, so those
// markers are dropped, which leaves the schema as "any value". Every typed schema is used unchanged.
const components = structuredClone(spec.components);
let untyped = 0;
const loosen = (o) => {
  if (Array.isArray(o)) return o.forEach(loosen);
  if (o && typeof o === "object") {
    if (o.nullable === true && o.type === undefined) {
      delete o.nullable;
      untyped++;
    }
    Object.values(o).forEach(loosen);
  }
};
loosen(components);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "jg", components });
const validator = (name) => ajv.getSchema(`jg#/components/schemas/${name}`) ?? ajv.compile({ $ref: `jg#/components/schemas/${name}` });
const validate = (name, obj, label = "") => {
  const v = validator(name);
  assert.ok(v(obj), `${name} ${label}: ${ajv.errorsText(v.errors)}`);
};
const schemaOf = (method, path, status = "200") => spec.paths[path][method].responses[status].content["application/json"].schema.$ref.split("/").pop();

console.log("fixtures vs OpenAPI spec");
await check("members, member details, memberships, credentials, events, event details, bookings, organisations validate (additionalProperties: false)", async () => {
  assert.ok(untyped > 0 && untyped < 20, `expected a handful of untyped nullable members, found ${untyped}`);
  fx.members.forEach((m) => validate("MemberListV2_2Dto", m, m.id));
  Object.values(fx.memberDetails).forEach((m) => validate("MemberV2_2Dto", m, m.id));
  fx.memberships.forEach((m) => validate("MemberMembershipListDtoV2_2", m, m.id));
  fx.memberships.forEach((m) => validate("MemberSingleMembershipDtoV2_2", m, m.id));
  fx.credentials.forEach((c) => validate("MemberCredentialDtoV2_2", c, c.id));
  fx.events.forEach((e) => validate("EventResponseDtoListV2_2", e, e.id));
  Object.values(fx.eventDetails).forEach((e) => validate("EventDtoSingleV2_2", e, e.id));
  fx.candidates.forEach((c) => validate("EventCandidateDtoV2_2", c, c.id));
  fx.organisations.forEach((o) => validate("ClubDtoV2_2", o, o.id));
  Object.values(fx.organisationDetails).forEach((o) => validate("ClubSingleDtoV2_2", o, o.id));
  // Negative controls: the schemas still reject an undeclared key and a wrong format.
  assert.equal(validator("MemberListV2_2Dto")({ ...fx.members[0], medicalNotes: "x" }), false, "undeclared key must fail");
  assert.equal(validator("MemberListV2_2Dto")({ ...fx.members[0], id: "not-a-uuid" }), false, "bad uuid must fail");
});

console.log("redaction and token helpers (built dist/format.js and dist/client.js)");
await check("the phone and email heuristic redacts UK, international and North American forms and leaves IDs, dates and references alone", async () => {
  const redacted = [
    ["+1 (555) 123-4567", "[phone redacted]"],
    ["call (555) 123-4567 today", "call [phone redacted] today"],
    ["+61 (02) 9876 5432", "[phone redacted]"],
    ["+44 (0)7700 900123", "[phone redacted]"],
    ["+447700900321", "[phone redacted]"],
    ["0044 20 7946 0958", "[phone redacted]"],
    ["(020) 7946 0958", "[phone redacted]"],
    ["(0117) 496 0000", "[phone redacted]"],
    ["07700 900789", "[phone redacted]"],
    ["07700.900123", "[phone redacted]"],
    ["Head Coach (call 020 7946 0958)", "Head Coach (call [phone redacted])"],
    ["mail jo.b+club@example.co.uk now", "mail [email redacted] now"],
  ];
  for (const [input, output] of redacted) assert.equal(redactContacts(input, false), output, input);
  const untouched = ["a0000000-0000-4000-8000-000000000001", "2026-08-01T09:00:00Z", "CR-0003", "JG000001", "EV-1001", "Heat 3 (100m) at 10:00", "Price £12.50, 118 places", "Level 2 Swimming Coach"];
  for (const input of untouched) assert.equal(redactContacts(input, false), input, input);
  assert.equal(redactContacts("+1 (555) 123-4567", true), "+1 (555) 123-4567", "raw text on request");
});

await check("a token is only taken for a JWT when its header decodes with an alg; the JWT is refreshed a minute before exp, or halfway when under two minutes", async () => {
  const jwt = makeJwt(1);
  for (const dotted of ["api.justgo.com", "2.2.0", "JustGo.Api.Auth", "a.b.c"]) assert.equal(isJwt(dotted), false, dotted);
  assert.equal(isJwt(jwt), true);
  assert.equal(findJwt({ statusCode: 200, message: "Success", object: "api.justgo.com", data: { issuer: "JustGo.Api.Auth", token: jwt } }, ""), jwt);
  assert.equal(findJwt({ version: "2.2.0", accessToken: `Bearer ${jwt}` }, ""), jwt);
  const other = makeJwt(2);
  assert.equal(findJwt({ object: other, data: { token: jwt } }, ""), jwt, "data is searched before the top level");
  assert.equal(findJwt({ data: { refresh: other, token: jwt } }, ""), jwt, "a member named like a token comes first");
  assert.equal(findJwt({ object: "api.justgo.com" }, ""), undefined);
  assert.equal(findJwt(undefined, "api.justgo.com"), undefined);
  const now = Date.now();
  const s = Math.floor(now / 1000);
  const at130 = expiryOf(makeJwt(1, s + 130)) - now;
  assert.ok(at130 > 68_500 && at130 <= 70_500, `exp in 130 s: refresh after about 70 s (got ${at130} ms)`);
  const at60 = expiryOf(makeJwt(1, s + 60)) - now;
  assert.ok(at60 > 29_000 && at60 <= 30_500, `exp in 60 s: refresh after about 30 s (got ${at60} ms)`);
  assert.ok(expiryOf(makeJwt(1, s - 10)) <= Date.now(), "an expired JWT is replaced at once");
  assert.equal(expiryOf(makeJwt(1)), Infinity, "without exp: kept until a 401");
});

// 2. The mock's responses (auth, lists, single records, errors, the PUT) match the documented schemas.
const mockApi = await startMock();
const { server: mock, port, requests, arm, arm429, disarm } = mockApi;
const base = `http://127.0.0.1:${port}`;
const raw = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
};
await check("mock responses match the documented list, detail, update and error schemas", async () => {
  const authBody = { secret: SECRET };
  validate("ELearningLoginDto", authBody, "POST /Auth body");
  const auth = await raw("POST", `${PREFIX}/Auth`, { body: authBody });
  assert.equal(auth.status, 200);
  const token = auth.text;
  assert.match(token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  const listChecks = [
    ["/Members/FindByAttributes?PageSize=50", "/api/v2.2/Members/FindByAttributes"],
    ["/Memberships/Member/FindByAttributes", "/api/v2.2/Memberships/Member/FindByAttributes"],
    ["/Credentials/Member/FindByAttributes", "/api/v2.2/Credentials/Member/FindByAttributes"],
    ["/Events/FindByAttributes", "/api/v2.2/Events/FindByAttributes"],
    ["/Events/Candidate/FindByAttributes", "/api/v2.2/Events/Candidate/FindByAttributes"],
    [`/Members/${fx.JO}`, "/api/v2.2/Members/{memberId}"],
    [`/Memberships/Member/${fx.JO_MEMBERSHIP}`, "/api/v2.2/Memberships/Member/{membershipId}"],
    [`/Events/${fx.GALA}`, "/api/v2.2/Events/{eventId}"],
    [`/Organisations/${fx.RIVERSIDE}`, "/api/v2.2/Organisations/{organisationId}"],
  ];
  for (const [path, template] of listChecks) {
    const r = await raw("GET", PREFIX + path, { token });
    assert.equal(r.status, 200, path);
    validate(schemaOf("get", template), r.json, path);
  }
  // The first organisations list call gets the armed 429, then the real list.
  const limited = await raw("GET", `${PREFIX}/Organisations/FindByAttributes`, { token });
  assert.equal(limited.status, 429);
  validate("Http401UnAuthorizedResponse", limited.json, "429 body (no 429 is documented; the mock reuses the documented error shape)");
  validate(schemaOf("get", "/api/v2.2/Organisations/FindByAttributes"), (await raw("GET", `${PREFIX}/Organisations/FindByAttributes`, { token })).json);
  const put = await raw("PUT", `${PREFIX}/Memberships/Member/${fx.SAM_MEMBERSHIP}`, { token, body: { startDate: "2026-01-01T00:00:00Z", endDate: "2026-12-31T23:59:59Z" } });
  assert.equal(put.status, 201);
  validate(schemaOf("put", "/api/v2.2/Memberships/Member/{membershipId}", "201"), put.json);
  const bad = await raw("GET", `${PREFIX}/Members/not-a-uuid`, { token });
  assert.equal(bad.status, 400);
  validate(schemaOf("get", "/api/v2.2/Members/{memberId}", "400"), bad.json);
  const missing = await raw("GET", `${PREFIX}/Members/${fx.uid("a", 888)}`, { token });
  assert.equal(missing.status, 404);
  validate("Http404NotFoundResponse", missing.json, "404 (the only documented 404 schema, from GET /Events/{eventId}/Promoters)");
  const unauth = await raw("GET", `${PREFIX}/Members/${fx.JO}`, { token: "wrong" });
  assert.equal(unauth.status, 401);
  validate("Http401UnAuthorizedResponse", unauth.json);
  const badSecret = await raw("POST", `${PREFIX}/Auth`, { body: { secret: "jg-wrong-secret" } });
  assert.equal(badSecret.status, 401);
  validate("Http401UnAuthorizedResponse", badSecret.json);
  const emptySecret = await raw("POST", `${PREFIX}/Auth`, { body: { secret: "" } });
  assert.equal(emptySecret.status, 400, "an empty secret gets 400, as observed on the live API during research");
  validate("Http400BadRequestResponse", emptySecret.json);
  // The one deliberately off-spec answer: 200 with data null (the spec does not allow a null `data`).
  const nullData = await raw("GET", `${PREFIX}/Members/${NULL_MEMBER}`, { token });
  assert.equal(nullData.status, 200);
  assert.equal(validator(schemaOf("get", "/api/v2.2/Members/{memberId}"))(nullData.json), false, "a null data member is not in the documented schema");
});
requests.length = 0; // only count what the MCP server does from here on
arm429();

// 3. Drive the server through MCP. `writes` is the literal JUSTGO_ALLOW_WRITES value; null leaves it unset.
const connect = async (secret, writes = "true") => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, JUSTGO_SECRET: secret, JUSTGO_BASE_URL: base };
  delete env.JUSTGO_ALLOW_WRITES;
  if (writes !== null) env.JUSTGO_ALLOW_WRITES = writes;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const apiCalls = (n) => since(n).filter((r) => r.path !== `${PREFIX}/Auth`);
const authCalls = (n) => since(n).filter((r) => r.path === `${PREFIX}/Auth`);

const READ_TOOLS = ["find_members", "get_event", "get_member", "get_organisation", "list_event_bookings", "list_events", "list_member_credentials", "list_member_memberships", "list_organisations"];
const client = await connect(SECRET);
console.log("mcp tools");

await check("tools/list exposes 9 read-only tools and, with writes on, update_membership_dates marked destructive and idempotent", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, "update_membership_dates"].sort());
  for (const t of tools) {
    if (t.name === "update_membership_dates") {
      assert.deepEqual([t.annotations?.readOnlyHint, t.annotations?.destructiveHint, t.annotations?.idempotentHint], [false, true, true]);
    } else assert.equal(t.annotations?.readOnlyHint, true, `${t.name} readOnlyHint`);
  }
});

await check("the first call fetches a JWT from POST /Auth with the documented body, and it is reused for later calls", async () => {
  const n = requests.length;
  const { data } = await call(client, "find_members", { last_name: "Bloggs" });
  assert.deepEqual(data.members.map((m) => m.id), [fx.JO]);
  await call(client, "get_member", { member_id: fx.JO });
  const auths = authCalls(n);
  assert.equal(auths.length, 1, "one token request for two tool calls");
  assert.deepEqual(auths[0].body, { secret: SECRET });
  assert.match(auths[0].contentType, /^application\/json/);
  assert.equal(auths[0].auth, undefined, "no Authorization header on the token request");
  const tokens = new Set(apiCalls(n).map((r) => r.auth));
  assert.equal(tokens.size, 1);
  assert.match([...tokens][0], /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});

await check("find_members pages with PageNumber/PageSize 1, 2, 3, stops at totalPages even when the last page is full, and spaces requests 250 ms apart", async () => {
  const n = requests.length;
  // 120 members in pages of 40: page 3 is full, so only totalPages can stop the loop before a page 4.
  const { data } = await call(client, "find_members", { page_size: 40, max_pages: 10 });
  assert.equal(data.count, 120);
  assert.deepEqual([data.total_records, data.total_pages, data.complete, data.next_page, data.page_size_applied], [120, 3, true, undefined, undefined]);
  const pages = apiCalls(n);
  assert.deepEqual(pages.map((r) => [r.query.PageNumber, r.query.PageSize]), [["1", "40"], ["2", "40"], ["3", "40"]], "no fourth request once totalPages is reached");
  assert.equal(new Set(data.members.map((m) => m.id)).size, 120, "every member exactly once");
  const gaps = pages.slice(1).map((r, i) => r.t - pages[i].t);
  assert.ok(gaps.every((g) => g >= 240), `consecutive requests at least 250 ms apart (gaps ${gaps.join(", ")} ms)`);
  // The same with totalRecords left out, so nothing but totalPages can end the list at page 3.
  try {
    mockApi.setPagingFields({ totalRecords: false });
    const m = requests.length;
    const only = await call(client, "find_members", { page_size: 40, max_pages: 10 });
    assert.deepEqual([only.data.count, only.data.total_pages, only.data.complete], [120, 3, true]);
    assert.deepEqual(apiCalls(m).map((r) => r.query.PageNumber), ["1", "2", "3"], "totalPages alone stops the list");
  } finally {
    mockApi.setPagingFields({});
  }
});

await check("without totalPages: stops once totalRecords are fetched, follows a smaller page size the API applies, and without totalRecords stops at a short page", async () => {
  const pageQueries = (n) => apiCalls(n).map((r) => r.query.PageNumber);
  try {
    mockApi.setPagingFields({ totalPages: false });
    let n = requests.length;
    let { data } = await call(client, "find_members", { page_size: 40, max_pages: 10 });
    assert.deepEqual([data.count, data.complete, data.total_pages, data.total_records], [120, true, undefined, 120]);
    assert.deepEqual(pageQueries(n), ["1", "2", "3"], "stops at totalRecords after a full last page");
    // The API applies a page size of 20 although 50 was asked for, and says so in pageSize.
    mockApi.setPageCap(20);
    n = requests.length;
    ({ data } = await call(client, "find_members", { page_size: 50, max_pages: 5 }));
    assert.deepEqual([data.count, data.complete, data.next_page, data.page_size_applied, data.total_records], [100, false, 6, 20, 120], "a capped first page is not taken for the last one");
    // The same without pageSize in the response: the short first page and totalRecords reveal the cap.
    mockApi.setPagingFields({ totalPages: false, pageSize: false });
    n = requests.length;
    ({ data } = await call(client, "find_members", { page_size: 50, max_pages: 10 }));
    assert.deepEqual([data.count, data.complete, data.page_size_applied], [120, true, 20]);
    assert.deepEqual(pageQueries(n), ["1", "2", "3", "4", "5", "6"]);
    assert.equal(new Set(data.members.map((m) => m.id)).size, 120);
    // Only pageSize (20) reported: the 20-record pages are not taken for short ones, and an empty page ends the list.
    mockApi.setPagingFields({ totalPages: false, totalRecords: false });
    n = requests.length;
    ({ data } = await call(client, "find_members", { page_size: 50, max_pages: 10 }));
    assert.deepEqual([data.count, data.complete, data.page_size_applied], [120, true, 20]);
    assert.deepEqual(pageQueries(n), ["1", "2", "3", "4", "5", "6", "7"]);
    // Neither totalPages, totalRecords nor pageSize: a short page ends the list, a full one does not.
    mockApi.setPageCap(undefined);
    mockApi.setPagingFields({ totalPages: false, totalRecords: false, pageSize: false });
    n = requests.length;
    ({ data } = await call(client, "find_members", { page_size: 50, max_pages: 10 }));
    assert.deepEqual([data.count, data.complete], [120, true]);
    assert.deepEqual(pageQueries(n), ["1", "2", "3"], "stops at the short third page");
    n = requests.length;
    ({ data } = await call(client, "find_members", { page_size: 40, max_pages: 10 }));
    assert.deepEqual([data.count, data.complete], [120, true]);
    assert.deepEqual(pageQueries(n), ["1", "2", "3", "4"], "a full third page needs an empty fourth to end");
  } finally {
    mockApi.setPageCap(undefined);
    mockApi.setPagingFields({});
  }
});

await check("find_members stops at max_pages and says which page to continue from", async () => {
  const first = await call(client, "find_members", { page_size: 20, max_pages: 2 });
  assert.deepEqual([first.data.count, first.data.complete, first.data.next_page], [40, false, 3]);
  assert.match(first.data.note, /page 3 and the same page_size/);
  const next = await call(client, "find_members", { page_size: 20, max_pages: 1, page: 3 });
  assert.equal(next.data.members[0].id, fx.members[40].id);
  assert.deepEqual([requests.at(-1).query.PageNumber, requests.at(-1).query.PageSize], ["3", "20"]);
});

await check("find_members passes every documented filter through under its documented name; a bare date goes out as a date-time", async () => {
  const args = {
    email: "jo.bloggs@example.com",
    member_number: "JG000001",
    login_id: "jbloggs",
    last_name: "Bloggs",
    organisation_id: fx.RIVERSIDE,
    credential_id: fx.uid("c", 1),
    event_id: fx.GALA,
    membership: "Adult Competitive 2026",
    suspend_status: "Active",
    modified_after: "2026-08-01",
    modified_before: "2026-09-01T00:00:00Z",
  };
  await call(client, "find_members", { ...args, max_pages: 1 });
  const { PageNumber, PageSize, ...query } = requests.at(-1).query;
  assert.deepEqual(query, {
    Email: "jo.bloggs@example.com",
    memberNumber: "JG000001",
    LoginId: "jbloggs",
    LastName: "Bloggs",
    OrganisationId: fx.RIVERSIDE,
    CredentialId: fx.uid("c", 1),
    EventId: fx.GALA,
    Membership: "Adult Competitive 2026",
    SuspendStatus: "Active",
    ModifiedAfter: "2026-08-01T00:00:00Z",
    ModifiedBefore: "2026-09-01T00:00:00Z",
  });
  await call(client, "find_members", { modified_after: "2026-08-01T10:30:00.5+01:00", max_pages: 1 });
  assert.equal(requests.at(-1).query.ModifiedAfter, "2026-08-01T10:30:00.5+01:00", "a full date-time is sent as given");
});

await check("find_members returns names and status only by default; contact details, date of birth and parents' details on request", async () => {
  const { data, text } = await call(client, "find_members", { last_name: "Evans" });
  const sam = data.members[0];
  assert.deepEqual([sam.id, sam.member_number, sam.first_name, sam.last_name, sam.status], [fx.SAM, "JG000002", "Sam", "Evans", "Active"]);
  for (const k of ["email", "phone", "date_of_birth", "gender", "address", "username", "last_login", "parent"]) assert.equal(sam[k], undefined, `${k} must not be returned by default`);
  for (const leak of ["@example.com", "2014-06-10", "BS2 0ZZ", "221 Example Road", "Priya", "900321", "Prefer not"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  const lee = await call(client, "find_members", { member_number: "JG000003" });
  assert.equal(lee.data.members[0].last_name, "Chen ([email redacted])", "an email typed into a name is redacted");
  const kim = await call(client, "find_members", { member_number: "JG000005" });
  assert.equal(kim.data.members[0].first_name, "Kim [phone redacted]", "a phone number typed into a first name is redacted");
  assert.ok(!kim.text.includes("900444"));
  const full = await call(client, "find_members", { last_name: "Evans", include_contact_details: true });
  const s = full.data.members[0];
  assert.deepEqual([s.email, s.phone, s.date_of_birth, s.address.postcode, s.parent.first_name, s.parent.email], ["sam.evans.family@example.com", "+44 7700 900321", "2014-06-10", "BS2 0ZZ", "Priya", "priya.evans@example.com"]);
});

await check("get_member returns memberships, organisations, credentials, bookings and family; free-form details and opt-ins are never returned", async () => {
  const { data, text } = await call(client, "get_member", { member_id: fx.SAM });
  const m = data.member;
  assert.deepEqual(m.memberships.map((x) => [x.name, x.status, x.end_date]), [["Junior 2026", "Active", "2026-12-31"]]);
  assert.deepEqual(m.organisations.map((o) => [o.name, o.roles, o.is_primary]), [["Riverside Swimming Club", "Member", true]]);
  assert.deepEqual(m.bookings.map((b) => [b.course_name, b.ticket_code, b.email]), [["Autumn Gala 2026", "SWIM", undefined]]);
  assert.deepEqual(m.linked_family_members, [{ id: fx.uid("6", 1), member_id: "JG000009", reference: "FAM-01", first_name: "Mia ([email redacted])", last_name: "Evans" }], "an email typed into a family member's name is redacted");
  assert.deepEqual(m.not_returned, ["additionalDetails", "optin"]);
  for (const leak of ["Asthma", "inhaler", "900777", "900888", "photoConsent", "2016-09-01", "@example.com"]) assert.ok(!text.includes(leak), `${leak} leaked by default`);
  const full = await call(client, "get_member", { member_id: fx.SAM, include_contact_details: true });
  assert.equal(full.data.member.linked_family_members[0].date_of_birth, "2016-09-01");
  assert.equal(full.data.member.linked_family_members[0].first_name, "Mia (mia.evans@example.com)");
  const kim = await call(client, "get_member", { member_id: fx.KIM });
  assert.deepEqual(kim.data.member.bookings.map((b) => [b.first_name, b.last_name, b.course_name]), [["Kim [phone redacted]", "Patel", "Autumn Gala 2026"]], "a phone number in a booking's name is redacted");
  assert.ok(!kim.text.includes("900444"));
  assert.equal(full.data.member.email, "sam.evans.family@example.com");
  for (const leak of ["Asthma", "inhaler", "900777", "900888", "photoConsent"]) assert.ok(!full.text.includes(leak), `${leak} must never be returned, even on request`);
  const jo = await call(client, "get_member", { member_id: fx.JO });
  assert.deepEqual(jo.data.member.credentials.map((c) => [c.name, c.end_date]), [["Level 2 Swimming Coach", "2027-02-28"], ["Pool Lifeguard", "2026-10-15"]]);
  assert.equal(jo.data.member.not_returned, undefined);
});

await check("list_member_memberships and list_member_credentials pass their documented filters through", async () => {
  const ms = await call(client, "list_member_memberships", { member_id: fx.JO });
  assert.deepEqual(ms.data.memberships.map((x) => [x.id, x.name, x.membership_number]), [[fx.JO_MEMBERSHIP, "Adult Competitive 2026", "M-0001"]]);
  await call(client, "list_member_memberships", { member_id: fx.JO, status: "Active", category: "Competitive", classification: "Individual", owner_type: "Club", owner_id: fx.RIVERSIDE, definition_id: fx.uid("4", 1), modified_after: "2026-08-01", modified_before: "2026-09-01" });
  const { PageNumber: _a, PageSize: _b, ...mq } = requests.at(-1).query;
  assert.deepEqual(mq, { MemberId: fx.JO, Status: "Active", Category: "Competitive", Classification: "Individual", OwnerType: "Club", OwnerId: fx.RIVERSIDE, DefinitionId: fx.uid("4", 1), ModifiedAfter: "2026-08-01T00:00:00Z", ModifiedBefore: "2026-09-01T00:00:00Z" });
  const cr = await call(client, "list_member_credentials", { member_id: fx.ALEX, status: "Expired" });
  assert.deepEqual(cr.data.credentials.map((c) => [c.name, c.status, c.reference_number, c.end_date]), [["Level 1 Official", "Expired", "CR-0003", "2024-04-30"]]);
  await call(client, "list_member_credentials", { member_id: fx.JO, definition_id: fx.uid("4", 21), status: "Active", category: "Coaching", modified_after: "2026-08-01T00:00:00Z", modified_before: "2026-09-01" });
  const { PageNumber: _c, PageSize: _d, ...cq } = requests.at(-1).query;
  assert.deepEqual(cq, { MemberId: fx.JO, DefinitionId: fx.uid("4", 21), Status: "Active", Category: "Coaching", ModifiedAfter: "2026-08-01T00:00:00Z", ModifiedBefore: "2026-09-01T00:00:00Z" });
});

await check("list_events and get_event: filters passed through, contact details in free text and promoters redacted by default", async () => {
  const { data, text } = await call(client, "list_events", { category: "Competition", status: "Published" });
  assert.deepEqual(data.events.map((e) => e.id), [fx.GALA]);
  assert.equal(data.events[0].detail, "Entries close 10 October. Questions: call [phone redacted] or email [email redacted]. Overseas entries: [phone redacted].");
  assert.equal(data.events[0].stages[0].description, "Warm-up from 09:30; queries to [email redacted]");
  assert.equal(data.events[0].venue_address.postcode, "BS1 5AA", "the venue address is returned");
  assert.ok(!text.includes("@example.com") && !text.includes("07700") && !text.includes("555"));
  await call(client, "list_events", { organisation_id: fx.RIVERSIDE, category: "Course", sub_category: "Coaching", status: "Published", event_number: "EV-1002", modified_after: "2026-08-01", modified_before: "2026-09-01" });
  const { PageNumber: _a, PageSize: _b, ...q } = requests.at(-1).query;
  assert.deepEqual(q, { OrganisationId: fx.RIVERSIDE, EventCategory: "Course", EventSubcategory: "Coaching", Status: "Published", EventNumber: "EV-1002", ModifiedAfter: "2026-08-01T00:00:00Z", ModifiedBefore: "2026-09-01T00:00:00Z" });
  const ev = await call(client, "get_event", { event_id: fx.GALA });
  const e = ev.data.event;
  assert.deepEqual(e.tickets, [{ id: fx.uid("1", 1), name: "Swimmer entry", code: "SWIM", price: 12.5, total_booked: 3, remaining_places: 117, end_date: "2026-10-10" }]);
  assert.deepEqual(e.promoters.map((p) => [p.first_name, p.role, p.email, p.phone]), [["Jo", "Organiser (call [phone redacted])", undefined, undefined]]);
  assert.deepEqual(e.not_returned, ["additionalDetails"]);
  for (const leak of ["Dr A Example", "900555", "900654", "welfare@", "@example.com"]) assert.ok(!ev.text.includes(leak), `${leak} leaked`);
  const full = await call(client, "get_event", { event_id: fx.GALA, include_contact_details: true });
  assert.deepEqual([full.data.event.promoters[0].email, full.data.event.promoters[0].phone], ["jo.bloggs@example.com", "07700 900123"]);
  assert.equal(full.data.event.promoters[0].role, "Organiser (call [phone redacted])", "a promoter's role is always redacted, even on request");
  assert.ok(!full.text.includes("Dr A Example") && !full.text.includes("welfare@"), "additionalDetails never returned");
});

await check("list_event_bookings passes its filters through; bookers' emails only on request", async () => {
  const { data, text } = await call(client, "list_event_bookings", { event_id: fx.GALA });
  assert.deepEqual(data.bookings.map((b) => [b.first_name, b.last_name, b.status, b.ticket_code]), [["Jo", "Bloggs", "Confirmed", "SWIM"], ["Sam", "Evans", "Confirmed", "SWIM"], ["Kim [phone redacted]", "Patel", "Confirmed", "SWIM"]], "a phone number in a booker's name is redacted by default");
  assert.ok(!text.includes("@example.com") && !text.includes("900444"));
  await call(client, "list_event_bookings", { event_id: fx.COURSE, booking_status: "Pending", category: "Course", sub_category: "Coaching", modified_after: "2026-08-01", modified_before: "2026-09-01" });
  const { PageNumber: _a, PageSize: _b, ...q } = requests.at(-1).query;
  assert.deepEqual(q, { BookingStatus: "Pending", EventId: fx.COURSE, Category: "Course", SubCategory: "Coaching", ModifiedAfter: "2026-08-01T00:00:00Z", ModifiedBefore: "2026-09-01T00:00:00Z" });
  const full = await call(client, "list_event_bookings", { event_id: fx.COURSE, include_contact_details: true });
  assert.deepEqual(full.data.bookings.map((b) => [b.last_name, b.email]), [["Chen (lee.chen@example.net)", "lee.chen@example.net"]]);
});

await check("list_organisations (after a 429 retry that waits for Retry-After) and get_organisation keep club contact details back by default", async () => {
  const n = requests.length;
  const { data, text } = await call(client, "list_organisations", { type: "Club" });
  const tries = apiCalls(n);
  assert.equal(tries.length, 2, "retried once after the 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual(data.organisations.map((o) => [o.name, o.town, o.email, o.phone, o.address]), [["Riverside Swimming Club", "Bristol", undefined, undefined, undefined], ["Hilltop Juniors", "Bath", undefined, undefined, undefined]]);
  for (const leak of ["secretary.riverside@", "900456", "12 Mill Lane", "BS1 4AA", "51.4545"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  await call(client, "list_organisations", { organisation_number: "CLB-0001", status: "Active", type: "Club", credential_id: fx.uid("c", 1), membership_name: "Club Affiliation 2026", organisation_id: fx.RIVERSIDE, modified_after: "2026-08-01", modified_before: "2026-09-01" });
  const { PageNumber: _a, PageSize: _b, ...q } = requests.at(-1).query;
  assert.deepEqual(q, { OrganisationNumber: "CLB-0001", Status: "Active", Type: "Club", CredentialId: fx.uid("c", 1), MembershipName: "Club Affiliation 2026", OrganisationId: fx.RIVERSIDE, ModifiedAfter: "2026-08-01T00:00:00Z", ModifiedBefore: "2026-09-01T00:00:00Z" });
  const one = await call(client, "get_organisation", { organisation_id: fx.RIVERSIDE });
  assert.deepEqual(one.data.organisation.awards.map((a) => [a.name, a.expires]), [["SwimMark Accreditation", "2027-01-14"]]);
  assert.deepEqual(one.data.organisation.memberships.map((m) => m.name), ["Club Affiliation 2026"]);
  assert.deepEqual(one.data.organisation.not_returned, ["additionalDetails"]);
  assert.ok(!one.text.includes("900999") && !one.text.includes("secretary.riverside@"));
  const full = await call(client, "get_organisation", { organisation_id: fx.RIVERSIDE, include_contact_details: true });
  assert.deepEqual([full.data.organisation.email, full.data.organisation.address.postcode], ["secretary.riverside@example.com", "BS1 4AA"]);
  assert.ok(!full.text.includes("900999"), "additionalDetails never returned");
});

await check("bad IDs, impossible or zone-less dates and unknown arguments are rejected before any API call; unknown IDs give a clear not-found message", async () => {
  const before = requests.length;
  for (const [tool, args, expected] of [
    ["get_member", { member_id: "../Members" }],
    ["get_member", { member_id: "12345" }],
    ["get_event", { event_id: "not a uuid" }],
    ["get_organisation", { organisation_id: "" }],
    ["list_member_credentials", { member_id: "abc" }],
    ["find_members", { modified_after: "2026-02-30" }],
    ["find_members", { modified_after: "2026-09-01T00:00" }, /seconds and a time zone/],
    ["list_events", { modified_before: "2026-09-01T00:00:00" }, /seconds and a time zone/],
    ["find_members", { email: "not-an-email" }],
    // A misspelt or invented filter must not turn into an unfiltered search of (possibly children's) names.
    ["find_members", { first_name: "Jo", max_pages: 1 }, /first_name/],
    ["find_members", { lastName: "Bloggs" }, /lastName/],
    ["list_event_bookings", { eventId: fx.GALA }, /eventId/],
    ["get_member", { member_id: fx.JO, include_contact: true }, /include_contact/],
    ["update_membership_dates", { membership_id: fx.JO_MEMBERSHIP, end_date: "2027-03-31" }],
    ["update_membership_dates", { membership_id: fx.JO_MEMBERSHIP, end_date: "2027-03-31T23:59:59" }, /time zone/],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
    if (expected) assert.match(bad.content[0].text, expected, `${tool} ${JSON.stringify(args)}: ${bad.content[0].text}`);
  }
  assert.equal(requests.length, before, "no request for invalid input");
  const missing = await call(client, "get_member", { member_id: fx.uid("a", 888) });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /Not found: \/api\/v2\.2\/Members\/a0000000-0000-4000-8000-000000000888\. Check the ID\. Member not found\./);
  const nullData = await call(client, "get_member", { member_id: NULL_MEMBER });
  assert.ok(nullData.res.isError, "a 200 without a record is reported as not found, not as an empty member");
  assert.match(nullData.text, /Not found: .*answered without a record; check the ID/);
});

const putSchema = spec.paths["/api/v2.2/Memberships/Member/{membershipId}"].put.requestBody.content["application/json"].schema.$ref.split("/").pop();
await check("update_membership_dates reads the membership, then PUTs a body that validates against MemberLicensePutDto", async () => {
  assert.equal(putSchema, "MemberLicensePutDto");
  const n = requests.length;
  const { data } = await call(client, "update_membership_dates", { membership_id: fx.JO_MEMBERSHIP, end_date: "2027-03-31T23:59:59Z" });
  assert.deepEqual(apiCalls(n).map((r) => `${r.method} ${r.path}`), [`GET ${PREFIX}/Memberships/Member/${fx.JO_MEMBERSHIP}`, `PUT ${PREFIX}/Memberships/Member/${fx.JO_MEMBERSHIP}`]);
  const put = requests.at(-1);
  validate(putSchema, put.body, "PUT body");
  assert.deepEqual(put.body, { startDate: "2026-01-01T00:00:00Z", endDate: "2027-03-31T23:59:59Z" }, "the date not given is sent unchanged");
  assert.match(put.contentType, /^application\/json/);
  assert.deepEqual(data.previous, { start_date: "2026-01-01T00:00:00Z", end_date: "2026-12-31T23:59:59Z" });
  assert.deepEqual(data.new, { start_date: "2026-01-01T00:00:00Z", end_date: "2027-03-31T23:59:59Z" });
  assert.equal(data.message, "Membership updated.");
  const after = await call(client, "list_member_memberships", { member_id: fx.JO });
  assert.equal(after.data.memberships[0].end_date, "2027-03-31T23:59:59Z");
});

await check("update_membership_dates refuses locally when the end is before the start or a stored date is missing", async () => {
  const n = requests.length;
  const backwards = await call(client, "update_membership_dates", { membership_id: fx.SAM_MEMBERSHIP, end_date: "2025-06-30T00:00:00Z" });
  assert.ok(backwards.res.isError);
  assert.match(backwards.text, /Not changed: the end date 2025-06-30T00:00:00Z is before the start date 2026-01-01T00:00:00Z/);
  const noDates = await call(client, "update_membership_dates", { membership_id: fx.NO_DATES_MEMBERSHIP, end_date: "2027-01-01T00:00:00Z" });
  assert.match(noDates.text, /no stored start date, so both start_date and end_date must be given/);
  const nothing = await call(client, "update_membership_dates", { membership_id: fx.SAM_MEMBERSHIP });
  assert.match(nothing.text, /give start_date, end_date or both/);
  assert.ok(since(n).every((r) => r.method !== "PUT"), "no PUT for a refused change");
});

await check("a 429 on the PUT is retried once; a 502 on the PUT is never retried and the error says to check first", async () => {
  arm({ method: "PUT", path: `${PREFIX}/Memberships/Member/${fx.SAM_MEMBERSHIP}`, status: 429, headers: { "Retry-After": "0" }, body: { statusCode: 429, message: "Too many requests." } });
  const m = requests.length;
  const limited = await call(client, "update_membership_dates", { membership_id: fx.SAM_MEMBERSHIP, end_date: "2027-01-31T23:59:59Z" });
  assert.ok(!limited.res.isError, limited.text);
  assert.equal(since(m).filter((r) => r.method === "PUT").length, 2, "one retry after the 429");
  disarm();
  arm({ method: "PUT", path: `${PREFIX}/Memberships/Member/${fx.SAM_MEMBERSHIP}`, status: 502, headers: { "Retry-After": "0" } });
  const n = requests.length;
  const { res, text } = await call(client, "update_membership_dates", { membership_id: fx.SAM_MEMBERSHIP, start_date: "2026-02-01T00:00:00Z" });
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.method === "PUT").length, 1);
  assert.match(text, /returned 502 for PUT .*not retried because it may already have been processed/);
  assert.ok(!text.includes("<html>") && !text.includes("ops@example.com"), "gateway HTML is not passed on");
  disarm();
});

await check("a 400 is passed on with JustGo's message and errors, contact details redacted; a 403 says the secret lacks permission", async () => {
  arm({ method: "GET", path: `${PREFIX}/Events/FindByAttributes`, status: 400, body: { statusCode: 400, message: "Invalid filter.", errors: { Status: "Unknown status; contact support@example.com or 0117 496 0001." } } });
  const bad = await call(client, "list_events", { status: "Nope" });
  assert.match(bad.text, /JustGo refused GET \/api\/v2\.2\/Events\/FindByAttributes \(400\)\. Invalid filter\. Status: Unknown status; contact \[email redacted\] or \[phone redacted\]\./);
  arm({ method: "GET", path: `${PREFIX}/Events/FindByAttributes`, status: 400, body: { statusCode: 400, message: `Secret ${SECRET} is not valid for this filter.` } });
  const echoed = await call(client, "list_events", { status: "Nope" });
  assert.match(echoed.text, /\(400\)\. Secret \[redacted\] is not valid for this filter\./, "the configured secret is scrubbed from passed-on messages");
  arm({ method: "GET", path: `${PREFIX}/Events/FindByAttributes`, status: 403, body: { statusCode: 403, message: "Forbidden" } });
  const forbidden = await call(client, "list_events");
  assert.match(forbidden.text, /\(403 Forbidden\): the account behind JUSTGO_SECRET is not allowed to use this endpoint/);
  disarm();
});

await check("an expired or revoked token is replaced once on 401; a token that keeps being refused gives an actionable message", async () => {
  mockApi.revokeTokens();
  const n = requests.length;
  const { res } = await call(client, "get_event", { event_id: fx.COURSE });
  assert.ok(!res.isError, res.content[0].text);
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), [`GET ${PREFIX}/Events/${fx.COURSE}`, `POST ${PREFIX}/Auth`, `GET ${PREFIX}/Events/${fx.COURSE}`]);
  mockApi.setRejectAllTokens(true);
  const m = requests.length;
  const refused = await call(client, "get_event", { event_id: fx.COURSE });
  assert.ok(refused.res.isError);
  assert.equal(authCalls(m).length, 1, "exactly one fresh token, no loop");
  assert.match(refused.text, /rejected the access token \(401\) .* even after fetching a fresh one with JUSTGO_SECRET/);
  assert.ok(!refused.text.includes(SECRET));
  mockApi.setRejectAllTokens(false);
});

await check("a persistent 429 gives up after 3 attempts; a Retry-After above the 10 s cap gives up at once", async () => {
  arm429({ persistent: true });
  let n = requests.length;
  const r1 = await call(client, "list_organisations");
  assert.equal(apiCalls(n).length, 3);
  assert.match(r1.text, /JustGo rate limit reached \(the limit is not documented\)\. Wait a minute and try again\./);
  arm429({ retryAfter: "600" });
  n = requests.length;
  const r2 = await call(client, "list_organisations");
  assert.equal(apiCalls(n).length, 1);
  assert.match(r2.text, /asked to wait 600 seconds before retrying GET \/api\/v2\.2\/Organisations\/FindByAttributes \(HTTP 429\)/);
  disarm();
});

await check("Retry-After as an HTTP-date and as fractional seconds is honoured", async () => {
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  let n = requests.length;
  assert.ok(!(await call(client, "list_organisations")).res.isError);
  let tries = apiCalls(n);
  assert.equal(tries.length, 2);
  let gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `waited ${gap} ms for an HTTP-date 4-5 s ahead`);
  arm429({ retryAfter: "1.5" });
  n = requests.length;
  assert.ok(!(await call(client, "list_organisations")).res.isError);
  tries = apiCalls(n);
  gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("502 on a GET is retried; 503 three times gives advice without the gateway HTML; a non-JSON 200 is an error", async () => {
  arm({ method: "GET", path: `${PREFIX}/Events/${fx.GALA}`, status: 502, headers: { "Retry-After": "0" } });
  let n = requests.length;
  assert.ok(!(await call(client, "get_event", { event_id: fx.GALA })).res.isError);
  assert.equal(apiCalls(n).length, 2);
  arm({ method: "GET", path: `${PREFIX}/Events/${fx.GALA}`, status: 503, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const down = await call(client, "get_event", { event_id: fx.GALA });
  assert.equal(apiCalls(n).length, 3);
  assert.match(down.text, /JustGo returned 503 for GET \/api\/v2\.2\/Events\/.* 3 times in a row\. The service may be unavailable/);
  assert.ok(!down.text.includes("<html>") && !down.text.includes("ops@example.com"));
  arm({ method: "GET", path: `${PREFIX}/Members/FindByAttributes`, status: 200 });
  const html = await call(client, "find_members");
  assert.ok(html.res.isError);
  assert.match(html.text, /returned 200 for GET \/api\/v2\.2\/Members\/FindByAttributes but the body was not a JSON object \(\d+ characters\)\. Check JUSTGO_BASE_URL/);
  assert.ok(!html.text.includes("ops@example.com"));
  disarm();
});

await client.close();

await check("writes are off when JUSTGO_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect(SECRET, value);
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), READ_TOOLS, `JUSTGO_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    await ro.close();
  }
});

await check("the JWT is found whether /Auth answers with text, a JSON string or a JSON object (also next to dotted non-JWT strings); a response without one is an error that echoes nothing", async () => {
  // "object-dotted" also carries dotted strings shaped like a JWT ("api.justgo.com", "JustGo.Api.Auth");
  // only the real JWT may be sent as the Bearer token.
  for (const mode of ["json-string", "object", "object-dotted"]) {
    mockApi.setAuthMode(mode);
    const c = await connect(SECRET, null);
    const n = requests.length;
    const { res } = await call(c, "get_organisation", { organisation_id: fx.HILLTOP });
    assert.ok(!res.isError, `${mode}: ${res.content[0].text}`);
    const sent = apiCalls(n).map((r) => r.auth);
    assert.ok(sent.length === 1 && mockApi.wasIssued(sent[0].slice("Bearer ".length)), `${mode}: the issued JWT is sent (${sent.join(", ")})`);
    await c.close();
  }
  mockApi.setAuthMode("no-jwt");
  const c = await connect(SECRET, null);
  const { res, text } = await call(c, "get_organisation", { organisation_id: fx.HILLTOP });
  assert.ok(res.isError);
  assert.match(text, /answered .*\/api\/v2\.2\/Auth with 200 but no JWT was found in the response \(JSON with keys statusCode, message, data\)/);
  await c.close();
  mockApi.setAuthMode("text");
});

await check("a 429 from POST /Auth is retried; parallel first calls share one token request; the current JWT is scrubbed from passed-on errors", async () => {
  arm({ method: "POST", path: `${PREFIX}/Auth`, status: 429, headers: { "Retry-After": "0" }, body: { statusCode: 429, message: "Too many requests." } });
  let c = await connect(SECRET, null);
  let n = requests.length;
  const { res } = await call(c, "get_organisation", { organisation_id: fx.HILLTOP });
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(authCalls(n).length, 2, "one retry after the 429");
  await c.close();
  disarm();
  c = await connect(SECRET, null);
  n = requests.length;
  const both = await Promise.all([call(c, "get_organisation", { organisation_id: fx.HILLTOP }), call(c, "get_event", { event_id: fx.COURSE })]);
  assert.ok(both.every((r) => !r.res.isError));
  assert.equal(authCalls(n).length, 1, "one /Auth for two parallel calls on a new server");
  const current = apiCalls(n).at(-1).auth.slice("Bearer ".length);
  arm({ method: "GET", path: `${PREFIX}/Events/FindByAttributes`, status: 400, body: { statusCode: 400, message: `Token ${current} is not valid for this filter.` } });
  const echoed = await call(c, "list_events");
  assert.match(echoed.text, /\(400\)\. Token \[redacted\] is not valid for this filter\./);
  assert.ok(!echoed.text.includes(current));
  await c.close();
  disarm();
});

await check("a 502 from POST /Auth is retried (asking for a token again changes nothing)", async () => {
  arm({ method: "POST", path: `${PREFIX}/Auth`, status: 502, headers: { "Retry-After": "0" } });
  const c = await connect(SECRET, null);
  const n = requests.length;
  const { res } = await call(c, "get_organisation", { organisation_id: fx.HILLTOP });
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(authCalls(n).length, 2);
  await c.close();
  disarm();
});

await check("the JWT's exp claim decides when a new one is fetched; a JWT without exp is kept until a 401", async () => {
  mockApi.setTokenTtl(1); // exp one second ahead: refreshed after half a second
  let c = await connect(SECRET, null);
  let n = requests.length;
  await call(c, "get_organisation", { organisation_id: fx.HILLTOP });
  await new Promise((r) => setTimeout(r, 1100));
  await call(c, "get_organisation", { organisation_id: fx.HILLTOP });
  assert.equal(authCalls(n).length, 2, "a new JWT once the old one is about to expire");
  await c.close();
  mockApi.setTokenTtl(null);
  c = await connect(SECRET, null);
  n = requests.length;
  for (let i = 0; i < 3; i++) await call(c, "get_organisation", { organisation_id: fx.HILLTOP });
  assert.equal(authCalls(n).length, 1, "a JWT without exp is reused");
  await c.close();
  mockApi.setTokenTtl(3600);
});

await check("a wrong secret gives an actionable message that names JUSTGO_SECRET and does not repeat it", async () => {
  const wrong = "jg-wrong-secret-not-real";
  const bad = await connect(wrong, null);
  const { res, text } = await call(bad, "find_members");
  assert.ok(res.isError);
  assert.match(text, /JustGo rejected JUSTGO_SECRET at .*\/api\/v2\.2\/Auth \(401\)\. Check the value/);
  assert.ok(!text.includes(wrong));
  await bad.close();
});

await check("every request used a documented method, path and query parameter names; every API call carried a JWT issued by /Auth", async () => {
  const ops = Object.entries(spec.paths).flatMap(([p, byMethod]) =>
    Object.entries(byMethod).map(([m, op]) => ({
      m: m.toUpperCase(),
      re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$"),
      query: new Set((op.parameters ?? []).filter((x) => x.in === "query").map((x) => x.name)),
    })),
  );
  assert.ok(requests.length > 80);
  for (const r of requests) {
    const op = ops.find((t) => t.m === r.method && t.re.test(r.path));
    assert.ok(op, `undocumented call ${r.method} ${r.path}`);
    for (const k of Object.keys(r.query)) assert.ok(op.query.has(k), `${r.method} ${r.path}: query parameter ${k} is not documented`);
    if (r.path === `${PREFIX}/Auth`) assert.equal(r.auth, undefined);
    else {
      const bearer = /^Bearer (.+)$/.exec(r.auth ?? "")?.[1];
      assert.ok(bearer && mockApi.wasIssued(bearer), `${r.method} ${r.path} without a JWT issued by /Auth (${r.auth})`);
    }
  }
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{id}")}`));
  assert.deepEqual([...used].sort(), [
    `GET ${PREFIX}/Credentials/Member/FindByAttributes`,
    `GET ${PREFIX}/Events/Candidate/FindByAttributes`,
    `GET ${PREFIX}/Events/FindByAttributes`,
    `GET ${PREFIX}/Events/{id}`,
    `GET ${PREFIX}/Members/FindByAttributes`,
    `GET ${PREFIX}/Members/{id}`,
    `GET ${PREFIX}/Memberships/Member/FindByAttributes`,
    `GET ${PREFIX}/Memberships/Member/{id}`,
    `GET ${PREFIX}/Organisations/FindByAttributes`,
    `GET ${PREFIX}/Organisations/{id}`,
    `POST ${PREFIX}/Auth`,
    `PUT ${PREFIX}/Memberships/Member/{id}`,
  ]);
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock, in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
