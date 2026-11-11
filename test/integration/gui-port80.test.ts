/** The GUI's real HTTP server, with its handler told it's on port 80 (spec: gui, FR-GUI-009). */
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startGuiServer, type GuiServer } from "../../src/adapters/http/gui-server.js";
import { createJobs } from "../../src/application/gui-jobs.js";
import { createGuiHandler } from "../../src/application/gui-routes.js";

const TOKEN = "t".repeat(43);
let server: GuiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function send(port: number, method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: text });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

describe("GUI on port 80", () => {
  it("TC-GUI-014: on port 80 the host and origin are accepted with and without :80", async () => {
    const started: string[][] = [];
    const jobs = createJobs({
      start: (args) => {
        started.push([...args]);
        return { onOutput: () => undefined, onExit: () => undefined, signal: () => undefined };
      },
      now: () => new Date(0),
      later: () => () => undefined,
    });
    const handle = createGuiHandler({
      port: 80,
      token: TOKEN,
      project: { name: "p", folder: "/nowhere", hasDocuments: () => false },
      jobs,
      readAsset: () => Promise.resolve("<html></html>"),
    });
    server = await startGuiServer({ host: "127.0.0.1", port: 0, isPortFixed: true, handle });
    const port = server.port;
    const auth = { "x-cclinic-token": TOKEN };

    expect((await send(port, "GET", "/api/project", { host: "127.0.0.1", ...auth })).status).toBe(200);
    expect((await send(port, "GET", "/api/project", { host: "127.0.0.1:80", ...auth })).status).toBe(200);
    expect((await send(port, "GET", "/api/project", { host: "localhost", ...auth })).status).toBe(200);
    expect((await send(port, "GET", "/api/project", { host: "127.0.0.1:81", ...auth })).status).toBe(403);
    expect((await send(port, "GET", "/api/project", { host: "evil.example", ...auth })).status).toBe(403);

    const body = JSON.stringify({ command: "doctor" });
    const post = (origin: string) =>
      send(port, "POST", "/api/jobs", { host: "127.0.0.1", origin, "content-type": "application/json", ...auth }, body);
    const allowed = await post("http://127.0.0.1");
    expect(allowed.status).toBe(201);
    expect(started).toHaveLength(1);
    expect((await post("http://127.0.0.1:80")).status).toBe(201);
    expect((await post("http://evil.example")).status).toBe(403);
    expect((await post("http://127.0.0.1:81")).status).toBe(403);
  });
});
