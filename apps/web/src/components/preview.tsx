"use client";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ActionState } from "@/lib/authz";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

export function PreviewForm({ action, routeId }: { action: Action; routeId: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  const rows = (state?.data?.rows as Record<string, string>[] | undefined) ?? [];
  return (
    <form action={formAction} className="form">
      <input type="hidden" name="id" value={routeId} />
      <div className="form-row">
        <label>
          Sample master volume (lots)
          <input name="masterVolume" type="number" step="any" defaultValue="1" min="0" />
        </label>
        <label>
          Sample SL distance (price units, for risk sizing)
          <input name="slPoints" type="number" step="any" placeholder="e.g. 100" />
        </label>
      </div>
      <div className="form-foot">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Computing…" : "Preview sizing"}
        </button>
        {state && <span className={state.ok ? "msg-ok" : "msg-bad"}>{state.message}</span>}
      </div>
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Mapping</th>
                <th>Follower size</th>
                <th>Risk at SL</th>
                <th>How it was computed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol}>
                  <td className="nowrap">{r.symbol}</td>
                  <td className={String(r.result).startsWith("REJECTED") ? "msg-bad" : ""}>{r.result}</td>
                  <td>{r.riskAtStop}</td>
                  <td className="faint">{r.explanation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </form>
  );
}
