import { prisma } from "@/lib/db/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
  sendDirectMessage,
} from "@/lib/instagram/provider";

export interface RecordIncomingMessageInput {
  /** IG-side account id from the webhook job (InstagramAccount.instagramId). */
  instagramId: string;
  /** Internal InstagramAccount id, when the job is scoped to one connection. */
  accountConnectionId?: string;
  /** The sender's Instagram user id (IGSID). */
  senderId: string;
  text: string;
  /** The webhook's message id; dedupe key. */
  externalMessageId: string;
}

/**
 * Archive one incoming DM in the inbox. Best-effort by design: archiving must
 * never break the webhook / DM flow, so failures are logged and swallowed.
 * Redelivered webhooks are deduped by externalMessageId.
 */
export async function recordIncomingMessage(
  input: RecordIncomingMessageInput
): Promise<void> {
  const { instagramId, accountConnectionId, senderId, text, externalMessageId } =
    input;
  if (!instagramId || !senderId || !externalMessageId) return;

  try {
    const account = await prisma.instagramAccount.findFirst({
      where: accountConnectionId
        ? { id: accountConnectionId }
        : { instagramId },
      select: { id: true, workspaceId: true },
    });
    if (!account) return;

    // The messages webhook carries only the sender's IGSID; reuse a username
    // captured on an earlier interaction when there is one.
    const contact = await prisma.contact.findUnique({
      where: {
        instagramAccountId_igUserId: {
          instagramAccountId: account.id,
          igUserId: senderId,
        },
      },
      select: { username: true },
    });

    await prisma.inboxMessage.upsert({
      where: { externalMessageId },
      create: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        senderId,
        senderUsername: contact?.username ?? null,
        text,
        externalMessageId,
        status: "PENDING",
      },
      // Already archived (webhook redelivery): leave the row untouched.
      update: {},
    });
  } catch (error) {
    console.error("[Inbox] Failed to archive incoming message:", error);
  }
}

/**
 * Flag an archived DM as answered by a campaign's dmTrigger. Only a still
 * PENDING row is flipped, so a reply an agent already sent is never
 * overwritten. Best-effort: failures are logged and swallowed.
 */
export async function markIncomingMessageAutoReplied(
  externalMessageId: string
): Promise<void> {
  if (!externalMessageId) return;

  try {
    await prisma.inboxMessage.updateMany({
      where: { externalMessageId, status: "PENDING" },
      data: { status: "AUTO_REPLIED" },
    });
  } catch (error) {
    console.error("[Inbox] Failed to mark message auto-replied:", error);
  }
}

/**
 * Send a DM reply from one of the workspace's accounts and mark the sender's
 * latest pending inbox message as replied. Uses the exact send path the DM
 * worker uses (provider context + sendDirectMessage, which dispatches to
 * Meta or Zernio), so MCP replies behave identically to campaign replies.
 *
 * Throws an Error with a caller-facing message on failure.
 */
export async function sendInboxDmReply(input: {
  workspaceId: string;
  /** Internal InstagramAccount id (cuid) to send from. */
  instagramAccountId: string;
  /** Recipient's Instagram user id (IGSID). */
  recipientIgUserId: string;
  text: string;
}): Promise<{ sent: true; markedMessageId: string | null }> {
  const { workspaceId, instagramAccountId, recipientIgUserId, text } = input;

  const account = await prisma.instagramAccount.findFirst({
    where: { id: instagramAccountId, workspaceId },
  });
  if (!account) throw new Error("Instagram account not found");
  if (!hasInstagramCredentials(account)) {
    throw new Error("No Instagram access token available");
  }

  let context;
  try {
    context = await createInstagramContext(account);
  } catch {
    throw new Error("Failed to prepare Instagram credentials");
  }

  await sendDirectMessage({
    context,
    instagramAccountId: account.instagramId,
    userId: recipientIgUserId,
    message: text,
  });

  // The reply answers the sender's most recent unhandled message, if any.
  const pending = await prisma.inboxMessage.findFirst({
    where: {
      workspaceId,
      instagramAccountId: account.id,
      senderId: recipientIgUserId,
      status: "PENDING",
    },
    orderBy: { receivedAt: "desc" },
    select: { id: true },
  });
  if (pending) {
    await prisma.inboxMessage.update({
      where: { id: pending.id },
      data: { status: "REPLIED", replyText: text, repliedAt: new Date() },
    });
  }

  return { sent: true, markedMessageId: pending?.id ?? null };
}
