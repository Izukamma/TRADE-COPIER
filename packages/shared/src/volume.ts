/**
 * Volume arithmetic on instrument steps. All rounding is done on integer step counts
 * so values like 0.07 / 0.01 never produce 6.999999 steps.
 */

export function decimalsOf(n: number): number {
  if (!Number.isFinite(n)) throw new Error(`non-finite number ${n}`);
  const s = n.toString();
  if (s.includes("e-")) {
    const [mant, exp] = s.split("e-");
    const mantDec = (mant!.split(".")[1] ?? "").length;
    return mantDec + Number(exp);
  }
  return (s.split(".")[1] ?? "").length;
}

/** Rounds a number to `decimals` places, removing binary noise. */
export function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f + Math.sign(n) * Number.EPSILON * f) / f;
}

function stepCount(volume: number, step: number, mode: "down" | "nearest" | "up"): number {
  const d = Math.max(decimalsOf(step), 0) + 2;
  const raw = roundTo(volume / step, d);
  const tol = 1e-9;
  if (mode === "down") return Math.floor(raw + tol);
  if (mode === "up") return Math.ceil(raw - tol);
  return Math.round(raw);
}

export function stepsToVolume(steps: number, step: number): number {
  return roundTo(steps * step, decimalsOf(step));
}

export interface VolumeRules {
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
}

export type VolumeRoundResult =
  | { ok: true; volume: number; adjusted: boolean; note?: string }
  | { ok: false; reason: string };

/**
 * Normalises a desired volume to the instrument rules.
 * Never rounds up past `hardCap` (risk/max-order limits). If the minimum volume itself
 * exceeds `hardCap`, the order is rejected instead of being rounded up.
 */
export function normalizeVolume(
  desired: number,
  rules: VolumeRules,
  opts: { mode?: "down" | "nearest"; hardCap?: number } = {},
): VolumeRoundResult {
  const { volumeMin, volumeMax, volumeStep } = rules;
  if (!(volumeStep > 0) || !(volumeMin > 0) || !(volumeMax >= volumeMin)) {
    return { ok: false, reason: `invalid instrument volume rules (min ${volumeMin}, max ${volumeMax}, step ${volumeStep})` };
  }
  if (!Number.isFinite(desired) || desired <= 0) {
    return { ok: false, reason: `computed volume ${desired} is not positive` };
  }
  const cap = Math.min(volumeMax, opts.hardCap ?? Number.POSITIVE_INFINITY);
  if (cap < volumeMin) {
    return { ok: false, reason: `minimum volume ${volumeMin} exceeds the allowed cap ${roundTo(cap, 8)}` };
  }
  const mode = opts.mode ?? "down";
  let steps = stepCount(desired, volumeStep, mode);
  // nearest may round up; clamp it back under the cap.
  const capSteps = stepCount(cap, volumeStep, "down");
  let note: string | undefined;
  if (steps > capSteps) {
    steps = capSteps;
    note = `capped at ${stepsToVolume(capSteps, volumeStep)}`;
  }
  let volume = stepsToVolume(steps, volumeStep);
  if (volume < volumeMin - 1e-12) {
    return {
      ok: false,
      reason: `computed volume ${roundTo(desired, 8)} is below the minimum ${volumeMin} (rounding up is not permitted)`,
    };
  }
  // Volume grid might be anchored at volumeMin rather than 0 on some instruments; keep it simple:
  // a value on the step grid that is >= min is accepted.
  volume = roundTo(volume, decimalsOf(volumeStep));
  return { ok: true, volume, adjusted: Math.abs(volume - desired) > 1e-12, note };
}

/** Round down to step, may return 0. Used for partial-close quantities. */
export function floorToStep(v: number, step: number): number {
  if (v <= 0) return 0;
  return stepsToVolume(stepCount(v, step, "down"), step);
}

export function roundPrice(price: number, digits: number): number {
  return roundTo(price, digits);
}

/** Rounds price onto the tick grid. */
export function roundToTick(price: number, tickSize: number, digits: number): number {
  if (!(tickSize > 0)) return roundTo(price, digits);
  const ticks = Math.round(roundTo(price / tickSize, 6));
  return roundTo(ticks * tickSize, digits);
}
