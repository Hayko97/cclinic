import { describe, expect, it } from "vitest";
import { AGENT_DENIED_TOOLS, READ_ONLY_TOOLS } from "../../core/constants/agents.js";
import { buildAgentArgs } from "./agent-process.js";

const between = (args: readonly string[], from: string, to: string): readonly string[] =>
  args.slice(args.indexOf(from) + 1, args.indexOf(to));

describe("agent process arguments", () => {
  it("TC-PLAN-007: the PM can only read, can't ask for permission, and keeps no session", () => {
    const args = buildAgentArgs({
      model: "haiku",
      effort: "low",
      maxBudgetUsd: 2,
      jsonSchema: { type: "object" },
      tools: READ_ONLY_TOOLS,
      allowedTools: READ_ONLY_TOOLS,
      deniedTools: AGENT_DENIED_TOOLS,
    });
    expect(args[0]).toBe("-p");
    expect(between(args, "--tools", "--allowedTools")).toEqual(["Read", "Glob", "Grep"]);
    expect(between(args, "--allowedTools", "--disallowedTools")).toEqual(["Read", "Glob", "Grep"]);
    const denied = between(args, "--disallowedTools", "--permission-mode");
    expect(denied).toContain("Read(**/.env)");
    expect(denied).toContain("Bash(git *)");
    for (const flag of ["--safe-mode", "--no-session-persistence"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
    expect(args.slice(-2)).toEqual(["--max-budget-usd", "2.000000"]);
    for (const tool of ["Bash", "Write", "Edit"])
      expect(between(args, "--tools", "--allowedTools")).not.toContain(tool);
  });
});
