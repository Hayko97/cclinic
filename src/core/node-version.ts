/** Also checked in bin/cclinic.js, which must run on old Node.js versions. */
import { TESTED_CLAUDE_VERSION } from "./constants/llm.js";
import { MINIMUM_NODE } from "./constants/limits.js";

export function isSupportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor);
}

export const TESTED_CLAUDE_VERSION_TEXT = TESTED_CLAUDE_VERSION.join(".");

/** Returns true when the version can't be read, or is older than the tested one (FR-LLM-027). */
export function isClaudeVersionUntested(versionOutput: string): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (match === null) return true;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (const [index, tested] of TESTED_CLAUDE_VERSION.entries()) {
    const part = parts[index] ?? 0;
    if (part !== tested) return part < tested;
  }
  return false;
}
