/** Answers each request to the local GUI: access first, then the route (spec: gui). */
import { HTTP_STATUS } from "../core/constants/gui.js";
import { UsageError } from "../core/errors.js";
import {
  checkAccess,
  jobRequestSchema,
  matchRoute,
  SECURITY_HEADERS,
  tokenCookie,
  type GuiRequest,
  type GuiResponse,
} from "../core/gui.js";
import type { Jobs } from "./gui-jobs.js";

export interface GuiProject {
  readonly name: string;
  readonly folder: string;
  readonly hasDocuments: () => boolean;
}

export interface GuiPorts {
  readonly port: number;
  readonly token: string;
  readonly project: GuiProject;
  readonly jobs: Jobs;
  /** One of the GUI's own bundled files, by name (FR-GUI-010). */
  readonly readAsset: (name: string) => Promise<string>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};
const JSON_TYPE = "application/json; charset=utf-8";

function json(status: number, data: unknown, headers: Readonly<Record<string, string>> = {}): GuiResponse {
  return {
    kind: "body",
    status,
    headers: { ...SECURITY_HEADERS, "content-type": JSON_TYPE, ...headers },
    body: JSON.stringify(data),
  };
}

async function file(
  ports: GuiPorts,
  name: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<GuiResponse> {
  const type = CONTENT_TYPES[name.slice(name.lastIndexOf(".") + 1)] ?? "text/plain; charset=utf-8";
  return {
    kind: "body",
    status: HTTP_STATUS.ok,
    headers: { ...SECURITY_HEADERS, "content-type": type, ...headers },
    body: await ports.readAsset(name),
  };
}

const NOT_FOUND = { error: "Not found." };

export function createGuiHandler(ports: GuiPorts): (request: GuiRequest) => Promise<GuiResponse> {
  return async (request) => {
    const access = checkAccess(request, ports);
    // FR-GUI-008: a refused request learns nothing about the project.
    if (access.kind === "denied")
      return json(access.status, {
        error:
          access.status === HTTP_STATUS.unauthorized ? "Open the GUI with the link cclinic gui printed." : "Forbidden.",
      });
    const route = matchRoute(request.method, request.path);
    if (route === undefined) return json(HTTP_STATUS.notFound, NOT_FOUND);
    switch (route.name) {
      case "page":
        return file(
          ports,
          "index.html",
          access.isFirstLoad ? { "set-cookie": tokenCookie(ports.port, ports.token) } : {},
        );
      case "asset":
        return file(ports, route.file);
      case "project":
        return json(HTTP_STATUS.ok, {
          name: ports.project.name,
          folder: ports.project.folder,
          hasDocuments: ports.project.hasDocuments(),
        });
      case "jobs":
        return json(HTTP_STATUS.ok, { jobs: ports.jobs.list() });
      case "start-job": {
        const parsed = jobRequestSchema.safeParse(await request.readBody());
        if (!parsed.success)
          return json(HTTP_STATUS.badRequest, {
            error: "That isn't a command the GUI can run.",
            issues: parsed.error.issues,
          });
        try {
          return json(HTTP_STATUS.created, { job: ports.jobs.start(parsed.data) });
        } catch (error) {
          if (error instanceof UsageError) return json(HTTP_STATUS.conflict, { error: error.message });
          throw error;
        }
      }
      case "job": {
        const job = ports.jobs.get(route.id);
        return job === undefined ? json(HTTP_STATUS.notFound, NOT_FOUND) : json(HTTP_STATUS.ok, { job });
      }
      case "job-events": {
        if (ports.jobs.get(route.id) === undefined) return json(HTTP_STATUS.notFound, NOT_FOUND);
        return {
          kind: "events",
          headers: SECURITY_HEADERS,
          open: (send, finish) => {
            const subscription = ports.jobs.subscribe(route.id, (event) => {
              send(event.type, event);
              if (event.type === "end") finish();
            });
            if (subscription === undefined) return () => undefined;
            send("job", { job: subscription.job });
            // A finished job has nothing more to send.
            if (!subscription.job.isRunning) finish();
            return subscription.stop;
          },
        };
      }
      case "cancel-job": {
        const outcome = ports.jobs.cancel(route.id);
        if (outcome === "unknown") return json(HTTP_STATUS.notFound, NOT_FOUND);
        return outcome === "ended"
          ? json(HTTP_STATUS.conflict, { error: `${route.id} has already ended.` })
          : json(HTTP_STATUS.accepted, { cancelling: route.id });
      }
    }
  };
}
