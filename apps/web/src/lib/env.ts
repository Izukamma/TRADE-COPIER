import "server-only";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  /** The single owner. Sessions for any other identity are rejected server-side. */
  OWNER_EMAIL: z.string().email(),
  GTC_ENCRYPTION_KEYS: z.string().min(1),
  GTC_ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1),
  /** Engine bridge URL shown in setup instructions (public HTTPS address of the reverse proxy). */
  PUBLIC_BRIDGE_URL: z.string().url().optional(),
});

let cached: z.infer<typeof schema> | null = null;
export function env() {
  if (cached) return cached;
  const r = schema.safeParse(process.env);
  if (!r.success) throw new Error(`invalid web configuration: ${r.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  cached = r.data;
  return cached;
}
