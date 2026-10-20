import { NextResponse } from "next/server";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { prisma } from "@/lib/db/client";
import {
  createAutomationFields,
  createAutomationSchema,
  updateAutomationFields,
  updateAutomationSchema,
} from "@/lib/automation/schemas";
import {
  calculateCtr,
  CLICK_ROW_SELECT,
  countUniqueClicks,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "@/lib/tracking/analytics";
import {
  buildInitialCampaignLinks,
  syncCampaignLinks,
} from "@/lib/campaigns/links";
import { generateReportShareSlug } from "@/lib/reports/share";
import { sendInboxDmReply } from "@/lib/inbox/messages";
import { createBroadcast } from "@/lib/broadcast/broadcast";
import {
  canManageWorkspace,
  getApiKeyWorkspaceContext,
  type WorkspaceContext,
} from "@/lib/workspace-access";

// Never cache MCP responses at the route or CDN layer.
export const dynamic = "force-dynamic";

type TextContent = { type: "text"; text: string };

function ok(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) } as TextContent],
  };
}

function fail(message: string) {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: message }) } as TextContent,
    ],
    isError: true as const,
  };
}

function validationErrorMessage(error: z.ZodError) {
  return error.issues
    .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    .join("; ");
}

/**
 * Per-automation trigger/DM stats, computed the same way as the dashboard
 * and the automations REST endpoint (lib/tracking/analytics helpers).
 */
async function getAutomationStats(workspaceId: string, automationId: string) {
  const [statusRows, clickRows, keywordRows] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["status"],
      where: { workspaceId, automationId },
      _count: { _all: true },
    }),
    prisma.linkClick.findMany({
      where: { workspaceId, automationId },
      select: CLICK_ROW_SELECT,
    }),
    prisma.dmLog.groupBy({
      by: ["matchedKeyword"],
      where: { workspaceId, automationId, matchedKeyword: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const { sent, failed, skipped } = summarizeDmStatuses(statusRows);
  const clicks = countUniqueClicks(clickRows);
  return {
    sent,
    failed,
    skipped,
    clicks,
    ctr: calculateCtr(clicks, sent),
    topKeywords: normalizeTopKeywords(keywordRows, 5),
  };
}

/**
 * Build the MCP server for a workspace. Exported for testing (tools/list
 * exercises registration without touching the database).
 */
export function buildServer(ctx: WorkspaceContext) {
  const server = new McpServer({
    name: "openreply",
    version: "0.1.0",
  });
  const workspaceId = ctx.workspaceId;

  server.registerTool(
    "list_automations",
    {
      description:
        "List auto-reply campaigns (automations) in this workspace.",
      inputSchema: {
        activeOnly: z
          .boolean()
          .optional()
          .describe("Only list active campaigns"),
      },
    },
    async ({ activeOnly }) => {
      const automations = await prisma.automation.findMany({
        where: { workspaceId, ...(activeOnly ? { isActive: true } : {}) },
        select: {
          id: true,
          name: true,
          isActive: true,
          keywords: true,
          instagramAccountId: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      });
      return ok({ automations });
    }
  );

  server.registerTool(
    "get_automation",
    {
      description:
        "Get a single automation's details plus basic trigger/DM stats.",
      inputSchema: {
        id: z.string().describe("Automation ID"),
      },
    },
    async ({ id }) => {
      const automation = await prisma.automation.findFirst({
        where: { id, workspaceId },
        include: {
          instagramAccount: { select: { username: true } },
        },
      });
      if (!automation) return fail("Automation not found");
      const stats = await getAutomationStats(workspaceId, id);
      return ok({ automation, stats });
    }
  );

  server.registerTool(
    "create_automation",
    {
      description:
        "Create a new auto-reply campaign. Either target a specific post (postId), match any post (matchAnyPost), or bind to the next reel (pendingNextReel).",
      // Raw field shape so clients see a proper JSON input schema; the full
      // schema (with cross-field refinements) validates inside the handler.
      inputSchema: createAutomationFields,
    },
    async (args) => {
      const parsed = createAutomationSchema.safeParse(args);
      if (!parsed.success) {
        return fail(`Invalid input: ${validationErrorMessage(parsed.error)}`);
      }
      const data = parsed.data;

      const requestedInstagramAccountId =
        data.instagramAccountId && data.instagramAccountId !== "all"
          ? data.instagramAccountId
          : null;

      const [workspace, instagramAccount] = await Promise.all([
        prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { id: true },
        }),
        requestedInstagramAccountId
          ? prisma.instagramAccount.findFirst({
              where: { id: requestedInstagramAccountId, workspaceId },
            })
          : prisma.instagramAccount.findFirst({
              where: { workspaceId },
              orderBy: { connectedAt: "desc" },
            }),
      ]);

      if (!workspace) return fail("Workspace not found");
      if (!instagramAccount) {
        return fail("Connect Instagram before creating campaigns");
      }

      const linkCreates = buildInitialCampaignLinks({
        workspaceId,
        primaryUrl: data.trackedDestinationUrl,
        secondaryUrl: data.secondaryDestinationUrl,
        secondaryLabel: data.secondaryButtonLabel,
      });

      const { pendingNextReel, matchAnyPost, matchAnyWord, openingDmEnabled } =
        data;
      // A post is only stored for the "specific post" trigger.
      const isSpecificPost = !pendingNextReel && !matchAnyPost;
      const publicReplyList = (
        data.publicReplyMessages.length > 0
          ? data.publicReplyMessages
          : data.publicReplyMessage
            ? [data.publicReplyMessage]
            : []
      )
        .map((m) => m.trim())
        .filter(Boolean);

      const automation = await prisma.automation.create({
        data: {
          name: data.name,
          goal: data.goal,
          // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
          postId: isSpecificPost ? data.postId : null,
          postUrl: isSpecificPost ? data.postUrl : null,
          pendingNextReel,
          matchAnyPost,
          keywords: matchAnyWord ? [] : data.keywords,
          matchAnyWord,
          dmTriggerEnabled: data.dmTriggerEnabled,
          dmMessage: data.dmMessage,
          openingDmEnabled,
          openingDmMessage: openingDmEnabled
            ? data.openingDmMessage || null
            : null,
          openingDmButtonLabel: openingDmEnabled
            ? data.openingDmButtonLabel || null
            : null,
          linkButtonLabel: data.linkButtonLabel || null,
          requireFollow: data.requireFollow,
          followPromptMessage: data.requireFollow
            ? data.followPromptMessage || null
            : null,
          followPromptButtonLabel: data.requireFollow
            ? data.followPromptButtonLabel || null
            : null,
          followUpEnabled: data.followUpEnabled,
          followUpMessage: data.followUpEnabled ? data.followUpMessage || null : null,
          followUpDelayMinutes: data.followUpEnabled
            ? data.followUpDelayMinutes
            : 0,
          publicReplyEnabled: data.publicReplyEnabled,
          publicReplyMessages: data.publicReplyEnabled ? publicReplyList : [],
          publicReplyMessage: data.publicReplyEnabled
            ? (publicReplyList[0] ?? data.publicReplyMessage ?? null)
            : null,
          isActive: data.isActive,
          wholeWordMatch: data.wholeWordMatch,
          workspaceId,
          instagramAccountId: instagramAccount.id,
          reportShareSlug: generateReportShareSlug(),
          ...(linkCreates.length > 0
            ? { trackedLinks: { create: linkCreates } }
            : {}),
        },
      });

      return ok({ id: automation.id, name: automation.name });
    }
  );

  server.registerTool(
    "update_automation",
    {
      description:
        "Update an automation's fields (e.g. isActive toggle, keywords, dmMessage, publicReplyMessage).",
      inputSchema: {
        id: z.string().describe("Automation ID to update"),
        ...updateAutomationFields,
      },
    },
    async (args) => {
      const { id, ...rest } = args;
      const parsed = updateAutomationSchema.safeParse(rest);
      if (!parsed.success) {
        return fail(`Invalid input: ${validationErrorMessage(parsed.error)}`);
      }

      const existing = await prisma.automation.findFirst({
        where: { id, workspaceId },
      });
      if (!existing) return fail("Automation not found");

      const {
        trackedDestinationUrl,
        secondaryDestinationUrl,
        secondaryButtonLabel,
        ...automationData
      } = parsed.data;

      // Keep dependent fields consistent (same rules as the REST endpoint).
      if (automationData.matchAnyWord === true) automationData.keywords = [];
      if (automationData.openingDmEnabled === false) {
        automationData.openingDmMessage = null;
        automationData.openingDmButtonLabel = null;
      }
      if (automationData.requireFollow === false) {
        automationData.followPromptMessage = null;
        automationData.followPromptButtonLabel = null;
      }
      if (automationData.followUpEnabled === false) {
        automationData.followUpMessage = null;
        automationData.followUpDelayMinutes = 0;
      }
      if (
        automationData.matchAnyPost === true ||
        automationData.pendingNextReel === true
      ) {
        automationData.postId = null;
        automationData.postUrl = null;
      }
      if (automationData.publicReplyMessages !== undefined) {
        const list = automationData.publicReplyMessages
          .map((m) => m.trim())
          .filter(Boolean);
        automationData.publicReplyMessages = list;
        automationData.publicReplyMessage = list[0] ?? null;
      }
      if (automationData.publicReplyEnabled === false) {
        automationData.publicReplyMessages = [];
        automationData.publicReplyMessage = null;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const campaign = await tx.automation.update({
          where: { id },
          data: automationData,
        });

        await syncCampaignLinks(tx, {
          workspaceId,
          automationId: id,
          primaryUrl: trackedDestinationUrl,
          secondaryUrl: secondaryDestinationUrl,
          secondaryLabel: secondaryButtonLabel,
        });

        return campaign;
      });

      return ok({ id: updated.id, name: updated.name, isActive: updated.isActive });
    }
  );

  server.registerTool(
    "delete_automation",
    {
      description: "Delete an automation (campaign).",
      inputSchema: {
        id: z.string().describe("Automation ID to delete"),
      },
    },
    async ({ id }) => {
      const existing = await prisma.automation.findFirst({
        where: { id, workspaceId },
      });
      if (!existing) return fail("Automation not found");

      await prisma.automation.delete({ where: { id } });
      return ok({ deleted: true, id });
    }
  );

  server.registerTool(
    "automation_stats",
    {
      description:
        "Trigger/DM stats for one automation: sent, failed, skipped, unique link clicks, CTR, top keywords.",
      inputSchema: {
        id: z.string().describe("Automation ID"),
      },
    },
    async ({ id }) => {
      const existing = await prisma.automation.findFirst({
        where: { id, workspaceId },
        select: { id: true, name: true },
      });
      if (!existing) return fail("Automation not found");

      const stats = await getAutomationStats(workspaceId, id);
      return ok({ id: existing.id, name: existing.name, ...stats });
    }
  );

  server.registerTool(
    "list_contacts",
    {
      description:
        "List CRM contacts (people who commented or DM'd) in this workspace, most recently seen first. Optionally filter by tag.",
      inputSchema: {
        tag: z
          .string()
          .optional()
          .describe("Only contacts carrying this tag"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max contacts to return (default 50)"),
      },
    },
    async ({ tag, limit }) => {
      const contacts = await prisma.contact.findMany({
        where: { workspaceId, ...(tag ? { tags: { has: tag } } : {}) },
        select: {
          id: true,
          igUserId: true,
          username: true,
          displayName: true,
          tags: true,
          firstSeenAt: true,
          lastSeenAt: true,
          sourceAutomationId: true,
          instagramAccount: { select: { username: true } },
          sourceAutomation: { select: { name: true } },
        },
        orderBy: { lastSeenAt: "desc" },
        take: limit ?? 50,
      });
      return ok({ contacts });
    }
  );

  server.registerTool(
    "get_contact",
    {
      description:
        "Get a single CRM contact by contact ID or Instagram user ID, plus a summary of its DM interactions.",
      inputSchema: {
        id: z.string().optional().describe("Contact ID"),
        igUserId: z
          .string()
          .optional()
          .describe("Instagram user ID (IGSID) of the contact"),
      },
    },
    async ({ id, igUserId }) => {
      if (!id && !igUserId) {
        return fail("Provide either id or igUserId");
      }
      const contact = await prisma.contact.findFirst({
        where: { workspaceId, ...(id ? { id } : { igUserId }) },
        include: {
          instagramAccount: { select: { username: true } },
          sourceAutomation: { select: { name: true } },
        },
      });
      if (!contact) return fail("Contact not found");

      const statusRows = await prisma.dmLog.groupBy({
        by: ["status"],
        where: {
          workspaceId,
          instagramAccountId: contact.instagramAccountId,
          commenterId: contact.igUserId,
        },
        _count: { _all: true },
      });
      const byStatus = Object.fromEntries(
        statusRows.map((r) => [r.status, r._count._all])
      );
      const totalInteractions = statusRows.reduce(
        (sum, r) => sum + r._count._all,
        0
      );

      return ok({
        contact,
        interactions: { total: totalInteractions, byStatus },
      });
    }
  );

  server.registerTool(
    "list_pending_messages",
    {
      description:
        "List incoming Instagram DMs in this workspace that no campaign has handled yet (inbox status PENDING), newest first. Read these, draft replies, then answer with send_dm_reply or dismiss with mark_message_handled.",
      inputSchema: {
        instagramAccountId: z
          .string()
          .optional()
          .describe("Only messages for this Instagram account (internal account ID)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max messages to return (default 50)"),
      },
    },
    async ({ instagramAccountId, limit }) => {
      const messages = await prisma.inboxMessage.findMany({
        where: {
          workspaceId,
          status: "PENDING",
          ...(instagramAccountId ? { instagramAccountId } : {}),
        },
        select: {
          id: true,
          senderId: true,
          senderUsername: true,
          text: true,
          receivedAt: true,
          instagramAccountId: true,
          instagramAccount: { select: { username: true } },
        },
        orderBy: { receivedAt: "desc" },
        take: limit ?? 50,
      });
      return ok({ messages });
    }
  );

  server.registerTool(
    "send_dm_reply",
    {
      description:
        "Send a DM reply to an Instagram user from one of this workspace's accounts, via the same provider send path the automation worker uses. Afterwards the sender's latest pending inbox message is marked REPLIED with this text.",
      inputSchema: {
        instagramAccountId: z
          .string()
          .describe("Internal Instagram account ID to send from"),
        recipientIgUserId: z
          .string()
          .describe("Recipient's Instagram user ID (IGSID)"),
        text: z.string().min(1).max(1000).describe("Reply text"),
      },
    },
    async ({ instagramAccountId, recipientIgUserId, text }) => {
      try {
        const result = await sendInboxDmReply({
          workspaceId,
          instagramAccountId,
          recipientIgUserId,
          text,
        });
        return ok(result);
      } catch (error) {
        return fail(
          error instanceof Error ? error.message : "Failed to send DM reply"
        );
      }
    }
  );

  server.registerTool(
    "mark_message_handled",
    {
      description:
        "Mark an inbox message as handled without sending a reply: REPLIED when it was answered elsewhere, IGNORED to dismiss it.",
      inputSchema: {
        id: z.string().describe("Inbox message ID"),
        status: z
          .enum(["REPLIED", "IGNORED"])
          .describe("New status for the message"),
      },
    },
    async ({ id, status }) => {
      const existing = await prisma.inboxMessage.findFirst({
        where: { id, workspaceId },
        select: { id: true },
      });
      if (!existing) return fail("Inbox message not found");

      const updated = await prisma.inboxMessage.update({
        where: { id },
        data: {
          status,
          ...(status === "REPLIED" ? { repliedAt: new Date() } : {}),
        },
        select: { id: true, status: true },
      });
      return ok(updated);
    }
  );

  server.registerTool(
    "create_broadcast",
    {
      description:
        "Create a DM broadcast to a segment of CRM contacts: every contact of the account, or only contacts carrying targetTag. Recipients are snapshotted at creation and the send runs asynchronously on the worker queue; poll get_broadcast for progress. Contacts outside Instagram's 24h messaging window will fail their delivery (counted in failedCount).",
      inputSchema: {
        name: z.string().min(1).max(100).describe("Broadcast name"),
        instagramAccountId: z
          .string()
          .describe("Internal Instagram account ID to send from"),
        message: z.string().min(1).max(1000).describe("DM text to broadcast"),
        targetTag: z
          .string()
          .min(1)
          .optional()
          .describe("Only contacts carrying this tag (omit for all contacts)"),
      },
    },
    async ({ name, instagramAccountId, message, targetTag }) => {
      try {
        const result = await createBroadcast({
          workspaceId,
          instagramAccountId,
          name,
          message,
          targetTag: targetTag ?? null,
        });
        return ok(result);
      } catch (error) {
        return fail(
          error instanceof Error ? error.message : "Failed to create broadcast"
        );
      }
    }
  );

  server.registerTool(
    "get_broadcast",
    {
      description:
        "Get one broadcast's status and counters, plus a delivery breakdown and the most recent failure reasons.",
      inputSchema: {
        id: z.string().describe("Broadcast ID"),
      },
    },
    async ({ id }) => {
      const broadcast = await prisma.broadcast.findFirst({
        where: { id, workspaceId },
        include: {
          instagramAccount: { select: { username: true } },
        },
      });
      if (!broadcast) return fail("Broadcast not found");

      const [statusRows, recentFailures] = await Promise.all([
        prisma.broadcastDelivery.groupBy({
          by: ["status"],
          where: { broadcastId: id },
          _count: { _all: true },
        }),
        prisma.broadcastDelivery.findMany({
          where: { broadcastId: id, status: "FAILED" },
          select: {
            errorMessage: true,
            contact: { select: { igUserId: true, username: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 10,
        }),
      ]);
      const deliveries = Object.fromEntries(
        statusRows.map((r) => [r.status, r._count._all])
      );

      return ok({ broadcast, deliveries, recentFailures });
    }
  );

  server.registerTool(
    "list_broadcasts",
    {
      description:
        "List recent DM broadcasts in this workspace, newest first, with status and sent/failed counters.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max broadcasts to return (default 20)"),
      },
    },
    async ({ limit }) => {
      const broadcasts = await prisma.broadcast.findMany({
        where: { workspaceId },
        select: {
          id: true,
          name: true,
          status: true,
          targetTag: true,
          totalCount: true,
          sentCount: true,
          failedCount: true,
          instagramAccountId: true,
          createdAt: true,
          completedAt: true,
          instagramAccount: { select: { username: true } },
        },
        orderBy: { createdAt: "desc" },
        take: limit ?? 20,
      });
      return ok({ broadcasts });
    }
  );

  return server;
}

export async function POST(request: Request) {
  // API key auth only (same mechanism as the automations REST endpoint).
  const apiKey = request.headers.get("x-api-key");
  const ctx = await getApiKeyWorkspaceContext(apiKey);
  if (!ctx || !canManageWorkspace(ctx.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Stateless mode: fresh transport per request, JSON responses.
  const server = buildServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function GET() {
  return NextResponse.json(
    { error: "Use POST with the X-API-Key header for MCP requests." },
    { status: 405 }
  );
}

export async function DELETE() {
  return NextResponse.json(
    { error: "Use POST with the X-API-Key header for MCP requests." },
    { status: 405 }
  );
}
