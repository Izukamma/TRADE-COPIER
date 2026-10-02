# Security model

- **Single owner.** Better Auth email/password, public sign-up disabled, optional TOTP. The owner
  is created only by a server-side CLI. Every page, server action and route handler verifies that
  the session's email equals `OWNER_EMAIL` (`apps/web/src/lib/authz.ts`); the Next.js proxy is
  only a coarse redirect. Sessions are DB-backed, 12 h, httpOnly, `__Secure-` cookies over HTTPS.
  Sign-in is rate limited.
- **Secrets at rest.** Platform credentials, cached platform session tokens and device-token
  secrets are AES-256-GCM encrypted with a key ring held in the environment, bound to their
  record via AAD. The dashboard never selects encrypted columns; credential fields are write-only.
- **MetaTrader.** Logins stay in the terminal. EAs use scoped device tokens (one account, one
  login), HMAC-signed requests with timestamp + single-use nonce, signed responses, revocation.
- **Transport.** Caddy terminates TLS (HSTS). The bridge endpoint warns if configured over HTTP.
- **Redaction.** Logs, errors, diagnostics, evidence exports and alerts pass through
  `redact()`; tokens/JWTs/passwords are masked. Request headers are not logged by Caddy.
- **Audit.** Owner mutations, engine control results, bridge login mismatches are recorded in
  `audit_log` with actor and IP.
- **Headers.** CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, HSTS.
- **Deterministic execution.** Sizing, filters, risk checks and order decisions are pure code with
  recorded reasons. No AI model authorises, sizes, places, modifies or closes trades.
- **Live money.** Disabled by default; needs an engine flag *and* per-account arming.

Do not share `.env`, the encryption key, device tokens or screenshots showing them. If a token
leaks, revoke it in the dashboard and issue a new one.
