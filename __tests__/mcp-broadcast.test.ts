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

describe("MCP broadcast tools", () => {
  it("lists the broadcast tools with JSON input schemas", async () => {
    const transport = await connect();
    const list = (await rpc(transport, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })) as ToolList;
    const tools = list.result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_broadcast");
    expect(names).toContain("get_broadcast");
    expect(names).toContain("list_broadcasts");

    const create = tools.find((t) => t.name === "create_broadcast")!;
    expect(create.inputSchema).toHaveProperty("type", "object");
    expect(create.inputSchema.properties).toHaveProperty("name");
    expect(create.inputSchema.properties).toHaveProperty("instagramAccountId");
    expect(create.inputSchema.properties).toHaveProperty("message");
    expect(create.inputSchema.properties).toHaveProperty("targetTag");
    expect(create.inputSchema.required).toContain("name");
    expect(create.inputSchema.required).toContain("instagramAccountId");
    expect(create.inputSchema.required).toContain("message");
    expect(create.inputSchema.required).not.toContain("targetTag");

    const get = tools.find((t) => t.name === "get_broadcast")!;
    expect(get.inputSchema).toHaveProperty("type", "object");
    expect(get.inputSchema.properties).toHaveProperty("id");
    expect(get.inputSchema.required).toContain("id");

    const listTool = tools.find((t) => t.name === "list_broadcasts")!;
    expect(listTool.inputSchema).toHaveProperty("type", "object");
    expect(listTool.inputSchema.properties).toHaveProperty("limit");
  });

  it("create_broadcast rejects an empty message via its input schema", async () => {
    const transport = await connect();
    const call = await rpc(transport, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "create_broadcast",
        arguments: {
          name: "October promo",
          instagramAccountId: "acct-1",
          message: "",
        },
      },
    });
    // SDK-side zod validation must reject empty message (no DB call happens).
    expect(call.result?.isError ?? call.error).toBeTruthy();
  });

  it("create_broadcast rejects an empty name via its input schema", async () => {
    const transport = await connect();
    const call = await rpc(transport, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "create_broadcast",
        arguments: {
          name: "",
          instagramAccountId: "acct-1",
          message: "Hello",
        },
      },
    });
    // SDK-side zod validation must reject empty name (no DB call happens).
    expect(call.result?.isError ?? call.error).toBeTruthy();
  });

  it("list_broadcasts rejects an out-of-range limit via its input schema", async () => {
    const transport = await connect();
    const call = await rpc(transport, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_broadcasts", arguments: { limit: 0 } },
    });
    // SDK-side zod validation must reject limit < 1 (no DB call happens).
    expect(call.result?.isError ?? call.error).toBeTruthy();
  });
});
