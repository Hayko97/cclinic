import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReporter, type ReporterOptions } from "./reporter.js";

function setup(overrides: Partial<ReporterOptions> = {}) {
  let out = "";
  let err = "";
  const reporter = createReporter({
    quiet: false,
    debug: false,
    color: "never",
    environment: {},
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
    now: () => 1000,
    ...overrides,
  });
  return { reporter, stdout: () => out, stderr: () => err };
}

describe("reporter", () => {
  it("TC-CLI-006: progress goes to stderr, and results to stdout", () => {
    const { reporter, stdout, stderr } = setup();
    reporter.info("progress");
    reporter.result("done");
    expect(stderr()).toBe("progress\n");
    expect(stdout()).toBe("done\n");
  });

  it("TC-CLI-023: --quiet hides progress and warnings, but not errors or prompts", () => {
    const { reporter, stderr } = setup({ quiet: true });
    reporter.info("progress");
    reporter.warn("careful");
    reporter.notice("summary for a prompt");
    reporter.error("broken");
    expect(stderr()).toBe("summary for a prompt\nError: broken\n");
  });

  it("TC-CLI-024: --debug adds timed details, and is silent otherwise", () => {
    const quiet = setup();
    quiet.reporter.debug("hidden");
    expect(quiet.stderr()).toBe("");
    const loud = setup({ debug: true });
    loud.reporter.debug("details");
    expect(loud.stderr()).toBe("[+0ms] details\n");
  });

  it("TC-CLI-051: --debug-file gets details, without printing them", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "cclinic-reporter-"));
    try {
      const debugFile = path.join(folder, "debug.log");
      const { reporter, stderr } = setup({ debugFile, quiet: true });
      reporter.info("stage");
      reporter.warn("careful");
      expect(stderr()).toBe("");
      expect(readFileSync(debugFile, "utf8")).toBe("[+0ms] stage\n[+0ms] warning: careful\n");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("TC-CLI-028: labels are colored only when enabled", () => {
    const colored = setup({ color: "always" });
    colored.reporter.warn("careful");
    colored.reporter.error("broken");
    expect(colored.stderr()).toContain("\u001b[33mWarning:");
    expect(colored.stderr()).toContain("\u001b[31mError:");
    expect(colored.reporter.bold("x")).toBe("\u001b[1mx\u001b[0m");
    expect(setup().reporter.bold("x")).toBe("x");
  });
});
