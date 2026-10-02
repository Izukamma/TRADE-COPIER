import type { ExecState } from "./types";

/**
 * Allowed execution transitions. ACCEPTED (order accepted by the platform) is distinct from
 * FILLED (a deal/position exists). UNKNOWN means a submission may or may not have reached the
 * platform; it can only leave via reconciliation.
 */
const TRANSITIONS: Record<ExecState, ExecState[]> = {
  DETECTED: ["QUEUED", "SKIPPED", "REJECTED"],
  QUEUED: ["SUBMITTED", "SKIPPED", "REJECTED", "QUEUED"],
  SUBMITTED: ["ACCEPTED", "FILLED", "REJECTED", "UNKNOWN"],
  ACCEPTED: ["FILLED", "REJECTED", "RECONCILED", "UNKNOWN"],
  FILLED: ["RECONCILED"],
  UNKNOWN: ["RECONCILED", "NEEDS_ATTENTION", "UNKNOWN", "QUEUED"],
  RECONCILED: [],
  REJECTED: ["QUEUED"],
  SKIPPED: [],
  NEEDS_ATTENTION: ["RECONCILED"],
};

export function canTransition(from: ExecState, to: ExecState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ExecState, to: ExecState): void {
  if (!canTransition(from, to)) throw new Error(`illegal execution transition ${from} -> ${to}`);
}

export const TERMINAL_STATES: ExecState[] = ["FILLED", "REJECTED", "SKIPPED", "RECONCILED", "NEEDS_ATTENTION"];
export const isTerminal = (s: ExecState) => TERMINAL_STATES.includes(s);
/** States where the job blocks later jobs in the same ordering key. */
export const BLOCKING_STATES: ExecState[] = ["DETECTED", "QUEUED", "SUBMITTED", "ACCEPTED", "UNKNOWN"];
