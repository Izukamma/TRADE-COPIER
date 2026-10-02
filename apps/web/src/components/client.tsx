"use client";
import { useActionState, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ActionState } from "@/lib/authz";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/**
 * Form bound to an owner-only server action. Optional typed confirmation for destructive
 * operations (the server re-validates the phrase; the client check is only convenience).
 */
export function ActionForm({
  action,
  children,
  submit,
  confirmPhrase,
  className,
  danger,
  inline,
  onDone,
}: {
  action: Action;
  children?: ReactNode;
  submit: string;
  confirmPhrase?: string;
  className?: string;
  danger?: boolean;
  inline?: boolean;
  onDone?: (s: ActionState) => void;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [typed, setTyped] = useState("");
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
    if (state) onDone?.(state);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = !!confirmPhrase && typed !== confirmPhrase;
  return (
    <form action={formAction} className={`${inline ? "form-inline" : "form"} ${className ?? ""}`}>
      {children}
      {confirmPhrase && (
        <label className="confirm">
          Type <code>{confirmPhrase}</code> to confirm
          <input name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
      )}
      <div className="form-foot">
        <button type="submit" className={danger ? "btn btn-danger" : "btn"} disabled={pending || blocked}>
          {pending ? "Working…" : submit}
        </button>
        {state && <span className={state.ok ? "msg-ok" : "msg-bad"}>{state.message}</span>}
      </div>
      {state?.data?.secretOnce ? (
        <div className="secret-once">
          <strong>Copy this now — it will not be shown again:</strong>
          <code className="break">{String(state.data.secretOnce)}</code>
        </div>
      ) : null}
    </form>
  );
}

export function AutoRefresh({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter();
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [on, everyMs, router]);
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOn(!on)} title="Auto-refresh">
      {on ? "● Live" : "○ Paused"}
    </button>
  );
}

const NAV = [
  ["/", "Overview"],
  ["/accounts", "Accounts"],
  ["/groups", "Copier Groups"],
  ["/symbols", "Symbol Mapping"],
  ["/activity", "Live Activity"],
  ["/history", "Trade History"],
  ["/risk", "Risk Controls"],
  ["/diagnostics", "Diagnostics"],
  ["/simulator", "Simulator"],
  ["/setup", "Setup Guide"],
  ["/settings", "Settings"],
] as const;

export function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <nav className={`nav ${open ? "nav-open" : ""}`}>
      <div className="brand">
        <span className="brand-mark">G</span>
        <span>
          Gabriel <b>Trade Copier</b>
        </span>
        <button className="nav-toggle" type="button" onClick={() => setOpen(!open)} aria-label="Menu">
          ☰
        </button>
      </div>
      <ul onClick={() => setOpen(false)}>
        {NAV.map(([href, label]) => (
          <li key={href}>
            <Link href={href} className={(href === "/" ? path === "/" : path.startsWith(href)) ? "active" : ""}>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
