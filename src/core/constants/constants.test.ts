import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redact, countRedactions } from "../redaction.js";
import { MINIMUM_NODE } from "./limits.js";
import { CLAUDE_MODELS, CODEX_EFFORTS, CODEX_MODELS, DEFAULT_CLAUDE_EFFORT, DEFAULT_CLAUDE_MODEL } from "./models.js";

const SOURCE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONSTANTS_FOLDER = path.join(SOURCE_ROOT, "core/constants");

function sourceFiles(folder: string = SOURCE_ROOT): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

const filesOutsideConstants = sourceFiles().filter((file) => !file.startsWith(CONSTANTS_FOLDER));

function filesContaining(pattern: RegExp, files: readonly string[]): string[] {
  return files
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(SOURCE_ROOT, file));
}

function quoted(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`]${escaped}["'\`]`);
}

afterEach(() => {
  vi.doUnmock("./models.js");
  vi.resetModules();
});

describe("model constants", () => {
  it("TC-LLM-053: holds every model from the spec, with Sonnet at medium as the default", () => {
    expect(Object.values(CLAUDE_MODELS).map((model) => [model.value, model.apiId])).toEqual([
      ["sonnet", "claude-sonnet-5-5"],
      ["opus", "claude-opus-5-5"],
      ["haiku", "claude-haiku-5-5"],
      ["fable", "claude-fable-5-1"],
    ]);
    expect(Object.values(CODEX_MODELS).map((model) => model.apiId)).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-luna",
    ]);
    expect(Object.values(CODEX_EFFORTS)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(DEFAULT_CLAUDE_MODEL.value).toBe("sonnet");
    expect(DEFAULT_CLAUDE_EFFORT.value).toBe("medium");
  });

  const modelLiterals = [
    ...Object.values(CLAUDE_MODELS).flatMap((model) => [model.value, model.apiId]),
    ...Object.values(CODEX_MODELS).map((model) => model.apiId),
  ];

  it.each(modelLiterals)("TC-LLM-054: %s appears only in the constants file", (literal) => {
    expect(filesOutsideConstants.length).toBeGreaterThan(10);
    expect(filesContaining(quoted(literal), filesOutsideConstants)).toEqual([]);
  });

  it("TC-LLM-055: changing a label in the constants changes it everywhere", async () => {
    vi.resetModules();
    vi.doMock("./models.js", async (importActual) => {
      const actual = await importActual<typeof import("./models.js")>();
      const SONNET = { ...actual.CLAUDE_MODELS.SONNET, label: "Renamed Model", hint: "Renamed hint" };
      return {
        ...actual,
        CLAUDE_MODELS: { ...actual.CLAUDE_MODELS, SONNET },
        DEFAULT_CLAUDE_MODEL: SONNET,
      };
    });
    const models = await import("../models.js");
    const cli = await import("../../adapters/llm/claude-cli.js");
    const menus = await import("../../cli/menus.js");

    expect(models.labelForModel("sonnet")).toBe("Renamed Model");
    expect(models.validOptionsText()).toContain("Renamed Model (default): Renamed hint");
    expect(menus.menuChoices(models.MODEL_OPTIONS)[0]?.name).toContain("Renamed hint");
    const invalidModel = [{ type: "result", is_error: true, api_error_status: 404 }];
    expect(() => cli.interpretOutcome(invalidModel, 1, "sonnet")).toThrow(/Renamed Model/);
  });
});

describe("other constants", () => {
  it.each(["64000", "64_000", "server-side-fallback", "CLAUDE_CODE_", 'ANTHROPIC_API_KEY"\\]'])(
    "TC-LLM-057: %s appears only in the constants",
    (literal) => {
      expect(filesContaining(new RegExp(literal), filesOutsideConstants)).toEqual([]);
    },
  );

  it("TC-LLM-058: the constants hold no key-shaped text", () => {
    const files = sourceFiles(CONSTANTS_FOLDER);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      expect(countRedactions(redact(readFileSync(file, "utf8")).counts)).toBe(0);
    }
  });

  it("bin/cclinic.js checks the same minimum Node.js version", () => {
    const bin = readFileSync(path.join(SOURCE_ROOT, "../bin/cclinic.js"), "utf8");
    expect(bin).toContain(`parts[0] < ${MINIMUM_NODE.major}`);
    expect(bin).toContain(`parts[1] < ${MINIMUM_NODE.minor}`);
    expect(bin).toContain(`Node.js ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor}`);
  });
});
