import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/engine/test/unit/**/*.test.ts", "apps/web/test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
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
