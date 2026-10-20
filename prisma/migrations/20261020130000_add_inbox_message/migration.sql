-- Inbox: one row per incoming DM, archived from the message webhook flow so
-- an external agent (via MCP) can read unhandled messages and reply to them.

-- CreateEnum
CREATE TYPE "InboxMessageStatus" AS ENUM ('PENDING', 'AUTO_REPLIED', 'REPLIED', 'IGNORED');

-- CreateTable
CREATE TABLE "InboxMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderUsername" TEXT,
    "text" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "InboxMessageStatus" NOT NULL DEFAULT 'PENDING',
    "replyText" TEXT,
    "repliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboxMessage_workspaceId_idx" ON "InboxMessage"("workspaceId");

-- CreateIndex
CREATE INDEX "InboxMessage_workspaceId_status_receivedAt_idx" ON "InboxMessage"("workspaceId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "InboxMessage_instagramAccountId_senderId_idx" ON "InboxMessage"("instagramAccountId", "senderId");

-- CreateIndex
CREATE UNIQUE INDEX "InboxMessage_externalMessageId_key" ON "InboxMessage"("externalMessageId");

-- AddForeignKey
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
