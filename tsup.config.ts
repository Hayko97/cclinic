import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: { main: "src/cli/main.ts" },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  // Keeps "node:sqlite", which only exists with the prefix.
  removeNodeProtocol: false,
  // The GUI's pages ship with the package, next to the code that serves them (FR-GUI-045).
  onSuccess: async () => {
    await cp("src/gui", "dist/gui", { recursive: true });
  },
});

// tsup loads its configuration through the default export.
// eslint-disable-next-line no-restricted-exports
export default tsupConfig;
