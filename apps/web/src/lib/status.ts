/** Pure display logic (unit-tested). A saved record alone never shows as "Connected". */
export type Tone = "ok" | "warn" | "bad" | "muted" | "info" | "sim" | "live" | "demo";

export const ENGINE_STALE_MS = 10_000;
export const SYNC_STALE_MS = 30_000;

export function engineAlive(lastBeatAt: Date | null | undefined, now = Date.now()): boolean {
  return !!lastBeatAt && now - lastBeatAt.getTime() < ENGINE_STALE_MS;
}

export function effectiveStatus(
  a: { connectionStatus: string; lastSyncAt: Date | null; enabled: boolean },
  alive: boolean,
  now = Date.now(),
): { label: string; tone: Tone; detail?: string } {
  if (!a.enabled) return { label: "DISABLED", tone: "muted" };
  if (!alive) return { label: "UNKNOWN", tone: "muted", detail: "engine offline: live status unavailable" };
  const fresh = !!a.lastSyncAt && now - a.lastSyncAt.getTime() < SYNC_STALE_MS;
  switch (a.connectionStatus) {
    case "CONNECTED":
      return fresh ? { label: "CONNECTED", tone: "ok" } : { label: "STALE", tone: "warn", detail: "no successful sync in the last 30 s" };
    case "DEGRADED":
      return { label: "DEGRADED", tone: "warn" };
    case "AUTH_FAILED":
      return { label: "AUTH FAILED", tone: "bad" };
    case "AWAITING_BRIDGE":
      return { label: "AWAITING BRIDGE", tone: "warn" };
    case "CONNECTING":
      return { label: "CONNECTING", tone: "info" };
    case "NOT_CONFIGURED":
      return { label: "NOT CONFIGURED", tone: "muted" };
    default:
      return { label: "DISCONNECTED", tone: "bad" };
  }
}

export const envTone = (env: string): Tone => (env === "LIVE" ? "live" : env === "DEMO" ? "demo" : "sim");
export const envLabel = (env: string) => (env === "LIVE" ? "LIVE ACCOUNT" : env === "DEMO" ? "DEMO ACCOUNT" : "SIMULATION");

export function stateTone(state: string): Tone {
  switch (state) {
    case "FILLED":
    case "RECONCILED":
      return "ok";
    case "REJECTED":
    case "NEEDS_ATTENTION":
      return "bad";
    case "UNKNOWN":
      return "warn";
    case "SKIPPED":
      return "muted";
    default:
      return "info";
  }
}

export function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function ago(d: Date | null | undefined, now = Date.now()): string {
  if (!d) return "never";
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function ms(a: Date | null | undefined, b: Date | null | undefined): string {
  if (!a || !b) return "—";
  return `${Math.max(0, b.getTime() - a.getTime())} ms`;
}
