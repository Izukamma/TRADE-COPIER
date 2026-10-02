import { redactString } from "@gtc/shared";

export type HttpFailure =
  /** Request certainly did not reach the server (DNS, refused, connect timeout). Safe to retry. */
  | { kind: "NOT_SENT"; message: string }
  /** Request may have been processed (read timeout, reset, 5xx on a mutation). Reconcile first. */
  | { kind: "AMBIGUOUS"; message: string }
  | { kind: "RATE_LIMIT"; message: string; retryAfterMs: number }
  | { kind: "AUTH"; message: string; status: number }
  | { kind: "CLIENT"; message: string; status: number; body: unknown }
  | { kind: "SERVER"; message: string; status: number };

export type HttpResult<T> = { ok: true; status: number; data: T; latencyMs: number } | { ok: false; failure: HttpFailure; latencyMs: number };

export interface HttpRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT"]);

function errorCode(e: unknown): string | undefined {
  const anyE = e as { code?: string; cause?: { code?: string } };
  return anyE?.cause?.code ?? anyE?.code;
}

export async function httpJson<T = unknown>(req: HttpRequest, fetchImpl: FetchLike = fetch): Promise<HttpResult<T>> {
  const started = Date.now();
  const mutating = req.method !== "GET";
  let res: Response;
  try {
    res = await fetchImpl(req.url, {
      method: req.method,
      headers: { accept: "application/json", ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...req.headers },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(req.timeoutMs ?? 10_000),
      redirect: "error",
    });
  } catch (e) {
    const latencyMs = Date.now() - started;
    const code = errorCode(e);
    const msg = redactString(`${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? String(e)}${code ? ` (${code})` : ""}`);
    if (code && NOT_SENT_CODES.has(code)) return { ok: false, failure: { kind: "NOT_SENT", message: msg }, latencyMs };
    return { ok: false, failure: { kind: mutating ? "AMBIGUOUS" : "NOT_SENT", message: msg }, latencyMs };
  }
  const latencyMs = Date.now() - started;
  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, failure: { kind: mutating ? "AMBIGUOUS" : "NOT_SENT", message: `body read failed: ${(e as Error).message}` }, latencyMs };
  }
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    return { ok: false, failure: { kind: "RATE_LIMIT", message: "HTTP 429", retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 }, latencyMs };
  }
  if (res.status === 401 || res.status === 403)
    return { ok: false, failure: { kind: "AUTH", status: res.status, message: `HTTP ${res.status}: ${summarize(body)}` }, latencyMs };
  if (res.status >= 500) {
    const message = `HTTP ${res.status}: ${summarize(body)}`;
    return { ok: false, failure: mutating ? { kind: "AMBIGUOUS", message } : { kind: "SERVER", status: res.status, message }, latencyMs };
  }
  if (res.status >= 400)
    return { ok: false, failure: { kind: "CLIENT", status: res.status, message: `HTTP ${res.status}: ${summarize(body)}`, body }, latencyMs };
  return { ok: true, status: res.status, data: body as T, latencyMs };
}

export function summarize(body: unknown): string {
  if (body === undefined || body === null) return "(empty)";
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return redactString(s).slice(0, 300);
}

/** Decodes a JWT `exp` without verifying (expiry scheduling only). */
export function jwtExpiryMs(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Rolling latency average. */
export class LatencyTracker {
  private samples: number[] = [];
  add(ms: number) {
    this.samples.push(ms);
    if (this.samples.length > 50) this.samples.shift();
  }
  avg(): number | null {
    return this.samples.length ? Math.round(this.samples.reduce((a, b) => a + b, 0) / this.samples.length) : null;
  }
}

/** Reads the first finite number among candidate keys; used where field names are not verified. */
export function pickNumber(obj: Record<string, unknown> | undefined | null, keys: string[]): number | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

export function pickString(obj: Record<string, unknown> | undefined | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}
