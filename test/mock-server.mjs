// Local stand-in for https://api.justgo.com: POST /api/v2.2/Auth (secret in, JWT out) and the v2.2
// endpoints this server uses, serving the fixtures with the documented PageNumber/PageSize paging and
// the documented response envelopes and error shapes.
import http from "node:http";
import * as fx from "./fixtures.mjs";

// Obviously fake, low-entropy values; never anything from JustGo's documentation.
export const SECRET = "jg-test-secret-not-real";
export const PREFIX = "/api/v2.2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A member ID for which the mock answers 200 with `data: null` (what the API answers for an unknown ID
// is not documented; the server must handle both this and a 404).
export const NULL_MEMBER = fx.uid("a", 999);

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
/** A JWT-shaped string built at run time: alg "none", a fake subject, a counter and an optional exp. */
export const makeJwt = (n, expSeconds) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: "jg-test-tenant", n, ...(expSeconds !== undefined ? { exp: expSeconds } : {}) })}.not-a-real-signature`;

// Spec error shapes: Http400BadRequestResponse { statusCode, message, errors }, Http401UnAuthorizedResponse
// { statusCode, message } (documented for 403), Http404NotFoundResponse { statusCode, message }. The
// message texts are this mock's own: the spec has no examples.
const e400 = (message, errors) => ({ statusCode: 400, message, errors });
const e401 = (status, message) => ({ statusCode: status, message });
const e404 = (message) => ({ statusCode: 404, message });

export function startMock() {
  const requests = [];
  const tokens = new Set();
  const everIssued = new Set(); // every JWT handed out, including revoked ones
  let issued = 0;
  // Lifetime in seconds written into the JWT's exp claim; null leaves exp out.
  let tokenTtl = 3600;
  // How /Auth answers a good secret: "text" (the JWT as text/plain), "json-string" (the JWT as a JSON
  // string), "object" ({ statusCode, message, data: { token } }), "object-dotted" (the same envelope with
  // dotted strings that have a JWT's three-segment shape but are not JWTs, at the top level and inside
  // `data` before the token) or "no-jwt" (JSON without a token). The spec documents only "200 Success"
  // with no body schema, so the client must cope with each.
  let authMode = "text";
  // When true every bearer token is refused with 401, as if the account's access had been withdrawn.
  let rejectAllTokens = false;
  // Largest PageSize the mock applies (undefined: no cap), and which paging members it includes. The
  // spec lists pageNumber, pageSize, totalPages and totalRecords but marks none of them required.
  let pageCap;
  let pagingFields = { pageSize: true, totalPages: true, totalRecords: true };
  const updated = new Map(); // membership id -> record after PUT
  // Injected failures: { method, path, status, times, headers, body }. body undefined = HTML gateway page.
  const failure429 = () => ({ method: "GET", path: `${PREFIX}/Organisations/FindByAttributes`, status: 429, times: 1, headers: { "Retry-After": "1" }, body: e401(429, "Too many requests.") });
  let failures = [failure429()];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, contentType: req.headers["content-type"], body, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1><p>contact ops@example.com</p></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }

    if (req.method === "POST" && path === `${PREFIX}/Auth`) {
      if (!body?.secret) return send(400, e400("One or more validation errors occurred.", { secret: "The secret field is required." }));
      if (body.secret !== SECRET) return send(401, e401(401, "Invalid secret."));
      const jwt = makeJwt(++issued, tokenTtl === null ? undefined : Math.floor(Date.now() / 1000) + tokenTtl);
      tokens.add(jwt);
      everIssued.add(jwt);
      if (authMode === "text") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(jwt);
      }
      if (authMode === "json-string") return send(200, jwt);
      if (authMode === "object") return send(200, { statusCode: 200, message: "Success", data: { token: jwt } });
      if (authMode === "object-dotted") return send(200, { statusCode: 200, message: "Success", object: "api.justgo.com", version: "2.2.0", data: { issuer: "JustGo.Api.Auth", token: jwt } });
      return send(200, { statusCode: 200, message: "Success", data: null });
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer || !tokens.has(bearer) || rejectAllTokens) return send(401, e401(401, "Unauthorized"));
    if (!path.startsWith(PREFIX + "/")) return send(404, e404("Route not found."));
    const p = path.slice(PREFIX.length + 1).split("/");
    const q = (k) => url.searchParams.get(k);
    const ci = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

    // PagedResponseDtoV2_2. PageNumber is taken as 1-based; PageSize defaults to 10 here (the spec
    // documents neither a default nor a maximum).
    const paged = (items) => {
      const requested = Number(q("PageSize") || 10);
      const size = pageCap ? Math.min(requested, pageCap) : requested;
      const page = Math.max(1, Number(q("PageNumber") || 1));
      const data = items.slice((page - 1) * size, page * size);
      return {
        object: null,
        statusCode: 200,
        message: "Success",
        pageNumber: page,
        ...(pagingFields.pageSize ? { pageSize: size } : {}),
        ...(pagingFields.totalPages ? { totalPages: Math.ceil(items.length / size) } : {}),
        ...(pagingFields.totalRecords ? { totalRecords: items.length } : {}),
        data,
      };
    };
    const one = (data) => ({ statusCode: 200, message: "Success", object: null, data });
    // ModifiedAfter/ModifiedBefore are typed `format: date-time` (RFC 3339): anything else gets a 400, so
    // the suite enforces the documented format rather than whatever Date.parse accepts.
    const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
    for (const k of ["ModifiedAfter", "ModifiedBefore"]) {
      if (q(k) !== null && !RFC3339.test(q(k))) return send(400, e400("One or more validation errors occurred.", { [k]: `The value '${q(k)}' is not valid.` }));
    }
    const since = (items, field = "lastModificationDate") => items.filter((x) => (!q("ModifiedAfter") || Date.parse(x[field]) > Date.parse(q("ModifiedAfter"))) && (!q("ModifiedBefore") || Date.parse(x[field]) < Date.parse(q("ModifiedBefore"))));
    const badId = (name) => send(400, e400("One or more validation errors occurred.", { [name]: `The value is not a valid ${name}.` }));
    const m = req.method;

    if (m === "GET" && p[0] === "Members" && p[1] === "FindByAttributes") {
      // Filters the mock applies; every other documented filter is accepted and recorded.
      let items = since(fx.members);
      if (q("LastName")) items = items.filter((x) => ci(x.lastName, q("LastName")));
      if (q("Email")) items = items.filter((x) => ci(x.emailAddress, q("Email")));
      if (q("memberNumber")) items = items.filter((x) => x.memberNumber === q("memberNumber"));
      return send(200, paged(items));
    }
    if (m === "GET" && p[0] === "Members" && p.length === 2) {
      if (!UUID.test(p[1])) return badId("memberId");
      if (p[1] === NULL_MEMBER) return send(200, one(null));
      const d = fx.memberDetails[p[1]];
      return d ? send(200, one(d)) : send(404, e404("Member not found."));
    }
    if (m === "GET" && p[0] === "Memberships" && p[1] === "Member" && p[2] === "FindByAttributes") {
      let items = [...fx.memberships.map((x) => updated.get(x.id) ?? x)];
      if (q("MemberId")) items = items.filter((x) => x.memberId === q("MemberId"));
      if (q("Status")) items = items.filter((x) => ci(x.status, q("Status")));
      return send(200, paged(items));
    }
    if (p[0] === "Memberships" && p[1] === "Member" && p.length === 3) {
      if (!UUID.test(p[2])) return badId("membershipId");
      const rec = fx.memberships.find((x) => x.id === p[2]);
      if (!rec) return send(404, e404("Membership not found."));
      if (m === "GET") return send(200, one(updated.get(rec.id) ?? rec));
      if (m === "PUT") {
        const keys = Object.keys(body ?? {});
        if (keys.some((k) => !["startDate", "endDate"].includes(k)) || !body.startDate || !body.endDate) return send(400, e400("One or more validation errors occurred.", { body: "startDate and endDate are required." }));
        updated.set(rec.id, { ...rec, startDate: body.startDate, endDate: body.endDate, lastModificationDate: new Date().toISOString().replace(/\.\d+Z$/, "Z") });
        return send(201, { statusCode: 201, message: "Membership updated." });
      }
    }
    if (m === "GET" && p[0] === "Credentials" && p[1] === "Member" && p[2] === "FindByAttributes") {
      let items = since(fx.credentials);
      if (q("MemberId")) items = items.filter((x) => x.memberId === q("MemberId"));
      if (q("Status")) items = items.filter((x) => ci(x.status, q("Status")));
      return send(200, paged(items));
    }
    if (m === "GET" && p[0] === "Events" && p[1] === "FindByAttributes") {
      let items = since(fx.events);
      if (q("Status")) items = items.filter((x) => ci(x.status, q("Status")));
      if (q("EventCategory")) items = items.filter((x) => ci(x.eventCategory, q("EventCategory")));
      return send(200, paged(items));
    }
    if (m === "GET" && p[0] === "Events" && p[1] === "Candidate" && p[2] === "FindByAttributes") {
      let items = fx.candidatesRaw;
      if (q("EventId")) items = items.filter((x) => x._eventId === q("EventId"));
      if (q("BookingStatus")) items = items.filter((x) => ci(x.status, q("BookingStatus")));
      return send(200, paged(items.map(({ _eventId, ...rest }) => rest)));
    }
    if (m === "GET" && p[0] === "Events" && p.length === 2) {
      if (!UUID.test(p[1])) return badId("eventId");
      const d = fx.eventDetails[p[1]];
      return d ? send(200, one(d)) : send(404, e404("Event not found."));
    }
    if (m === "GET" && p[0] === "Organisations" && p[1] === "FindByAttributes") {
      let items = since(fx.organisations);
      if (q("Type")) items = items.filter((x) => ci(x.organisationType, q("Type")));
      if (q("OrganisationId")) items = items.filter((x) => x.id === q("OrganisationId"));
      return send(200, paged(items));
    }
    if (m === "GET" && p[0] === "Organisations" && p.length === 2) {
      if (!UUID.test(p[1])) return badId("organisationId");
      const d = fx.organisationDetails[p[1]];
      return d ? send(200, one(d)) : send(404, e404("Organisation not found."));
    }
    return send(404, e404("Route not found."));
  });

  const arm = ({ method, path, status, times = 1, headers, body }) => failures.push({ method, path, status, times, headers, body });
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  const control = {
    setTokenTtl: (s) => (tokenTtl = s),
    setAuthMode: (mode) => (authMode = mode),
    revokeTokens: () => tokens.clear(),
    setRejectAllTokens: (v) => (rejectAllTokens = v),
    setPageCap: (n) => (pageCap = n),
    setPagingFields: (fields) => (pagingFields = { pageSize: true, totalPages: true, totalRecords: true, ...fields }),
    wasIssued: (jwt) => everIssued.has(jwt),
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, ...control })));
}
