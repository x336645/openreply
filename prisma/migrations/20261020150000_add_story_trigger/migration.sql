-- Story triggers: a campaign can also fire on story replies and story
-- mentions, not just post comments and DMs.

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "storyTriggerEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: inbox rows record how the message arrived so story-sourced
-- messages are distinguishable from plain DMs.
ALTER TABLE "InboxMessage" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'DM';
