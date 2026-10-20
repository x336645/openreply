import { describe, expect, it, vi } from "vitest";

// Cut the next-auth import chain (route -> workspace-access -> lib/auth -> next-auth),
// which vitest cannot resolve.
vi.mock("@/lib/auth", () => ({
  getCurrentUserId: async () => null,
  getCurrentWorkspaceId: async () => null,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "../app/api/mcp/route";
import type { WorkspaceContext } from "@/lib/workspace-access";

const fakeCtx = {
  userId: "test-user",
  workspaceId: "test-workspace",
  workspace: {},
  role: "OWNER",
} as unknown as WorkspaceContext;

async function connect() {
  const server = buildServer(fakeCtx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport;
}

async function rpc(
  transport: WebStandardStreamableHTTPServerTransport,
  body: unknown
) {
  const req = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const res = await transport.handleRequest(req);
  return res.json();
}

describe("MCP contacts tools", () => {
  it("lists list_contacts and get_contact with JSON input schemas", async () => {
    const transport = await connect();
    const list = await rpc(transport, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = list.result.tools as Array<{
      name: string;
      inputSchema: {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
    }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_contacts");
    expect(names).toContain("get_contact");

    const listContacts = tools.find((t) => t.name === "list_contacts")!;
    expect(listContacts.inputSchema).toHaveProperty("type", "object");
    expect(listContacts.inputSchema.properties).toHaveProperty("tag");
    expect(listContacts.inputSchema.properties).toHaveProperty("limit");

    const getContact = tools.find((t) => t.name === "get_contact")!;
    expect(getContact.inputSchema).toHaveProperty("type", "object");
    expect(getContact.inputSchema.properties).toHaveProperty("id");
    expect(getContact.inputSchema.properties).toHaveProperty("igUserId");
  });

  it("get_contact without id or igUserId fails before touching the database", async () => {
    const transport = await connect();
    const call = await rpc(transport, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_contact", arguments: {} },
    });
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text as string).toMatch(
      /Provide either id or igUserId/
    );
  });

  it("list_contacts rejects an out-of-range limit via its input schema", async () => {
    const transport = await connect();
    const call = await rpc(transport, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_contacts", arguments: { limit: 0 } },
    });
    // SDK-side zod validation must reject limit < 1 (no DB call happens).
    expect(call.result?.isError ?? call.error).toBeTruthy();
  });
});
