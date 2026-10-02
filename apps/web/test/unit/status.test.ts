import { describe, expect, it } from "vitest";
import { effectiveStatus, engineAlive, envLabel } from "@/lib/status";

const now = Date.now();
describe("dashboard status display", () => {
  it("never shows CONNECTED from a saved record alone", () => {
    const rec = { connectionStatus: "CONNECTED", lastSyncAt: new Date(now - 1000), enabled: true };
    expect(effectiveStatus(rec, false, now).label).toBe("UNKNOWN"); // engine offline
    expect(effectiveStatus({ ...rec, lastSyncAt: null }, true, now).label).toBe("STALE");
    expect(effectiveStatus({ ...rec, lastSyncAt: new Date(now - 120_000) }, true, now).label).toBe("STALE");
    expect(effectiveStatus(rec, true, now).label).toBe("CONNECTED");
  });
  it("labels modes distinctly", () => {
    expect(envLabel("SIMULATION")).toBe("SIMULATION");
    expect(envLabel("DEMO")).toBe("DEMO ACCOUNT");
    expect(envLabel("LIVE")).toBe("LIVE ACCOUNT");
  });
  it("treats a missing or old heartbeat as engine offline", () => {
    expect(engineAlive(null)).toBe(false);
    expect(engineAlive(new Date(now - 60_000), now)).toBe(false);
    expect(engineAlive(new Date(now - 1000), now)).toBe(true);
  });
});
