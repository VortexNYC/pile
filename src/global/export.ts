import { eq, inArray } from "drizzle-orm";

import type { D1Client } from "./db.js";
import {
  cycles,
  githubInstallations,
  githubUsers,
  initiatives,
  labels,
  member,
  projects,
  repoBranches,
  repoIssues,
  roadmaps,
  states,
  team,
  teamMember,
  templates,
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
    workspaceLabels,
    workspaceMembers,
    workspaceProjects,
    workspaceRepoBranches,
    workspaceRepoIssues,
    workspaceRoadmaps,
    workspaceStates,
    workspaceTeams,
    workspaceTemplates,
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
    db.select().from(labels).where(eq(labels.organizationId, organizationId)),
    db.select().from(member).where(eq(member.organizationId, organizationId)),
    db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, organizationId)),
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
    db.select().from(states).where(eq(states.organizationId, organizationId)),
    db.select().from(team).where(eq(team.organizationId, organizationId)),
    db
      .select()
      .from(templates)
      .where(eq(templates.organizationId, organizationId)),
  ]);

  const teamIds = workspaceTeams.map((row) => row.id);

  const workspaceTeamMembers = teamIds.length
    ? await db
        .select()
        .from(teamMember)
        .where(inArray(teamMember.teamId, teamIds))
    : [];

  return {
    organizationId,
    exportedAt: new Date().toISOString(),
    cycles: workspaceCycles,
    githubInstallations: workspaceGithubInstallations,
    githubUsers: workspaceGithubUsers,
    initiatives: workspaceInitiatives,
    labels: workspaceLabels,
    members: workspaceMembers,
    projects: workspaceProjects,
    repoBranches: workspaceRepoBranches,
    repoIssues: workspaceRepoIssues,
    roadmaps: workspaceRoadmaps,
    states: workspaceStates,
    teams: workspaceTeams,
    teamMembers: workspaceTeamMembers,
    templates: workspaceTemplates,
  };
}
