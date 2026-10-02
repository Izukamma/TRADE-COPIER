import pino from "pino";
import { redact } from "@gtc/shared";
import { engineLogs, type Db } from "@gtc/db";

export interface Log {
  debug(component: string, msg: string, ctx?: Record<string, unknown>): void;
  info(component: string, msg: string, ctx?: Record<string, unknown>): void;
  warn(component: string, msg: string, ctx?: Record<string, unknown>): void;
  error(component: string, msg: string, ctx?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

/** Structured logger: stdout (pino) + batched DB sink for the Diagnostics page. All context is redacted. */
export function createLogger(db: Db | null, level: "debug" | "info" | "warn" | "error" = "info"): Log {
  const p = pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
  const buf: (typeof engineLogs.$inferInsert)[] = [];
  let flushing = false;
  const flush = async () => {
    if (!db || flushing || buf.length === 0) return;
    flushing = true;
    const batch = buf.splice(0, 200);
    try {
      await db.insert(engineLogs).values(batch);
    } catch (e) {
      p.error({ err: (e as Error).message }, "log sink failed");
    } finally {
      flushing = false;
    }
  };
  const timer = setInterval(flush, 1000);
  timer.unref();
  const write = (lvl: "debug" | "info" | "warn" | "error", component: string, msg: string, ctx?: Record<string, unknown>) => {
    const safe = ctx ? redact(ctx) : undefined;
    const safeMsg = redact(msg);
    p[lvl]({ component, ...safe }, safeMsg);
    if (lvl !== "debug" && db) {
      buf.push({ level: lvl, component, message: safeMsg.slice(0, 2000), context: safe ?? null });
      if (buf.length > 5000) buf.splice(0, buf.length - 5000);
    }
  };
  return {
    debug: (c, m, x) => write("debug", c, m, x),
    info: (c, m, x) => write("info", c, m, x),
    warn: (c, m, x) => write("warn", c, m, x),
    error: (c, m, x) => write("error", c, m, x),
    flush,
  };
}

export const nullLogger: Log = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };
