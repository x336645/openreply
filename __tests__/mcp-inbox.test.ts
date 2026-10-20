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

type ToolList = {
  result: {
    tools: Array<{
      name: string;
      inputSchema: {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
    }>;
  };
};

describe("MCP inbox tools", () => {
  it("lists the inbox tools with JSON input schemas", async () => {
    const transport = await connect();
    const list = (await rpc(transport, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })) as ToolList;
    const tools = list.result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_pending_messages");
    expect(names).toContain("send_dm_reply");
    expect(names).toContain("mark_message_handled");

    const pending = tools.find((t) => t.name === "list_pending_messages")!;
    expect(pending.inputSchema).toHaveProperty("type", "object");
    expect(pending.inputSchema.properties).toHaveProperty("instagramAccountId");
    expect(pending.inputSchema.properties).toHaveProperty("limit");

    const reply = tools.find((t) => t.name === "send_dm_reply")!;
    expect(reply.inputSchema).toHaveProperty("type", "object");
    expect(reply.inputSchema.properties).toHaveProperty("instagramAccountId");
    expect(reply.inputSchema.properties).toHaveProperty("recipientIgUserId");
    expect(reply.inputSchema.properties).toHaveProperty("text");
    expect(reply.inputSchema.required).toContain("instagramAccountId");
    expect(reply.inputSchema.required).toContain("recipientIgUserId");
    expect(reply.inputSchema.required).toContain("text");

    const mark = tools.find((t) => t.name === "mark_message_handled")!;
    expect(mark.inputSchema).toHaveProperty("type", "object");
    expect(mark.inputSchema.properties).toHaveProperty("id");
    expect(mark.inputSchema.properties).toHaveProperty("status");
    expect(mark.inputSchema.required).toContain("id");
    expect(mark.inputSchema.required).toContain("status");
  });

  it("mark_message_handled rejects a non-handled status via its input schema", async () => {
    const transport = await connect();
    const call = await rpc(transport, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "mark_message_handled",
        arguments: { id: "msg-1", status: "PENDING" },
      },
    });
    // SDK-side zod enum validation must reject PENDING (no DB call happens).
    expect(call.result?.isError ?? call.error).toBeTruthy();
  });

  it("send_dm_reply rejects empty text via its input schema", async () => {
    const transport = await connect();
    const call = await rpc(transport, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "send_dm_reply",
        arguments: {
          instagramAccountId: "acct-1",
          recipientIgUserId: "user-1",
          text: "",
        },
      },
    });
    // SDK-side zod validation must reject empty text (no send happens).
    expect(call.result?.isError ?? call.error).toBeTruthy();
  });

  it("list_pending_messages rejects an out-of-range limit via its input schema", async () => {
    const transport = await connect();
    const call = await rpc(transport, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_pending_messages", arguments: { limit: 0 } },
    });
    // SDK-side zod validation must reject limit < 1 (no DB call happens).
    expect(call.result?.isError ?? call.error).toBeTruthy();
  });
});
