/** QA run 3 probes for FR-GUI-011 and FR-GUI-033 (stage B). */
import { describe, expect, it } from "vitest";
import { createJobs, type JobProcess } from "../../src/application/gui-jobs.js";
import { JOB_CANCEL_GRACE_MS } from "../../src/core/constants/gui.js";
import { SHUTDOWN_TIMEOUT_MS } from "../../src/core/constants/limits.js";
import type { OutputStream } from "../../src/core/gui.js";

function harness() {
  const outputs: ((stream: OutputStream, chunk: string) => void)[] = [];
  const exits: ((code: number) => void)[] = [];
  const delays: number[] = [];
  const process: JobProcess = {
    onOutput: (listener) => outputs.push(listener),
    onExit: (listener) => exits.push(listener),
    signal: () => undefined,
  };
  const jobs = createJobs({
    start: () => process,
    now: () => new Date(0),
    later: (ms) => {
      delays.push(ms);
      return () => undefined;
    },
  });
  const events: string[] = [];
  jobs.start({ command: "doctor" });
  jobs.subscribe("job-1", (event) => events.push(JSON.stringify(event)));
  return {
    jobs,
    delays,
    events,
    write: (stream: OutputStream, text: string) => {
      outputs.forEach((listener) => {
        listener(stream, text);
      });
    },
    exit: (code: number) => {
      exits.forEach((listener) => {
        listener(code);
      });
    },
  };
}

const seen = (h: ReturnType<typeof harness>) => JSON.stringify(h.jobs.get("job-1")) + h.events.join("");

describe("QA probes", () => {
  it("TC-GUI-046 probe: the default grace is the CLI's clean stop plus a margin", () => {
    expect(JOB_CANCEL_GRACE_MS).toBeGreaterThan(SHUTDOWN_TIMEOUT_MS);
    const h = harness();
    h.jobs.cancel("job-1");
    expect(h.delays).toEqual([JOB_CANCEL_GRACE_MS]);
  });

  it.each([
    ["OPENSSH", "-----BEGIN OPENSSH PRIVATE KEY-----", "-----END OPENSSH PRIVATE KEY-----"],
    ["ENCRYPTED", "-----BEGIN ENCRYPTED PRIVATE KEY-----", "-----END ENCRYPTED PRIVATE KEY-----"],
    ["PKCS8", "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"],
  ])("TC-GUI-016 probe: a %s key with CRLF line ends, split one char per chunk, never leaks", (_name, begin, end) => {
    const h = harness();
    const text = `ok\r\n${begin}\r\nSECRETbodyLINE1\r\nSECRETbodyLINE2\r\n${end}\r\nafter\r\n`;
    for (const char of text) h.write("stderr", char);
    h.exit(0);
    expect(seen(h)).not.toContain("SECRETbody");
    expect(h.jobs.get("job-1")?.output.lines.map((line) => line.text.replace(/\r$/, ""))).toEqual([
      "ok",
      "[REDACTED:private-key]",
      "[REDACTED:private-key]",
      "[REDACTED:private-key]",
      "[REDACTED:private-key]",
      "after",
    ]);
  });

  it("TC-GUI-016 probe: stdout and stderr interleaved keep their own key state", () => {
    const h = harness();
    h.write("stdout", "-----BEGIN RSA PRIVATE KEY-----\nSECRETa\n");
    h.write("stderr", "plain stderr\n");
    h.write("stdout", "SECRETb\n-----END RSA PRIVATE KEY-----\nvisible\n");
    expect(seen(h)).not.toContain("SECRET");
    const texts = h.jobs.get("job-1")?.output.lines.map((line) => `${line.stream}:${line.text}`);
    expect(texts).toContain("stderr:plain stderr");
    expect(texts).toContain("stdout:visible");
  });

  it("TC-GUI-016 probe: a key whose END never arrives is redacted up to the job's end, including the last partial line", () => {
    const h = harness();
    h.write("stdout", "-----BEGIN EC PRIVATE KEY-----\nSECRETx\nSECRETtail");
    h.exit(1);
    expect(seen(h)).not.toContain("SECRET");
  });

  it("TC-GUI-016 probe: a one-line key and a key with text around it are redacted", () => {
    const h = harness();
    h.write("stdout", 'msg "-----BEGIN RSA PRIVATE KEY-----\\nSECRETz\\n-----END RSA PRIVATE KEY-----" end\n');
    h.write("stdout", "prefix -----BEGIN RSA PRIVATE KEY-----\nSECRETy\n-----END RSA PRIVATE KEY----- suffix\n");
    expect(seen(h)).not.toContain("SECRET");
  });
});
