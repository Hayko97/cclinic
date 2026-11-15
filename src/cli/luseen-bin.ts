/** Where this luseen program is, to start it again in a child process. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UsageError } from "../core/errors.js";

/** The `luseen` entry point that started this process: `bin/luseen.js`, from `dist` or from `src/cli`. */
export function luseenBin(): string {
  const candidates = ["../bin/luseen.js", "../../bin/luseen.js"].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new UsageError("luseen's own program file is missing. Reinstall luseen.");
  return found;
}
