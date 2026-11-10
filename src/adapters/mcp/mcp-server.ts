/** The only module that uses the MCP SDK (FR-MCP-006, FR-QUAL-021). Tools and resources come from the caller. */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { z } from "zod";
import { APPROVAL_TIMEOUT_MS } from "../../core/constants/workflow.js";

export interface ToolReply {
  readonly text: string;
  readonly isError: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  run(input: unknown): Promise<ToolReply>;
}

/** A resource at a fixed URI, or at a template with `{name}` in it. */
export interface ResourceDefinition {
  readonly name: string;
  readonly uri: string;
  readonly description: string;
  read(variables: Readonly<Record<string, string>>): Promise<string>;
}

export interface UserQuestion {
  readonly question: string;
  readonly answers: readonly string[];
  readonly isNotesAsked: boolean;
}

export type UserReply =
  | { readonly kind: "answered"; readonly answer: string; readonly notes: string | null }
  | { readonly kind: "declined" }
  | { readonly kind: "unsupported" };

export interface McpConnection {
  /** FR-MCP-028: asks the user through the host, with the answers as a fixed list. */
  askUser(question: UserQuestion): Promise<UserReply>;
  addTool(tool: ToolDefinition): void;
  addResource(resource: ResourceDefinition): void;
  /** Connects over stdio, or over the transport given, such as an in-memory one in tests. */
  connect(transport?: Transport): Promise<void>;
  /** Resolves when the host ends the session. */
  waitUntilClosed(): Promise<void>;
  close(): Promise<void>;
}

const TEMPLATE_VARIABLE = /\{\w+\}/;

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function createMcpServer(info: { readonly name: string; readonly version: string }): McpConnection {
  const server = new McpServer(info, { capabilities: { tools: {}, resources: {} } });
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  return {
    askUser: async ({ question, answers, isNotesAsked }) => {
      if (server.server.getClientCapabilities()?.elicitation === undefined) return { kind: "unsupported" };
      const result = await server.server.elicitInput(
        {
          message: question,
          requestedSchema: {
            type: "object",
            properties: {
              answer: { type: "string", title: "Answer", enum: [...answers] },
              ...(isNotesAsked ? { notes: { type: "string", title: "Notes for the agent" } } : {}),
            },
            required: ["answer"],
          },
        },
        // The SDK's default is a minute, too short for someone reviewing a spec or a preview.
        { timeout: APPROVAL_TIMEOUT_MS },
      );
      const answer = textOf(result.content?.["answer"]);
      if (result.action !== "accept" || answer === null || !answers.includes(answer)) return { kind: "declined" };
      return { kind: "answered", answer, notes: textOf(result.content?.["notes"]) };
    },
    addTool: (tool) => {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        async (input: unknown) => {
          const reply = await tool.run(input);
          return { content: [{ type: "text", text: reply.text }], isError: reply.isError };
        },
      );
    },
    addResource: (resource) => {
      const metadata = { description: resource.description, mimeType: "text/markdown" };
      if (!TEMPLATE_VARIABLE.test(resource.uri)) {
        server.registerResource(resource.name, resource.uri, metadata, async (uri) => ({
          contents: [{ uri: uri.href, text: await resource.read({}) }],
        }));
        return;
      }
      server.registerResource(
        resource.name,
        new ResourceTemplate(resource.uri, { list: undefined }),
        metadata,
        async (uri, variables) => {
          const flat = Object.fromEntries(
            Object.entries(variables).map(([key, value]) => [key, Array.isArray(value) ? value.join("/") : value]),
          );
          return { contents: [{ uri: uri.href, text: await resource.read(flat) }] };
        },
      );
    },
    connect: async (transport) => {
      if (transport !== undefined) {
        await server.connect(transport);
        return;
      }
      await server.connect(new StdioServerTransport());
      // The host ends a session by closing the server's stdin.
      process.stdin.once("end", () => void server.close());
    },
    waitUntilClosed: () => closed,
    close: () => server.close(),
  };
}
