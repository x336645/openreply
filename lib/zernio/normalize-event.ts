import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { parseCommentEvents } from '@/lib/meta/webhook';

type InstagramPayload = Parameters<typeof parseCommentEvents>[0];

const envelopeSchema = z.object({
  id: z.string().min(1),
  event: z.string(),
  account: z.object({ id: z.string(), platform: z.literal('instagram') }),
  comment: z.object({
    id: z.string().min(1), platformPostId: z.string().min(1), text: z.string(),
    author: z.object({ id: z.string().min(1), username: z.string().optional() }),
  }).optional(),
  message: z.object({
    platformMessageId: z.string().min(1), direction: z.enum(['incoming', 'outgoing']),
    text: z.string().nullable(), sender: z.object({ id: z.string().min(1) }),
    // Story markers, if the provider forwards them. Zernio's plan docs list
    // story-reply and story-mention automations, but no captured payload in
    // this repo shows their exact shape — so accept the reasonable camelCase
    // variants (a replyTo.story reference, a direct story reference, or a
    // story_mention attachment) and let the Meta-shaped parser classify.
    // All optional; plain DMs carry none of them.
    replyTo: z.object({
      mid: z.string().optional(),
      story: z.object({ id: z.string().optional(), url: z.string().optional() }).optional(),
    }).optional(),
    story: z.object({ id: z.string().optional(), url: z.string().optional() }).optional(),
    attachments: z.array(z.object({
      type: z.string().optional(),
      url: z.string().optional(),
      payload: z.object({ url: z.string().optional() }).optional(),
    })).optional(),
  }).optional(),
  conversation: z.object({ participantId: z.string().nullish() }).optional(),
  metadata: z.object({ postbackPayload: z.string().optional(), postbackTitle: z.string().optional() }).optional(),
  statusAt: z.string().optional(),
});

export function verifyZernioSignature({ rawBody, signature, secret }: {
  rawBody: string; signature: string | null; secret: string;
}): boolean {
  if (!signature || !secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}

export function normalizeZernioEvent({ payload, account }: {
  payload: unknown; account: { zernioAccountId: string | null; instagramId: string };
}): InstagramPayload | null {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success || parsed.data.account.id !== account.zernioAccountId) return null;
  const { event, comment, message, metadata, conversation, statusAt } = parsed.data;
  const entry: InstagramPayload['entry'][number] = { id: account.instagramId, time: Date.now() };
  if (event === 'comment.received' && comment) {
    entry.changes = [{ field: 'comments', value: { id: comment.id, text: comment.text, from: comment.author, media: { id: comment.platformPostId } } }];
  } else if (event === 'message.received' && message?.direction === 'incoming') {
    const sender = { id: message.sender.id };
    entry.messaging = [metadata?.postbackPayload
      ? { sender, postback: { mid: message.platformMessageId, payload: metadata.postbackPayload, title: metadata.postbackTitle } }
      : { sender, message: buildMessageValue(message) }];
  } else if (/story/i.test(event) && message?.direction === 'incoming') {
    // A story-named event (e.g. a dedicated story reply/mention event, if
    // the provider sends one) with a message payload: classify it as a story
    // interaction so the story parser picks it up. The kind comes from the
    // event name — "mention" wins, anything else is treated as a reply.
    const sender = { id: message.sender.id };
    const value = buildMessageValue(message);
    if (/mention/i.test(event)) {
      value.attachments = [
        ...(value.attachments ?? []),
        { type: 'story_mention' },
      ];
    } else if (!value.reply_to) {
      value.reply_to = { story: message.story ?? {} };
    }
    entry.messaging = [{ sender, message: value }];
  } else if (event === 'message.read' && conversation?.participantId) {
    const watermark = statusAt ? Date.parse(statusAt) : undefined;
    entry.messaging = [{ sender: { id: conversation.participantId }, read: { watermark: watermark !== undefined && Number.isFinite(watermark) ? watermark : undefined } }];
  } else {
    // Unrecognized story-shaped events are logged instead of vanishing
    // silently, so a provider payload shape we have not seen yet is
    // discoverable from server logs rather than looking like "no events".
    if (/story/i.test(event)) {
      console.warn('[Zernio] Dropping unrecognized story event shape', {
        event,
        hasMessage: Boolean(message),
        hasComment: Boolean(comment),
      });
    }
    return null;
  }
  return { object: 'instagram', entry: [entry] };
}

type EnvelopeMessage = NonNullable<z.output<typeof envelopeSchema>['message']>;

/**
 * Build the Meta-shaped messaging `message` value from a normalized
 * envelope message, carrying any story markers through so parseStoryEvents
 * can classify the interaction.
 */
function buildMessageValue(message: EnvelopeMessage) {
  const value: {
    mid: string;
    text: string;
    reply_to?: { story: { id?: string; url?: string } };
    attachments?: Array<{ type?: string; payload?: { url?: string } }>;
  } = { mid: message.platformMessageId, text: message.text ?? '' };

  const storyRef = message.replyTo?.story ?? message.story;
  if (storyRef) {
    value.reply_to = { story: { id: storyRef.id, url: storyRef.url } };
  }
  const attachments = (message.attachments ?? [])
    .filter((attachment) => attachment.type)
    .map((attachment) => ({
      type: attachment.type,
      payload: attachment.payload ?? (attachment.url ? { url: attachment.url } : undefined),
    }));
  if (attachments.length > 0) {
    value.attachments = attachments;
  }
  return value;
}
