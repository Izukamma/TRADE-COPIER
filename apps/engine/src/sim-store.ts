import { eq } from "drizzle-orm";
import { appSettings, type Db } from "@gtc/db";
import { SimBroker, type SimState } from "@gtc/adapters";

/** Persists simulator brokers so SIMULATION accounts survive engine restarts (restart tests). */
export class SimStore {
  private brokers = new Map<string, SimBroker>();
  private dirty = new Set<string>();
  constructor(private db: Db) {}

  async get(accountId: string, profile: string, accounting: "HEDGING" | "NETTING"): Promise<SimBroker> {
    const existing = this.brokers.get(accountId);
    if (existing) return existing;
    const row = await this.db.query.appSettings.findFirst({ where: eq(appSettings.key, `sim:${accountId}`) });
    const state = row?.value as SimState | undefined;
    const broker = new SimBroker(profile, state && state.profile === profile ? { state } : { accounting, seed: hashSeed(accountId) });
    broker.onChange = () => this.dirty.add(accountId);
    this.brokers.set(accountId, broker);
    this.dirty.add(accountId);
    await this.flush();
    return broker;
  }

  peek(accountId: string) {
    return this.brokers.get(accountId);
  }

  async flush() {
    for (const id of [...this.dirty]) {
      this.dirty.delete(id);
      const b = this.brokers.get(id);
      if (!b) continue;
      const value = JSON.parse(JSON.stringify(b.state));
      await this.db
        .insert(appSettings)
        .values({ key: `sim:${id}`, value })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    }
  }

  drop(accountId: string) {
    this.brokers.delete(accountId);
  }
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
