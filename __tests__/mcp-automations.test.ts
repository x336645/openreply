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

async function rpc(transport: WebStandardStreamableHTTPServerTransport, body: unknown) {
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

describe("MCP automations server", () => {
  it("initializes and lists 8 tools with JSON input schemas", async () => {
    const server = buildServer(fakeCtx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    const init = await rpc(transport, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(init.result.serverInfo.name).toBe("openreply");

    // Fresh server + transport per request in stateless mode
    const server2 = buildServer(fakeCtx);
    const transport2 = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server2.connect(transport2);
    const list = await rpc(transport2, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const names = list.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "automation_stats",
      "create_automation",
      "delete_automation",
      "get_automation",
      "get_contact",
      "list_automations",
      "list_contacts",
      "update_automation",
    ]);

    // Every tool must advertise a usable JSON input schema (not an empty object)
    for (const tool of list.result.tools) {
      expect(
        tool.inputSchema,
        `${tool.name} inputSchema`
      ).toHaveProperty("type", "object");
    }

    // create_automation must expose the real fields (from the shared schema)
    const create = list.result.tools.find(
      (t: { name: string }) => t.name === "create_automation"
    );
    expect(create.inputSchema.properties).toHaveProperty("name");
    expect(create.inputSchema.properties).toHaveProperty("dmMessage");
    expect(create.inputSchema.properties).toHaveProperty("keywords");
    expect(create.inputSchema.required).toContain("name");
    expect(create.inputSchema.required).toContain("dmMessage");

    // update_automation must include the id field
    const update = list.result.tools.find(
      (t: { name: string }) => t.name === "update_automation"
    );
    expect(update.inputSchema.properties).toHaveProperty("id");
    expect(update.inputSchema.properties).toHaveProperty("isActive");
  });

  it("rejects invalid create_automation input via shared schema refinements", async () => {
    const server = buildServer(fakeCtx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    // Missing post targeting AND no keywords: should fail the shared refinements
    const call = await rpc(transport, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "create_automation",
        arguments: { name: "x", dmMessage: "y" },
      },
    });
    expect(call.result.isError).toBe(true);
    const text = call.result.content[0].text as string;
    expect(text).toMatch(/Choose which post/);
  });
});
