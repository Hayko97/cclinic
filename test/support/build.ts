/**
 * Vitest global setup: tests whose fake `claude` starts `luseen mcp --plan` run the built program, so it's built once
 * before any test file runs. Building per file let one file's rebuild delete `dist/` under another's running tests.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Vitest loads a global setup through its default export.
// eslint-disable-next-line no-restricted-exports
export default function buildOnce(): void {
  execFileSync(process.execPath, [path.join(REPO, "node_modules/tsup/dist/cli-default.js")], {
    cwd: REPO,
    stdio: "ignore",
  });
}
