import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";

export type WorkspaceContext = {
  userId: string;
  workspaceId: string;
  workspace: Workspace;
  role: WorkspaceRole;
};

const ROLE_ORDER: Record<WorkspaceRole, number> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function hasWorkspaceRole(
  role: WorkspaceRole,
  minimumRole: WorkspaceRole
) {
  return ROLE_ORDER[role] >= ROLE_ORDER[minimumRole];
}

export function canManageWorkspace(role: WorkspaceRole) {
  return hasWorkspaceRole(role, "ADMIN");
}

export function canManageBilling(role: WorkspaceRole) {
  return role === "OWNER";
}

/**
 * API key auth for automation (e.g. the owner's AI assistant).
 * If `OPENREPLY_API_KEY` is set and the provided key matches,
 * returns an OWNER context for the first workspace.
 */
export async function getApiKeyWorkspaceContext(
  apiKey: string | null
): Promise<WorkspaceContext | null> {
  const expected = process.env.OPENREPLY_API_KEY;
  if (!expected || !apiKey || apiKey !== expected) return null;

  const workspace = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (!workspace) return null;

  const ownerMembership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: workspace.id, role: "OWNER" },
    orderBy: { createdAt: "asc" },
  });

  return {
    userId: ownerMembership?.userId ?? "api-key",
    workspaceId: workspace.id,
    workspace,
    role: "OWNER",
  };
}

export async function getCurrentWorkspaceContext(): Promise<WorkspaceContext | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });

  if (membership) {
    return {
      userId,
      workspaceId: membership.workspaceId,
      workspace: membership.workspace,
      role: membership.role,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  const workspace = await ensureWorkspaceForUser(userId, user?.email);
  const createdMembership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId,
      },
    },
  });

  return {
    userId,
    workspaceId: workspace.id,
    workspace,
    role: createdMembership?.role ?? "OWNER",
  };
}

