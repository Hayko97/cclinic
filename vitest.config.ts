import { defineConfig } from "vitest/config";

export const vitestConfig = defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/cli/main.ts", "src/cli/build-plugin.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        lines: 80,
        branches: 80,
        "src/core/**": { lines: 90, branches: 90 },
      },
    },
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"] } },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          testTimeout: 30_000,
          globalSetup: ["test/support/build.ts"],
        },
      },
      { test: { name: "e2e", include: ["test/e2e/**/*.test.ts"], testTimeout: 60_000 } },
    ],
  },
});

// Vitest loads its configuration through the default export.
// eslint-disable-next-line no-restricted-exports
export default vitestConfig;
