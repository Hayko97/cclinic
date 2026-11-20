/** Job streams whose browser goes away (spec: gui, FR-GUI-034). */
import { EMPTY_CANVAS, NO_ANSWERS, NO_PLANNER } from "../support/helpers.js";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startGuiServer, type GuiServer } from "../../src/adapters/http/gui-server.js";
import { createJobs, type Jobs } from "../../src/application/gui-jobs.js";
import { createGuiHandler } from "../../src/application/gui-routes.js";
import type { OutputStream } from "../../src/core/gui.js";

const TOKEN = "t".repeat(43);
let server: GuiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("GUI event streams", () => {
  it("TC-GUI-047: a browser that leaves before the answer gets no stream opened", async () => {
    const open = vi.fn(() => () => undefined);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answered: Promise<void> = Promise.resolve();
    let received = (): void => undefined;
    const isReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    server = await startGuiServer({
      host: "127.0.0.1",
      port: 0,
      isPortFixed: false,
      handle: (request) => {
        // Answered at once, outside the gate: once its answer arrives, the server has also read the first socket's close.
        if (request.path === "/barrier")
          return Promise.resolve({ kind: "body" as const, status: 200, headers: {}, body: "" });
        received();
        const answer = gate.then(() => ({ kind: "events" as const, headers: {}, open }));
        answered = answer.then(() => undefined);
        return answer;
      },
    });
    const outgoing = httpRequest({ host: "127.0.0.1", port: server.port, path: "/x" });
    outgoing.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => {
      outgoing.on("socket", (socket) => {
        socket.on("close", () => {
          resolve();
        });
      });
    });
    outgoing.end();
    // The browser leaves only once the server has the request and is still working out the answer.
    await isReceived;
    outgoing.destroy();
    await closed;
    await new Promise<void>((resolve) => {
      httpRequest({ host: "127.0.0.1", port: server?.port, path: "/barrier" }, (response) => {
        response.resume();
        response.on("end", resolve);
      }).end();
    });
    release();
    await answered;
    await new Promise((resolve) => setImmediate(resolve));
    expect(open).not.toHaveBeenCalled();
  });

  it("TC-GUI-047: 30 streams opened and dropped while the job writes leave no subscriber behind", async () => {
    const outputs: ((stream: OutputStream, chunk: string) => void)[] = [];
    const real = createJobs({
      start: () => ({
        onOutput: (listener) => outputs.push(listener),
        onExit: () => undefined,
        signal: () => undefined,
      }),
      now: () => new Date(0),
      later: () => () => undefined,
    });
    let active = 0;
    const jobs: Jobs = {
      ...real,
      list: () => real.list(),
      start: (request) => real.start(request),
      subscribe: (id, listener) => {
        const subscription = real.subscribe(id, listener);
        if (subscription === undefined) return undefined;
        active += 1;
        let stopped = false;
        return {
          ...subscription,
          stop: () => {
            if (!stopped) active -= 1;
            stopped = true;
            subscription.stop();
          },
        };
      },
    };
    const handle = createGuiHandler({
      get port() {
        return server?.port ?? 0;
      },
      token: TOKEN,
      project: {
        name: "p",
        folder: "/nowhere",
        hasDocuments: () => false,
        readMcpConfig: () => Promise.resolve({ kind: "missing" as const }),
        isEmpty: () => Promise.resolve(false),
        newProject: () => Promise.resolve(null),
        readStyleGuide: () => Promise.resolve(undefined),
      },
      jobs,
      canvas: EMPTY_CANVAS,
      answers: NO_ANSWERS,
      planner: NO_PLANNER,
      readRunFiles: () => Promise.resolve(undefined),
      readAsset: () => Promise.resolve(""),
    });
    server = await startGuiServer({ host: "127.0.0.1", port: 0, isPortFixed: false, handle });
    const port = server.port;
    const headers = { host: `127.0.0.1:${port}`, "x-luseen-token": TOKEN };
    jobs.start({ command: "doctor" });
    const write = (text: string) => {
      for (const listener of outputs) listener("stdout", text);
    };
    for (let round = 0; round < 30; round += 1) {
      await new Promise<void>((resolve) => {
        const outgoing = httpRequest({ host: "127.0.0.1", port, path: "/api/jobs/job-1/events", headers });
        outgoing.on("response", (response) => {
          response.once("data", () => {
            outgoing.destroy();
            resolve();
          });
        });
        outgoing.on("error", () => undefined);
        outgoing.end();
      });
      write(`line ${round}\n`);
    }
    await vi.waitFor(() => {
      expect(active).toBe(0);
    });
    write("after\n");
    const job = await new Promise<number>((resolve) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port, path: "/api/jobs/job-1", headers }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      outgoing.end();
    });
    expect(job).toBe(200);
  });
});
