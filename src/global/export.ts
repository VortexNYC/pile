import { eq, inArray } from "drizzle-orm";

import type { D1Client } from "./db.js";
import {
  agentActivities,
  agentSessions,
  cycles,
  githubInstallations,
  githubUsers,
  initiatives,
  issueApprovals,
  issueRelations,
  issueSubscribers,
  labels,
  member,
  notifications,
  projects,
  reactions,
  repoBranches,
  repoIssues,
  roadmaps,
  savedViews,
  states,
  team,
  teamMember,
  templates,
  webhookSubscriptions,
} from "./schema.js";

export async function exportWorkspaceData(
  db: D1Client,
  organizationId: string
) {
  const [
    workspaceCycles,
    workspaceGithubInstallations,
    workspaceGithubUsers,
    workspaceInitiatives,
    workspaceApprovals,
    workspaceRelations,
    workspaceSubscribers,
    workspaceLabels,
    workspaceMembers,
    workspaceNotifications,
    workspaceProjects,
    workspaceReactions,
    workspaceRepoBranches,
    workspaceRepoIssues,
    workspaceRoadmaps,
    workspaceSavedViews,
    workspaceStates,
    workspaceTeams,
    workspaceTemplates,
    workspaceWebhookSubscriptions,
    workspaceAgentSessions,
  ] = await Promise.all([
    db.select().from(cycles).where(eq(cycles.organizationId, organizationId)),
    db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.organizationId, organizationId)),
    db
      .select()
      .from(githubUsers)
      .where(eq(githubUsers.organizationId, organizationId)),
    db
      .select()
      .from(initiatives)
      .where(eq(initiatives.organizationId, organizationId)),
    db
      .select()
      .from(issueApprovals)
      .where(eq(issueApprovals.organizationId, organizationId)),
    db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.organizationId, organizationId)),
    db
      .select()
      .from(issueSubscribers)
      .where(eq(issueSubscribers.organizationId, organizationId)),
    db.select().from(labels).where(eq(labels.organizationId, organizationId)),
    db.select().from(member).where(eq(member.organizationId, organizationId)),
    db
      .select()
      .from(notifications)
      .where(eq(notifications.organizationId, organizationId)),
    db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, organizationId)),
    db
      .select()
      .from(reactions)
      .where(eq(reactions.organizationId, organizationId)),
    db
      .select()
      .from(repoBranches)
      .where(eq(repoBranches.organizationId, organizationId)),
    db
      .select()
      .from(repoIssues)
      .where(eq(repoIssues.organizationId, organizationId)),
    db
      .select()
      .from(roadmaps)
      .where(eq(roadmaps.organizationId, organizationId)),
    db
      .select()
      .from(savedViews)
      .where(eq(savedViews.organizationId, organizationId)),
    db.select().from(states).where(eq(states.organizationId, organizationId)),
    db.select().from(team).where(eq(team.organizationId, organizationId)),
    db
      .select()
      .from(templates)
      .where(eq(templates.organizationId, organizationId)),
    db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.organizationId, organizationId)),
    db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.organizationId, organizationId)),
  ]);

  const teamIds = workspaceTeams.map((row) => row.id);
  const sessionIds = workspaceAgentSessions.map((row) => row.id);

  const workspaceTeamMembers = teamIds.length
    ? await db
        .select()
        .from(teamMember)
        .where(inArray(teamMember.teamId, teamIds))
    : [];

  const workspaceAgentActivities = sessionIds.length
    ? await db
        .select()
        .from(agentActivities)
        .where(inArray(agentActivities.sessionId, sessionIds))
    : [];

  return {
    organizationId,
    exportedAt: new Date().toISOString(),
    cycles: workspaceCycles,
    githubInstallations: workspaceGithubInstallations,
    githubUsers: workspaceGithubUsers,
    initiatives: workspaceInitiatives,
    approvals: workspaceApprovals,
    relations: workspaceRelations,
    subscribers: workspaceSubscribers,
    labels: workspaceLabels,
    members: workspaceMembers,
    notifications: workspaceNotifications,
    projects: workspaceProjects,
    reactions: workspaceReactions,
    repoBranches: workspaceRepoBranches,
    repoIssues: workspaceRepoIssues,
    roadmaps: workspaceRoadmaps,
    savedViews: workspaceSavedViews,
    states: workspaceStates,
    teams: workspaceTeams,
    teamMembers: workspaceTeamMembers,
    templates: workspaceTemplates,
    webhookSubscriptions: workspaceWebhookSubscriptions,
    agentSessions: workspaceAgentSessions,
    agentActivities: workspaceAgentActivities,
  };
}
