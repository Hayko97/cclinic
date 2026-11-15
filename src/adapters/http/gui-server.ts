/** The local GUI's HTTP server, on node:http, with Server-Sent Events (spec: gui, FR-GUI-002, FR-GUI-034). */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUI_ASSETS, GUI_MAX_BODY_BYTES, GUI_MAX_UPLOAD_BODY_BYTES, HTTP_STATUS } from "../../core/constants/gui.js";
import { CclinicError, UsageError } from "../../core/errors.js";
import { SECURITY_HEADERS, type GuiRequest, type GuiResponse } from "../../core/gui.js";

export interface GuiServer {
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

export interface GuiServerOptions {
  readonly host: string;
  readonly port: number;
  /** When the port was chosen with --port, a taken port is an error; otherwise a free one is used. */
  readonly isPortFixed: boolean;
  readonly handle: (request: GuiRequest) => Promise<GuiResponse>;
}

class BodyTooLarge extends CclinicError {}

/**
 * The JSON body, up to `maxBytes`, which only the route reading it chooses (FR-PLAN-033). The rest of a larger body
 * is read and dropped, up to the largest any route takes, so the refusal reaches the browser; beyond that, the
 * connection is cut.
 */
function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > GUI_MAX_UPLOAD_BODY_BYTES) {
        request.destroy();
        reject(new BodyTooLarge("The request is too large."));
      } else if (size <= maxBytes) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > maxBytes) {
        reject(new BodyTooLarge("The request is too large."));
        return;
      }
      if (size === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        // Not JSON: the route's own check refuses it.
        resolve(null);
      }
    });
    request.once("error", reject);
  });
}

function writeBody(
  response: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>>,
  body: string | Uint8Array,
) {
  response.writeHead(status, { ...headers, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function failure(response: ServerResponse, status: number, message: string): void {
  writeBody(
    response,
    status,
    { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" },
    JSON.stringify({ error: message }),
  );
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  handle: GuiServerOptions["handle"],
): Promise<void> {
  // Read as a path on a fixed host, so "/../", "%2e%2e" and "//host/..." can't leave the GUI's own paths.
  const target = request.url ?? "";
  const url = new URL(target.startsWith("/") ? `http://gui.invalid${target}` : "http://gui.invalid/-");
  let body: Promise<unknown> | undefined;
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value]),
  );
  const answer = await handle({
    method: request.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    readBody: (maxBytes = GUI_MAX_BODY_BYTES) => (body ??= readBody(request, maxBytes)),
  });
  // A body nobody read is drained, not kept.
  if (body === undefined) request.resume();
  if (answer.kind === "body") {
    writeBody(response, answer.status, answer.headers, answer.body);
    return;
  }
  // The browser may have left while the answer was being worked out.
  if (response.destroyed) return;
  response.writeHead(HTTP_STATUS.ok, {
    ...answer.headers,
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive",
  });
  const stop = answer.open(
    (event, data) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    () => {
      response.end();
    },
  );
  // The response, not the request, reports the browser going away: the request has ended by now.
  response.on("close", stop);
}

function listen(server: ReturnType<typeof createServer>, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startGuiServer(options: GuiServerOptions): Promise<GuiServer> {
  const server = createServer((request, response) => {
    serve(request, response, options.handle).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof BodyTooLarge) failure(response, HTTP_STATUS.tooLarge, "The request is too large.");
      else failure(response, HTTP_STATUS.internalError, "Something unexpected went wrong.");
    });
  });
  try {
    await listen(server, options.host, options.port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" && !options.isPortFixed) await listen(server, options.host, 0);
    else if (code === "EADDRINUSE" || code === "EACCES")
      throw new UsageError(
        `Port ${options.port} ${code === "EADDRINUSE" ? "is in use" : "isn't allowed"}. Choose another with --port, or 0 for any free port.`,
        { cause: error },
      );
    else throw error;
  }
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    host: address.address,
    close: () =>
      new Promise((resolve) => {
        // Event streams stay open, so they're closed too.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Reads the GUI's bundled files: from `dist/gui` once built, or from `src/gui` while developing.
 * Only the names in GUI_ASSETS are ever read (FR-GUI-010).
 */
export function createAssetReader(): (name: string) => Promise<string> {
  const candidates = ["gui", "../../gui"].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
  const folder = candidates.find((candidate) => existsSync(path.join(candidate, GUI_ASSETS.page)));
  const allowed: ReadonlySet<string> = new Set([GUI_ASSETS.page, ...GUI_ASSETS.files]);
  return async (name) => {
    if (folder === undefined || !allowed.has(name)) throw new UsageError(`The GUI's file ${name} is missing.`);
    return readFile(path.join(folder, name), "utf8");
  };
}
