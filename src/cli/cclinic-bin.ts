/** Where this cclinic program is, to start it again in a child process. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UsageError } from "../core/errors.js";

/** The `cclinic` entry point that started this process: `bin/cclinic.js`, from `dist` or from `src/cli`. */
export function cclinicBin(): string {
  const candidates = ["../bin/cclinic.js", "../../bin/cclinic.js"].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new UsageError("cclinic's own program file is missing. Reinstall cclinic.");
  return found;
}
