// Minimal JustGo API client used by the MCP tools.
// Docs: Swagger UI at https://api.justgo.com/index.html
// Spec: https://api.justgo.com/swagger/v2.2/swagger.json (OpenAPI 3.0.1, "JustGo API" 2.2). The spec has
// no `servers` block; the base URL https://api.justgo.com is inferred from where the spec is served.
import { redactContacts } from "./format.js";

export class JustGoError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "JustGoError";
  }
}

export const API_PREFIX = "/api/v2.2";
const AUTH_PATH = `${API_PREFIX}/Auth`;

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET and for POST /Auth (asking for a token again changes nothing). A PUT is never repeated after
// a gateway error.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;
// The spec types PageSize as a plain int32 and documents no default or maximum. 100 is this server's
// own cap, not a documented limit.
export const MAX_PAGE_SIZE = 100;
// Refresh the cached JWT this long before its `exp` claim, or after half its remaining life when that
// is shorter than two minutes.
const TOKEN_REFRESH_MARGIN_S = 60;
// Shorter values are not scrubbed from passed-on text: they would hit ordinary words.
const MIN_SCRUB_LENGTH = 8;
// Three dot-separated base64url segments (RFC 7519 compact serialisation; the signature may be empty).
// The shape alone is not enough ("api.justgo.com" and "2.2.0" have it too), so isJwt() also requires
// the first segment to decode to a JSON object header with an `alg` member.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
// Member names that usually hold the token, looked at before any other member.
const TOKEN_KEYS = ["token", "accesstoken", "access_token", "jwt", "jwttoken", "bearertoken", "idtoken", "id_token"];

export type QueryValue = string | number | boolean | undefined;

// Spec PagedResponseDtoV2_2 shape (e.g. MemberListV2_2DtoPagedResponseDtoV2_2).
export interface PagedResponse<T> {
  object?: string | null;
  statusCode?: number;
  message?: string | null;
  pageNumber?: number;
  pageSize?: number;
  totalPages?: number;
  totalRecords?: number;
  data?: T[] | null;
}

export class JustGoClient {
  private readonly baseUrl: string;
  // JustGo documents no rate limit. Space requests about four per second so a tool call that pages
  // through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;

  constructor(private readonly secret: string, baseUrl = "https://api.justgo.com") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * The configured secret and the cached JWT are replaced with "[redacted]" in any text passed on to
   * the user, should JustGo ever echo them. Contact-detail redaction is applied separately.
   */
  private scrub(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    let out = text;
    for (const s of [this.secret, this.token?.value]) {
      if (s && s.length >= MIN_SCRUB_LENGTH) out = out.split(s).join("[redacted]");
    }
    return out;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** One HTTP exchange with throttling and the 429 / gateway retry policy; no auth handling. */
  private async send(
    method: string,
    path: string,
    init: { headers: Record<string, string>; body?: string; query?: Record<string, QueryValue> },
  ): Promise<{ status: number; headers: Headers; text: string; json: any }> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const gatewayRetry = method === "GET" || (method === "POST" && path === AUTH_PATH);
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, { method, headers: init.headers, body: init.body });
      } catch (err) {
        throw new JustGoError(`Could not reach JustGo at ${this.baseUrl}: ${(err as Error).message}. Check JUSTGO_BASE_URL and the network.`);
      }
      const retryable = RETRY_ANY_METHOD.has(res.status) || (gatewayRetry && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new JustGoError(`JustGo asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${path} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date
        // already passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const text = res.status === 204 ? "" : await res.text();
      return { status: res.status, headers: res.headers, text, json: text ? safeJson(text) : undefined };
    }
  }

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = this.requestToken().finally(() => {
        this.tokenRequest = undefined;
      });
    }
    return this.tokenRequest;
  }

  /**
   * POST /api/v2.2/Auth with the documented body ELearningLoginDto { secret }. The spec documents the
   * 200 response as "Success" with no schema, and the security scheme as "JWT Authorization header
   * using the Bearer scheme". So the response is searched for a JWT (see findJwt): a body that is
   * itself a JWT (as text or as a JSON string), or a JWT string one level inside a JSON object's
   * `data` member or at its top level. A string only counts when its first segment decodes to a JWT
   * header with an `alg`, so a dotted value such as a host name is never sent as the token. The JWT's `exp`
   * claim, when present, decides how long it is cached; without one it is kept until the API answers
   * 401. The token is never written to a log or an error message.
   */
  private async requestToken(): Promise<string> {
    const { status, json, text } = await this.send("POST", AUTH_PATH, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ secret: this.secret }),
    });
    const found = status >= 200 && status < 300 ? findJwt(json, text) : undefined;
    if (found) {
      this.token = { value: found, expiresAt: expiryOf(found) };
      return found;
    }
    const detail = redactContacts(this.scrub(describeError(json)), false);
    this.token = undefined;
    const where = `${this.baseUrl}${AUTH_PATH}`;
    if (status === 400 || status === 401 || status === 403) {
      throw new JustGoError(`JustGo rejected JUSTGO_SECRET at ${where} (${status}). Check the value: it must be the API secret JustGo issued for your organisation's account.${detail ? " " + detail : ""}`, status);
    }
    if (status >= 200 && status < 300) {
      // Describe the shape of what came back without echoing any value.
      const shape = json && typeof json === "object" ? `JSON with keys ${Object.keys(json).join(", ") || "(none)"}` : `a ${json === undefined ? "non-JSON" : typeof json} body of ${text.length} characters`;
      throw new JustGoError(`JustGo answered ${where} with ${status} but no JWT was found in the response (${shape}). Check JUSTGO_BASE_URL.`, status);
    }
    if (status === 429) throw new JustGoError(`JustGo rate-limited ${where} (429). Wait a minute and try again.${detail ? " " + detail : ""}`, status);
    if (RETRY_GET_ONLY.has(status)) throw new JustGoError(`JustGo returned ${status} for POST ${where} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.`, status);
    throw new JustGoError(`JustGo returned ${status} for POST ${where}. Check JUSTGO_BASE_URL and try again.${detail ? " " + detail : ""}`, status);
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<T> {
    for (let auth = 0; ; auth++) {
      const token = await this.getToken(auth > 0);
      const { status, text, json } = await this.send(method, path, {
        query: opts.query,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      // A cached token may have expired or been revoked: fetch a fresh one and retry once.
      if (status === 401 && auth === 0) continue;

      if (status >= 200 && status < 300) {
        if (status === 204 || text === "") return undefined as T;
        // Every documented 2xx body is a JSON object. A 200 with HTML (a proxy, a login page) must
        // not be mistaken for an empty list or an empty record. Only the content length is quoted.
        if (!json || typeof json !== "object") {
          throw new JustGoError(`JustGo returned ${status} for ${method} ${path} but the body was not a JSON object (${text.length} characters). Check JUSTGO_BASE_URL and whether a proxy or login page is in the way.`, status);
        }
        return json as T;
      }

      // Spec error bodies: Http400BadRequestResponse { statusCode, message, errors }, Http401UnAuthorizedResponse
      // (used for 403) and Http404NotFoundResponse { statusCode, message }, Http500InternalServerErrorResponse
      // { statusCode, message, details }. Only these JSON fields are passed on, redacted; never a raw body.
      const detail = redactContacts(this.scrub(describeError(json)), false)?.slice(0, 400);
      const suffix = detail ? " " + detail : "";
      if (status === 401) {
        throw new JustGoError(`JustGo rejected the access token (401) for ${method} ${path}, even after fetching a fresh one with JUSTGO_SECRET. Check that the secret is still active for your organisation's account.${suffix}`, 401);
      }
      if (status === 403) {
        throw new JustGoError(`JustGo refused ${method} ${path} (403 Forbidden): the account behind JUSTGO_SECRET is not allowed to use this endpoint or this record. Ask JustGo which API permissions the secret has.${suffix}`, 403);
      }
      if (status === 404) throw new JustGoError(`Not found: ${path}. Check the ID.${suffix}`, 404);
      if (status === 400) throw new JustGoError(`JustGo refused ${method} ${path} (400).${suffix}`, 400);
      if (status === 429) throw new JustGoError(`JustGo rate limit reached (the limit is not documented). Wait a minute and try again.${suffix}`, 429);
      if (method !== "GET" && RETRY_GET_ONLY.has(status)) {
        throw new JustGoError(
          `JustGo returned ${status} for ${method} ${path}. The request was not retried because it may already have been processed: check the record with the matching get tool before repeating it.`,
          status,
        );
      }
      if (RETRY_GET_ONLY.has(status)) {
        throw new JustGoError(`JustGo returned ${status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${json && typeof json === "object" ? suffix : ""}`, status);
      }
      throw new JustGoError(`JustGo returned ${status} for ${method} ${path}.${suffix}`, status);
    }
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", API_PREFIX + path, { query });
  }

  /**
   * GET a single record wrapped in the documented `{ statusCode, message, object, data }` envelope and
   * return `data`. A 200 whose `data` is missing or null is reported as not found: the spec documents
   * no 404 for these endpoints, so what the API answers for an unknown ID is not known.
   */
  async getRecord<T = any>(path: string): Promise<T> {
    const res = await this.get<{ data?: T | null; message?: string | null }>(path);
    const data = res?.data;
    if (!data || typeof data !== "object") {
      const msg = redactContacts(this.scrub(typeof res?.message === "string" ? res.message : undefined), false);
      throw new JustGoError(`Not found: ${API_PREFIX}${path}. JustGo answered without a record; check the ID.${msg ? " " + msg : ""}`, 404);
    }
    return data;
  }

  /**
   * Fetch a page-numbered collection (PageNumber/PageSize in, pageNumber/pageSize/totalPages/totalRecords
   * and data out). Starts at `page` and keeps the page size fixed so page numbers stay aligned. Stops
   * after `maxPages`, at an empty page, when totalPages says the last page was reached, or (when the
   * response carries no totalPages) once totalRecords records are accounted for, or, without either,
   * at a page shorter than the page size.
   */
  async list<T = any>(
    path: string,
    { page = 1, pageSize = 50, maxPages = 1, query = {} as Record<string, QueryValue> } = {},
  ): Promise<{ items: T[]; total_records?: number; total_pages?: number; page_size_applied?: number; complete: boolean; next_page?: number }> {
    const items: T[] = [];
    let totalRecords: number | undefined;
    let totalPages: number | undefined;
    const size = Math.max(1, Math.min(MAX_PAGE_SIZE, pageSize));
    // The page size the API actually applies: its `pageSize` when it reports one, otherwise the size
    // asked for, unless a short page arrives while totalRecords says more records follow (a smaller
    // size applied without saying so), in which case that page's length is used.
    let applied = size;
    let appliedReported = false;
    const result = (complete: boolean, next?: number) => ({ items, total_records: totalRecords, total_pages: totalPages, page_size_applied: applied !== size ? applied : undefined, complete, next_page: next });
    for (let n = 0, p = page; n < maxPages; n++, p++) {
      const res = await this.get<PagedResponse<T>>(path, { ...query, PageNumber: p, PageSize: size });
      const data = Array.isArray(res?.data) ? res.data : [];
      if (Number.isInteger(res?.totalRecords)) totalRecords = res.totalRecords;
      if (Number.isInteger(res?.totalPages)) totalPages = res.totalPages;
      if (Number.isInteger(res?.pageSize) && (res.pageSize as number) > 0) {
        applied = res.pageSize as number;
        appliedReported = true;
      }
      items.push(...data);
      let exhausted: boolean;
      if (data.length === 0) exhausted = true;
      else if (totalPages !== undefined) exhausted = p >= totalPages;
      else if (totalRecords !== undefined) {
        if (!appliedReported && data.length < applied && (p - 1) * applied + data.length < totalRecords) applied = data.length;
        exhausted = (p - 1) * applied + data.length >= totalRecords;
      } else exhausted = data.length < applied;
      if (exhausted) return result(true);
      if (n === maxPages - 1) return result(false, p + 1);
    }
    return result(false, page + maxPages);
  }
}

/** A compact JWT: three base64url segments, the first a JSON header object naming its `alg`. */
export function isJwt(value: string): boolean {
  if (!JWT_SHAPE.test(value)) return false;
  try {
    const header = JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString("utf8"));
    return !!header && typeof header === "object" && !Array.isArray(header) && typeof header.alg === "string";
  } catch {
    return false;
  }
}

/**
 * The JWT in an /Auth response: the body itself (text or a JSON string), else a string member of the
 * JSON object's `data` member, then of the object itself; within each, members named like a token
 * (token, accessToken, access_token, jwt, ...) are looked at first.
 */
export function findJwt(json: any, text: string): string | undefined {
  const candidate = (v: unknown) => {
    if (typeof v !== "string") return undefined;
    const t = v.trim().replace(/^Bearer\s+/i, "");
    return isJwt(t) ? t : undefined;
  };
  const inObject = (o: unknown) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
    const entries = Object.entries(o as Record<string, unknown>);
    const named = entries.filter(([k]) => TOKEN_KEYS.includes(k.toLowerCase()));
    for (const [, v] of [...named, ...entries]) {
      const c = candidate(v);
      if (c) return c;
    }
    return undefined;
  };
  if (json === undefined) return candidate(text);
  if (typeof json === "string") return candidate(json);
  return inObject(json?.data) ?? inObject(json);
}

/** When to stop using a JWT: before its `exp` claim (read, not verified), or never (until a 401). */
export function expiryOf(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp)) return Infinity;
    const remaining = exp * 1000 - Date.now();
    if (remaining <= 0) return Date.now();
    return Date.now() + remaining - Math.min(TOKEN_REFRESH_MARGIN_S * 1000, remaining / 2);
  } catch {
    return Infinity;
  }
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const parts: string[] = [];
  if (typeof json.message === "string" && json.message.trim()) parts.push(json.message.trim());
  for (const key of ["errors", "details"]) {
    const map = json[key];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      const entries = Object.entries(map).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => `${k}: ${v}`);
      if (entries.length) parts.push(entries.join("; "));
    }
  }
  return parts.length ? parts.join(" ") : undefined;
}
