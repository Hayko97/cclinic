import { describe, expect, it } from "vitest";
import { AGENT_DENIED_TOOLS, READ_ONLY_TOOLS } from "../../core/constants/agents.js";
import { buildAgentArgs, claudeTranscriptPath } from "./agent-process.js";

const between = (args: readonly string[], from: string, to: string): readonly string[] =>
  args.slice(args.indexOf(from) + 1, args.indexOf(to));

describe("agent process arguments", () => {
  it("TC-PLAN-007: the PM can only read, can't ask for permission, and keeps no session", () => {
    const args = buildAgentArgs({
      model: "haiku",
      effort: "low",
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
    expect(args).not.toContain("--max-budget-usd");
    for (const tool of ["Bash", "Write", "Edit"])
      expect(between(args, "--tools", "--allowedTools")).not.toContain(tool);
  });

  it("TC-AUTO-021: with a session ID, the session is kept under that ID", () => {
    const args = buildAgentArgs({
      model: "haiku",
      effort: "low",
      tools: READ_ONLY_TOOLS,
      allowedTools: READ_ONLY_TOOLS,
      deniedTools: AGENT_DENIED_TOOLS,
      sessionId: "7c1e0000-0000-4000-8000-00000000a90f",
    });
    expect(args).not.toContain("--no-session-persistence");
    expect(args[args.indexOf("--session-id") + 1]).toBe("7c1e0000-0000-4000-8000-00000000a90f");
    // FR-AUTO-016: no dollar limit; the plan's own usage limits stop the work (FR-AUTO-025).
    expect(args).not.toContain("--max-budget-usd");
  });

  it("TC-AUTO-057: the transcript is in Claude Code's config folder, and an empty CLAUDE_CONFIG_DIR counts as unset", () => {
    const id = "7c1e0000-0000-4000-8000-00000000a90f";
    const folder = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
    expect(claudeTranscriptPath({ CLAUDE_CONFIG_DIR: "/cfg" }, ".", id)).toBe(`/cfg/projects/${folder}/${id}.jsonl`);
    expect(claudeTranscriptPath({ CLAUDE_CONFIG_DIR: "", HOME: "/home/me" }, ".", id)).toBe(
      `/home/me/.claude/projects/${folder}/${id}.jsonl`,
    );
  });
});
