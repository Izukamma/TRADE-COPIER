import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const alias = { "@": r("./apps/web/src"), "server-only": r("./apps/web/test/server-only-stub.ts") };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/engine/test/unit/**/*.test.ts", "apps/web/test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["apps/engine/test/integration/**/*.test.ts", "apps/web/test/integration/**/*.test.ts"],
          environment: "node",
          // Integration tests share one database; run files sequentially.
          fileParallelism: false,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
