"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function LoginForm({ twoFactor }: { twoFactor: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onLogin(fd: FormData) {
    setBusy(true);
    setErr(null);
    const r = await authClient.signIn.email({ email: String(fd.get("email")), password: String(fd.get("password")) });
    setBusy(false);
    if (r.error) return setErr("Sign-in failed.");
    if ((r.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return;
    window.location.href = "/";
  }
  async function onTotp(fd: FormData) {
    setBusy(true);
    setErr(null);
    const r = await authClient.twoFactor.verifyTotp({ code: String(fd.get("code")) });
    setBusy(false);
    if (r.error) return setErr("Invalid code.");
    window.location.href = "/";
  }

  if (twoFactor)
    return (
      <form action={onTotp} className="form">
        <label>
          Authenticator code
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required />
        </label>
        <button className="btn" disabled={busy}>
          Verify
        </button>
        {err && <span className="msg-bad">{err}</span>}
      </form>
    );
  return (
    <form action={onLogin} className="form">
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required minLength={12} />
      </label>
      <button className="btn" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {err && <span className="msg-bad">{err}</span>}
    </form>
  );
}
