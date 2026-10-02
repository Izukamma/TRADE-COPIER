"use client";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/** TOTP enrolment via Better Auth's two-factor plugin. The secret is shown once to the owner only. */
export function TwoFactorSetup({ enabled }: { enabled: boolean }) {
  const [uri, setUri] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  if (enabled)
    return (
      <form
        className="form"
        action={async (fd) => {
          const r = await authClient.twoFactor.disable({ password: String(fd.get("password")) });
          setMsg(r.error ? "Failed." : "Two-factor disabled.");
          if (!r.error) window.location.reload();
        }}
      >
        <label>
          Password
          <input name="password" type="password" required />
        </label>
        <div className="form-foot">
          <button className="btn btn-danger">Disable two-factor</button>
          {msg && <span className="dim">{msg}</span>}
        </div>
      </form>
    );
  return (
    <div className="form">
      {!uri ? (
        <form
          className="form"
          action={async (fd) => {
            const r = await authClient.twoFactor.enable({ password: String(fd.get("password")) });
            if (r.error || !r.data || !("totpURI" in r.data)) return setMsg("Failed (check password).");
            setUri(r.data.totpURI);
            setCodes(r.data.backupCodes ?? []);
          }}
        >
          <label>
            Confirm password to start enrolment
            <input name="password" type="password" required />
          </label>
          <div className="form-foot">
            <button className="btn">Start TOTP enrolment</button>
            {msg && <span className="msg-bad">{msg}</span>}
          </div>
        </form>
      ) : (
        <form
          className="form"
          action={async (fd) => {
            const r = await authClient.twoFactor.verifyTotp({ code: String(fd.get("code")) });
            setMsg(r.error ? "Invalid code." : "Two-factor enabled.");
            if (!r.error) window.location.reload();
          }}
        >
          <div className="secret-once">
            <strong>Add this to your authenticator app (shown once):</strong>
            <code className="break">{uri}</code>
            <strong>Backup codes — store offline:</strong>
            <code className="break">{codes.join("  ")}</code>
          </div>
          <label>
            6-digit code
            <input name="code" inputMode="numeric" pattern="[0-9]{6}" required />
          </label>
          <div className="form-foot">
            <button className="btn">Verify and enable</button>
            {msg && <span className="dim">{msg}</span>}
          </div>
        </form>
      )}
    </div>
  );
}
