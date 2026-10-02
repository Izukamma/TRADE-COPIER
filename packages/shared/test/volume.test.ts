import { describe, expect, it } from "vitest";
import { decimalsOf, floorToStep, normalizeVolume, roundToTick } from "../src/volume";

const rules = { volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01 };

describe("volume rounding", () => {
  it("rounds down to the step without float artefacts", () => {
    expect(normalizeVolume(0.07, rules)).toMatchObject({ ok: true, volume: 0.07 });
    expect(normalizeVolume(0.1 + 0.2, rules)).toMatchObject({ ok: true, volume: 0.3 });
    expect(normalizeVolume(0.129999, rules)).toMatchObject({ ok: true, volume: 0.12 });
    expect(normalizeVolume(1.005, { volumeMin: 0.1, volumeMax: 50, volumeStep: 0.1 })).toMatchObject({ ok: true, volume: 1 });
  });

  it("never rounds up below the minimum", () => {
    const r = normalizeVolume(0.004, rules);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/below the minimum/);
  });

  it("rejects instead of rounding up when the minimum exceeds a hard cap (risk)", () => {
    const r = normalizeVolume(0.08, { volumeMin: 0.1, volumeMax: 50, volumeStep: 0.1 }, { hardCap: 0.08 });
    expect(r.ok).toBe(false);
  });

  it("caps at max volume and order cap", () => {
    expect(normalizeVolume(80, rules)).toMatchObject({ ok: true, volume: 50 });
    expect(normalizeVolume(3.37, rules, { hardCap: 2.5 })).toMatchObject({ ok: true, volume: 2.5 });
  });

  it("handles coarse steps (indices with 0.1 / 1 lot steps)", () => {
    expect(normalizeVolume(2.97, { volumeMin: 1, volumeMax: 100, volumeStep: 1 })).toMatchObject({ ok: true, volume: 2 });
    expect(normalizeVolume(0.95, { volumeMin: 1, volumeMax: 100, volumeStep: 1 }).ok).toBe(false);
  });

  it("nearest mode never exceeds the cap", () => {
    expect(normalizeVolume(0.256, rules, { mode: "nearest", hardCap: 0.255 })).toMatchObject({ ok: true, volume: 0.25 });
  });

  it("floors partial-close quantities and handles tiny steps", () => {
    expect(floorToStep(0.15, 0.1)).toBe(0.1);
    expect(floorToStep(0.3, 0.1)).toBe(0.3);
    expect(floorToStep(0.0099, 0.01)).toBe(0);
    expect(decimalsOf(1e-7)).toBe(7);
  });

  it("rounds prices onto the tick grid", () => {
    expect(roundToTick(5600.37, 0.25, 2)).toBe(5600.25);
    expect(roundToTick(1.234567, 0.00001, 5)).toBe(1.23457);
  });
});
