import { describe, expect, it } from "vitest";
import { UsageError } from "../core/errors.js";
import type { GenerateOptions } from "../core/gui.js";
import type { Jobs, JobView } from "./gui-jobs.js";
import { askGenerate } from "./gui-setup.js";

const OPTIONS = { include: [], exclude: [] } as unknown as GenerateOptions;

function jobsWith(whenEnded: Jobs["whenEnded"]): { jobs: Jobs; started: unknown[] } {
  const started: unknown[] = [];
  const jobs = {
    start: (request: unknown) => {
      started.push(request);
      return { id: "job-1" } as JobView;
    },
    whenEnded,
  } as unknown as Jobs;
  return { jobs, started };
}

describe("generate's questions (QA D1 run 3)", () => {
  it("TC-GUI-023: a dry run the GUI no longer has is refused as a usage error, naming it", async () => {
    const { jobs, started } = jobsWith(() => undefined);
    const asking = askGenerate(jobs, OPTIONS);
    await expect(asking).rejects.toBeInstanceOf(UsageError);
    await expect(asking).rejects.toThrow("The dry run (job-1) is no longer known to the GUI.");
    expect(started).toEqual([{ command: "generate-preview", options: OPTIONS }]);
  });

  it("TC-GUI-022: a dry run that fails without a JSON message says it didn't finish, with its exit meaning", async () => {
    const ended = { id: "job-1", exitCode: 1, exitMeaning: "Failed", output: { lines: [] } } as unknown as JobView;
    const { jobs } = jobsWith(() => Promise.resolve(ended));
    await expect(askGenerate(jobs, OPTIONS)).rejects.toThrow("The dry run didn't finish: Failed.");
  });
});
