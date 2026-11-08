import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: { main: "src/cli/main.ts" },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Keeps "node:sqlite", which only exists with the prefix.
  removeNodeProtocol: false,
});

// tsup loads its configuration through the default export.
// eslint-disable-next-line no-restricted-exports
export default tsupConfig;
