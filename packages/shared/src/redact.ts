/** Redaction for logs, errors and exported reports. */
const SECRET_KEYS = /pass(word)?|secret|token|authorization|api[-_]?key|cookie|refresh|credential|signature|private/i;

export function redact<T>(value: T, depth = 0): T {
  if (depth > 6) return "[depth]" as unknown as T;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function redactString(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[JWT]")
    .replace(/gtcd_[A-Za-z0-9]+_[A-Za-z0-9_-]+/g, "gtcd_[REDACTED]")
    .replace(/("?(password|token|secret|apiKey|refreshToken|accessToken)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}
