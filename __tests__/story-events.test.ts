import { describe, expect, it } from "vitest";
import {
  parseMessageEvents,
  parseStoryEvents,
} from "@/lib/meta/webhook";
import { normalizeZernioEvent } from "@/lib/zernio/normalize-event";
import { matchInboundTrigger } from "@/lib/utils/keyword-matcher";

function messagingPayload(messaging: unknown[]) {
  return {
    object: "instagram",
    entry: [{ id: "ig_456", time: 1234567890, messaging }],
  } as Parameters<typeof parseStoryEvents>[0];
}

describe("parseStoryEvents", () => {
  it("parses a story reply (reply_to.story) with its text and story id", () => {
    const payload = messagingPayload([
      {
        sender: { id: "user_999" },
        recipient: { id: "ig_456" },
        message: {
          mid: "mid_story_1",
          text: "LINK please",
          reply_to: { story: { id: "story_77", url: "https://example/story" } },
        },
      },
    ]);

    expect(parseStoryEvents(payload)).toEqual([
      {
        instagramAccountId: "ig_456",
        messageId: "mid_story_1",
        senderId: "user_999",
        kind: "story_reply",
        text: "LINK please",
        storyId: "story_77",
      },
    ]);
  });

  it("parses a story mention attachment, which carries no text", () => {
    const payload = messagingPayload([
      {
        sender: { id: "user_999" },
        recipient: { id: "ig_456" },
        message: {
          mid: "mid_mention_1",
          attachments: [
            { type: "story_mention", payload: { url: "https://example/s" } },
          ],
        },
      },
    ]);

    expect(parseStoryEvents(payload)).toEqual([
      {
        instagramAccountId: "ig_456",
        messageId: "mid_mention_1",
        senderId: "user_999",
        kind: "story_mention",
      },
    ]);
    // A mention never becomes a plain message event (it has no text).
    expect(parseMessageEvents(payload)).toEqual([]);
  });

  it("ignores plain DMs, echoes, and the account's own messages", () => {
    const payload = messagingPayload([
      {
        sender: { id: "user_999" },
        recipient: { id: "ig_456" },
        message: { mid: "mid_dm", text: "hello" },
      },
      {
        sender: { id: "ig_456" },
        recipient: { id: "user_999" },
        message: {
          mid: "mid_echo",
          text: "LINK",
          is_echo: true,
          reply_to: { story: { id: "story_1" } },
        },
      },
      {
        sender: { id: "ig_456" },
        recipient: { id: "user_999" },
        message: {
          mid: "mid_self",
          attachments: [{ type: "story_mention" }],
        },
      },
    ]);

    expect(parseStoryEvents(payload)).toEqual([]);
  });
});

describe("Zernio story event shapes", () => {
  const account = { zernioAccountId: "za1", instagramId: "ig1" };
  const envelope = { id: "evt1", account: { id: "za1", platform: "instagram" } };

  it("carries a replyTo.story marker through to the story parser", () => {
    const result = normalizeZernioEvent({
      account,
      payload: {
        ...envelope,
        event: "message.received",
        message: {
          platformMessageId: "m1",
          direction: "incoming",
          text: "LINK",
          sender: { id: "person1" },
          replyTo: { story: { id: "story_9" } },
        },
      },
    });

    expect(parseStoryEvents(result!)).toEqual([
      {
        instagramAccountId: "ig1",
        messageId: "m1",
        senderId: "person1",
        kind: "story_reply",
        text: "LINK",
        storyId: "story_9",
      },
    ]);
  });

  it("carries a story_mention attachment through (no text)", () => {
    const result = normalizeZernioEvent({
      account,
      payload: {
        ...envelope,
        event: "message.received",
        message: {
          platformMessageId: "m2",
          direction: "incoming",
          text: null,
          sender: { id: "person1" },
          attachments: [{ type: "story_mention" }],
        },
      },
    });

    expect(parseStoryEvents(result!)).toEqual([
      {
        instagramAccountId: "ig1",
        messageId: "m2",
        senderId: "person1",
        kind: "story_mention",
      },
    ]);
    expect(parseMessageEvents(result!)).toEqual([]);
  });

  it("classifies a story-named event by its name", () => {
    const mention = normalizeZernioEvent({
      account,
      payload: {
        ...envelope,
        event: "story.mention",
        message: {
          platformMessageId: "m3",
          direction: "incoming",
          text: null,
          sender: { id: "person1" },
        },
      },
    });
    expect(parseStoryEvents(mention!)).toEqual([
      {
        instagramAccountId: "ig1",
        messageId: "m3",
        senderId: "person1",
        kind: "story_mention",
      },
    ]);

    const reply = normalizeZernioEvent({
      account,
      payload: {
        ...envelope,
        event: "story.reply",
        message: {
          platformMessageId: "m4",
          direction: "incoming",
          text: "LINK",
          sender: { id: "person1" },
          story: { id: "story_5" },
        },
      },
    });
    expect(parseStoryEvents(reply!)).toEqual([
      {
        instagramAccountId: "ig1",
        messageId: "m4",
        senderId: "person1",
        kind: "story_reply",
        text: "LINK",
        storyId: "story_5",
      },
    ]);
  });

  it("drops an unrecognized story shape with no message payload", () => {
    expect(
      normalizeZernioEvent({
        account,
        payload: { ...envelope, event: "story.received" },
      })
    ).toBeNull();
  });
});

describe("matchInboundTrigger", () => {
  const base = { keywords: ["link"], wholeWordMatch: true };

  it("matches story reply text against keywords", () => {
    expect(
      matchInboundTrigger({ ...base, text: "send the LINK", matchAnyWord: false })
    ).toEqual({ matched: true, matchedKeyword: "link" });
    expect(
      matchInboundTrigger({ ...base, text: "hello there", matchAnyWord: false })
    ).toEqual({ matched: false, matchedKeyword: null });
  });

  it("only matchAnyWord campaigns fire when the trigger has no text (story mention)", () => {
    expect(
      matchInboundTrigger({ ...base, text: undefined, matchAnyWord: false })
    ).toEqual({ matched: false, matchedKeyword: null });
    expect(
      matchInboundTrigger({ ...base, text: undefined, matchAnyWord: true })
    ).toEqual({ matched: true, matchedKeyword: null });
    expect(
      matchInboundTrigger({ ...base, text: "", matchAnyWord: true })
    ).toEqual({ matched: true, matchedKeyword: null });
  });
});
