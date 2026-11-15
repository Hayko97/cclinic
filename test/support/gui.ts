/** Starts `luseen gui` in-process for a test, and sends it raw requests. */
import { request as httpRequest } from "node:http";
import { vi } from "vitest";
import { runGuiCommand, type GuiDependencies, type GuiOptions } from "../../src/cli/gui-command.js";
import { agentHarness } from "./helpers.js";

export interface TestGui {
  readonly port: number;
  readonly token: string;
  readonly harness: ReturnType<typeof agentHarness>;
  stop(): Promise<void>;
}

export async function startTestGui(
  root: string,
  options: Partial<GuiOptions> = {},
  dependencies: GuiDependencies = {},
  environment: NodeJS.ProcessEnv = {},
): Promise<TestGui> {
  const harness = agentHarness({ withClaude: false, env: environment });
  const done = runGuiCommand(
    undefined,
    { dir: root, open: false, json: true, port: 0, ...options },
    harness.context,
    dependencies,
  );
  const failed = done.then(() => {
    throw new Error("The GUI stopped before printing its link.");
  });
  const ready = vi.waitFor(
    () => {
      const line = harness.output.out.trim();
      if (line === "") throw new Error("no link yet");
      return JSON.parse(line) as { url: string; port: number };
    },
    { timeout: 10_000 },
  );
  const { url, port } = await Promise.race([ready, failed]);
  return {
    port,
    token: new URL(url).searchParams.get("token") ?? "",
    harness,
    stop: async () => {
      harness.controller.abort();
      await done;
    },
  };
}

export interface Reply {
  readonly status: number;
  readonly body: string;
}

/** A raw request with the token, so the path is sent exactly as written. */
export function sendTo(gui: TestGui, method: string, requestPath: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: gui.port,
        method,
        path: requestPath,
        headers: {
          host: `127.0.0.1:${gui.port}`,
          "x-luseen-token": gui.token,
          ...(text === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (response) => {
        let received = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (received += chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: received });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(text);
  });
}

/** Opens an event stream, and collects each event's name and data until stopped. */
export function openStream(gui: TestGui, requestPath: string) {
  const events: { readonly event: string; readonly data: unknown }[] = [];
  let buffer = "";
  const outgoing = httpRequest({
    host: "127.0.0.1",
    port: gui.port,
    path: requestPath,
    headers: { host: `127.0.0.1:${gui.port}`, "x-luseen-token": gui.token },
  });
  outgoing.on("response", (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = /^event: (.+)$/m.exec(block)?.[1] ?? "";
        events.push({ event, data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null") as unknown });
      }
    });
  });
  outgoing.on("error", () => undefined);
  outgoing.end();
  return { events, close: () => outgoing.destroy() };
}
