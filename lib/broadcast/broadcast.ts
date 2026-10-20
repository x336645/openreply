import { prisma } from "@/lib/db/client";
import { BROADCAST_JOB_NAME, getDMQueue } from "@/lib/queue/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
  sendDirectMessage,
} from "@/lib/instagram/provider";
import { releaseDMSlot, reserveDMSlot } from "@/lib/utils/rate-limiter";

// Pause between two broadcast sends. A broadcast is bulk by nature and
// Instagram punishes bursts (rate limits, spam heuristics, closed messaging
// windows), so the batch drips at a human pace instead of looping tightly.
// The hourly per-account cap is still enforced per send via reserveDMSlot —
// this interval only smooths the traffic under that ceiling.
export const BROADCAST_SEND_INTERVAL_MS = Number(
  process.env.BROADCAST_SEND_INTERVAL_MS ?? 1500
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSendError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Unknown error";
  return message.slice(0, 500);
}

export interface CreateBroadcastInput {
  workspaceId: string;
  /** Internal InstagramAccount id (cuid) to send from. */
  instagramAccountId: string;
  name: string;
  message: string;
  /** Only contacts carrying this tag; omit for every contact of the account. */
  targetTag?: string | null;
}

/**
 * Create a broadcast: resolve the recipient segment from CRM contacts,
 * persist the Broadcast + one BroadcastDelivery per recipient, and enqueue
 * the send job on the existing dm-processing queue.
 *
 * Throws an Error with a caller-facing message on failure.
 */
export async function createBroadcast(
  input: CreateBroadcastInput
): Promise<{ id: string; recipientCount: number }> {
  const { workspaceId, instagramAccountId, name, message } = input;
  const targetTag = input.targetTag?.trim() || null;

  const account = await prisma.instagramAccount.findFirst({
    where: { id: instagramAccountId, workspaceId },
    select: { id: true },
  });
  if (!account) throw new Error("Instagram account not found");

  const contacts = await prisma.contact.findMany({
    where: {
      workspaceId,
      instagramAccountId: account.id,
      ...(targetTag ? { tags: { has: targetTag } } : {}),
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (contacts.length === 0) {
    throw new Error(
      targetTag
        ? `No contacts with tag "${targetTag}" for this account`
        : "No contacts for this account yet"
    );
  }

  const broadcast = await prisma.$transaction(async (tx) => {
    const created = await tx.broadcast.create({
      data: {
        workspaceId,
        instagramAccountId: account.id,
        name,
        message,
        targetTag,
        status: "QUEUED",
        totalCount: contacts.length,
      },
    });
    await tx.broadcastDelivery.createMany({
      data: contacts.map((contact) => ({
        broadcastId: created.id,
        contactId: contact.id,
      })),
    });
    return created;
  });

  try {
    await getDMQueue().add(
      BROADCAST_JOB_NAME,
      { broadcastId: broadcast.id },
      { jobId: `broadcast_${broadcast.id}` }
    );
  } catch (error) {
    // Without the job the broadcast would sit QUEUED forever; fail it loudly
    // instead so the caller sees the queue problem right away.
    await prisma.broadcast.update({
      where: { id: broadcast.id },
      data: { status: "FAILED", completedAt: new Date() },
    });
    throw new Error(
      `Failed to enqueue broadcast: ${formatSendError(error)}`
    );
  }

  return { id: broadcast.id, recipientCount: contacts.length };
}

/**
 * Fail a broadcast that cannot run at all (account gone, no credentials,
 * provider context cannot be built). Every still-PENDING delivery is marked
 * FAILED with the reason so the counts tell the truth.
 */
async function failBroadcast(
  broadcastId: string,
  reason: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const failed = await tx.broadcastDelivery.updateMany({
      where: { broadcastId, status: "PENDING" },
      data: { status: "FAILED", errorMessage: reason },
    });
    await tx.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: "FAILED",
        failedCount: { increment: failed.count },
        completedAt: new Date(),
      },
    });
  });
}

/**
 * Send one broadcast. Runs as the "process-broadcast" job on the
 * dm-processing queue; invoked by the DM worker.
 *
 * Idempotent and resumable: only PENDING deliveries are sent, each row is
 * settled exactly once, and the final counts are recounted from the
 * delivery rows. A single recipient's failure is recorded and the batch
 * moves on — it never aborts the remaining sends. Contacts outside
 * Instagram's 24h messaging window simply fail their send; that failure is
 * recorded as-is, never papered over.
 */
export async function processBroadcast(broadcastId: string): Promise<void> {
  const broadcast = await prisma.broadcast.findUnique({
    where: { id: broadcastId },
    include: { instagramAccount: true },
  });
  if (!broadcast) return;
  // A finished broadcast never runs again (job retry / duplicate enqueue).
  if (broadcast.status === "DONE" || broadcast.status === "FAILED") return;

  const account = broadcast.instagramAccount;
  if (!hasInstagramCredentials(account)) {
    await failBroadcast(broadcastId, "No Instagram access token available");
    return;
  }

  let context;
  try {
    context = await createInstagramContext(account);
  } catch (error) {
    await failBroadcast(
      broadcastId,
      `Failed to prepare Instagram credentials: ${formatSendError(error)}`
    );
    return;
  }

  await prisma.broadcast.update({
    where: { id: broadcastId },
    data: {
      status: "SENDING",
      startedAt: broadcast.startedAt ?? new Date(),
    },
  });

  const deliveries = await prisma.broadcastDelivery.findMany({
    where: { broadcastId, status: "PENDING" },
    select: {
      id: true,
      contact: { select: { igUserId: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  let firstSend = true;
  for (let i = 0; i < deliveries.length; i++) {
    const delivery = deliveries[i];

    // The shared hourly cap (750 DM sends/hour/account) is a hard ceiling:
    // once it is hit, the rest of the batch is skipped honestly rather than
    // pushed through into 429s.
    const rateLimit = await reserveDMSlot(account.instagramId);
    if (!rateLimit.allowed) {
      await prisma.broadcastDelivery.updateMany({
        where: {
          broadcastId,
          status: "PENDING",
          id: { in: deliveries.slice(i).map((d) => d.id) },
        },
        data: {
          status: "SKIPPED",
          errorMessage:
            "Skipped: Instagram DM rate limit reached for this account",
        },
      });
      break;
    }

    if (!firstSend && BROADCAST_SEND_INTERVAL_MS > 0) {
      await sleep(BROADCAST_SEND_INTERVAL_MS);
    }
    firstSend = false;

    try {
      await sendDirectMessage({
        context,
        instagramAccountId: account.instagramId,
        userId: delivery.contact.igUserId,
        message: broadcast.message,
      });
      await prisma.$transaction([
        prisma.broadcastDelivery.update({
          where: { id: delivery.id },
          data: { status: "SENT", sentAt: new Date() },
        }),
        prisma.broadcast.update({
          where: { id: broadcastId },
          data: { sentCount: { increment: 1 } },
        }),
      ]);
    } catch (error) {
      // The reserved slot was never used; hand it back like the DM worker
      // does, then record the failure and continue with the next recipient.
      await releaseDMSlot(account.instagramId).catch(() => undefined);
      await prisma.$transaction([
        prisma.broadcastDelivery.update({
          where: { id: delivery.id },
          data: { status: "FAILED", errorMessage: formatSendError(error) },
        }),
        prisma.broadcast.update({
          where: { id: broadcastId },
          data: { failedCount: { increment: 1 } },
        }),
      ]);
    }
  }

  // Recount from the delivery rows so the stored counters cannot drift from
  // reality (e.g. after a crash mid-batch and a resumed run).
  const [sent, failed] = await Promise.all([
    prisma.broadcastDelivery.count({
      where: { broadcastId, status: "SENT" },
    }),
    prisma.broadcastDelivery.count({
      where: { broadcastId, status: "FAILED" },
    }),
  ]);
  await prisma.broadcast.update({
    where: { id: broadcastId },
    data: { status: "DONE", sentCount: sent, failedCount: failed, completedAt: new Date() },
  });
}
