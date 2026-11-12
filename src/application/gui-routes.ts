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
import {
  findSession,
  readCanvas,
  readSessionTranscript,
  saveCanvasLayout,
  streamCanvas,
  streamTranscript,
  tidyCanvasFrame,
  type CanvasPorts,
} from "./gui-canvas.js";
import { ENVIRONMENT_CONSENT_MESSAGE } from "../core/environment.js";
import { mcpInfo, type McpFile } from "../core/gui-setup.js";
import { LIMITS } from "../core/constants/limits.js";
import { PROVIDER_CHOICES } from "../core/constants/llm.js";
import { ENVIRONMENT_MAX_BUDGET_USD } from "../core/constants/environment.js";
import { answerChange, type AnswerPorts } from "./gui-answers.js";
import type { Jobs } from "./gui-jobs.js";
import { askGenerate } from "./gui-setup.js";

export interface GuiProject {
  readonly name: string;
  readonly folder: string;
  readonly hasDocuments: () => boolean;
  /** FR-GUI-018: the project's `.mcp.json`, if any. */
  readonly readMcpConfig: () => Promise<McpFile>;
}

export interface GuiPorts {
  readonly port: number;
  readonly token: string;
  readonly project: GuiProject;
  readonly jobs: Jobs;
  /** One of the GUI's own bundled files, by name (FR-GUI-010). */
  readonly readAsset: (name: string) => Promise<string>;
  readonly canvas: CanvasPorts;
  /** FR-GUI-038: the changes' saved states, to answer a waiting question. */
  readonly answers: AnswerPorts;
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
      case "setup":
        // FR-GUI-014, FR-GUI-017, FR-GUI-018: what Setup shows besides its jobs.
        return json(HTTP_STATUS.ok, {
          hasDocuments: ports.project.hasDocuments(),
          environmentConsent: ENVIRONMENT_CONSENT_MESSAGE,
          mcp: mcpInfo(await ports.project.readMcpConfig()),
          // The CLI's own defaults and choices, so the page never keeps a copy that goes stale.
          defaults: {
            limits: Object.fromEntries(Object.entries(LIMITS).map(([name, limit]) => [name, limit.default])),
            environmentBudgetUsd: ENVIRONMENT_MAX_BUDGET_USD,
            providers: PROVIDER_CHOICES,
          },
        });
      case "start-job": {
        const parsed = jobRequestSchema.safeParse(await request.readBody());
        if (!parsed.success) {
          // FR-GUI-015: an option value the CLI would refuse is named in the CLI's own words.
          const refused = parsed.error.issues.find((issue) => issue.code === "custom");
          return json(HTTP_STATUS.badRequest, {
            error: refused?.message ?? "That isn't a command the GUI can run.",
            issues: parsed.error.issues,
          });
        }
        try {
          // FR-GUI-016: unanswered, generate gets the CLI's questions back, and no generate job starts.
          if (parsed.data.command === "generate" && !parsed.data.confirmed)
            return json(HTTP_STATUS.ok, await askGenerate(ports.jobs, parsed.data.options));
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
      case "canvas":
        return json(HTTP_STATUS.ok, await readCanvas(ports.canvas));
      case "canvas-events":
        return { kind: "events", headers: SECURITY_HEADERS, open: (send) => streamCanvas(ports.canvas, send) };
      case "save-layout": {
        const layout = await saveCanvasLayout(ports.canvas, await request.readBody());
        return layout === undefined
          ? json(HTTP_STATUS.badRequest, { error: "That isn't a canvas layout." })
          : json(HTTP_STATUS.ok, { layout });
      }
      case "tidy-layout": {
        const tidied = await tidyCanvasFrame(ports.canvas, await request.readBody());
        if (tidied.status === "done") return json(HTTP_STATUS.ok, { layout: tidied.layout });
        return tidied.status === "unknown"
          ? json(HTTP_STATUS.notFound, NOT_FOUND)
          : json(HTTP_STATUS.badRequest, { error: "That isn't a frame on the canvas." });
      }
      case "session": {
        const session = await findSession(ports.canvas, route.id);
        if (session === undefined) return json(HTTP_STATUS.notFound, NOT_FOUND);
        return json(HTTP_STATUS.ok, { session, transcript: await readSessionTranscript(ports.canvas, session) });
      }
      case "session-events": {
        const session = await findSession(ports.canvas, route.id);
        if (session === undefined) return json(HTTP_STATUS.notFound, NOT_FOUND);
        return {
          kind: "events",
          headers: SECURITY_HEADERS,
          open: (send) => streamTranscript(ports.canvas, session, send),
        };
      }
      case "answer": {
        let result: Awaited<ReturnType<typeof answerChange>>;
        try {
          result = await answerChange(ports.answers, route.key, await request.readBody());
        } catch (error) {
          // A workflow state that can't be read is named, with how to fix it, as `cclinic approve` names it.
          if (error instanceof UsageError) return json(HTTP_STATUS.conflict, { error: error.message });
          throw error;
        }
        switch (result.status) {
          case "answered":
            return json(HTTP_STATUS.ok, { message: result.message });
          case "unknown":
            return json(HTTP_STATUS.notFound, NOT_FOUND);
          case "invalid":
            return json(HTTP_STATUS.badRequest, { error: result.message });
          case "changed":
            return json(HTTP_STATUS.conflict, { error: result.message });
        }
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
