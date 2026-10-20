import { prisma } from "@/lib/db/client";

export interface CaptureContactInput {
  workspaceId: string;
  /** Internal InstagramAccount id (cuid), not the IG-side account id. */
  instagramAccountId: string;
  /** The other party's Instagram user id (IGSID). */
  igUserId: string;
  username?: string | null;
  displayName?: string | null;
  /** Campaign that first brought this person in; only filled while empty. */
  sourceAutomationId?: string | null;
}

/**
 * Create or refresh the CRM contact for someone who interacted with an
 * account. Best-effort by design: CRM capture must never break the webhook /
 * DM flow, so failures are logged and swallowed.
 */
export async function captureContact(input: CaptureContactInput): Promise<void> {
  const { workspaceId, instagramAccountId, igUserId } = input;
  if (!workspaceId || !instagramAccountId || !igUserId) return;

  try {
    const now = new Date();
    const contact = await prisma.contact.upsert({
      where: {
        instagramAccountId_igUserId: { instagramAccountId, igUserId },
      },
      create: {
        workspaceId,
        instagramAccountId,
        igUserId,
        username: input.username ?? null,
        displayName: input.displayName ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        sourceAutomationId: input.sourceAutomationId ?? null,
      },
      update: {
        lastSeenAt: now,
        // Only overwrite identity fields when the caller actually has them
        // (message webhooks carry no username, comment webhooks do).
        ...(input.username ? { username: input.username } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
      },
      select: { id: true, sourceAutomationId: true },
    });

    // sourceAutomationId means "first interaction source": backfill it when
    // an earlier touch (e.g. the webhook intake) created the contact without
    // knowing which campaign would match, but never replace it afterwards.
    if (input.sourceAutomationId && !contact.sourceAutomationId) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: { sourceAutomationId: input.sourceAutomationId },
      });
    }
  } catch (error) {
    console.error("[CRM] Failed to capture contact:", error);
  }
}
