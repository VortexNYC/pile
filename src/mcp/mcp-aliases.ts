// Short, agent-friendly names for the most commonly used MCP tools.
// Each alias is registered alongside the generated operation name it maps to;
// both names accept identical arguments.

export const MCP_TOOL_ALIASES: Readonly<Record<string, string>> = {
  // Workspaces
  list_workspaces: "getWorkspaces",
  create_workspace: "postWorkspaces",

  // Teams
  list_teams: "getWorkspacesOrganizationIdTeams",
  get_team: "getWorkspacesOrganizationIdTeamsId",
  create_team: "postWorkspacesOrganizationIdTeams",
  update_team: "patchWorkspacesOrganizationIdTeamsId",
  delete_team: "deleteWorkspacesOrganizationIdTeamsId",
  list_team_members: "getWorkspacesOrganizationIdTeamsIdMembers",
  add_team_member: "postWorkspacesOrganizationIdTeamsIdMembers",

  // Issues
  list_issues: "getWorkspacesOrganizationIdIssues",
  get_issue: "getWorkspacesOrganizationIdIssuesId",
  create_issue: "postWorkspacesOrganizationIdIssues",
  create_issues_batch: "postWorkspacesOrganizationIdIssuesBatch",
  update_issue: "patchWorkspacesOrganizationIdIssuesId",
  delete_issue: "deleteWorkspacesOrganizationIdIssuesId",
  get_issue_branch_name: "getWorkspacesOrganizationIdIssuesIdBranchname",
  list_issue_children: "getWorkspacesOrganizationIdIssuesIdChildren",
  list_issue_activity: "getWorkspacesOrganizationIdIssuesIssueIdActivity",
  list_issue_history: "getWorkspacesOrganizationIdIssuesIssueIdHistory",
  list_issue_relations: "getWorkspacesOrganizationIdIssuesIssueIdRelations",
  create_issue_relation: "postWorkspacesOrganizationIdIssuesIssueIdRelations",
  list_issue_attachments: "getWorkspacesOrganizationIdIssuesIssueIdAttachments",
  create_issue_attachment:
    "postWorkspacesOrganizationIdIssuesIssueIdAttachments",
  list_issue_external_links:
    "getWorkspacesOrganizationIdIssuesIssueIdExternallinks",
  create_issue_external_link:
    "postWorkspacesOrganizationIdIssuesIssueIdExternallinks",
  list_issue_subscribers: "getWorkspacesOrganizationIdIssuesIssueIdSubscribers",
  subscribe_to_issue: "postWorkspacesOrganizationIdIssuesIssueIdSubscribers",
  dispatch_issue: "postWorkspacesOrganizationIdIssuesIdDispatch",

  // Comments
  list_issue_comments: "getWorkspacesOrganizationIdIssuesIssueIdComments",
  get_issue_comment: "getWorkspacesOrganizationIdIssuesIssueIdCommentsId",
  create_issue_comment: "postWorkspacesOrganizationIdIssuesIssueIdComments",
  update_issue_comment: "patchWorkspacesOrganizationIdIssuesIssueIdCommentsId",
  delete_issue_comment: "deleteWorkspacesOrganizationIdIssuesIssueIdCommentsId",
  resolve_comment: "postWorkspacesOrganizationIdCommentsCommentIdResolve",
  unresolve_comment: "postWorkspacesOrganizationIdCommentsCommentIdUnresolve",

  // Search
  search: "postWorkspacesOrganizationIdSearch",
  search_documents: "getWorkspacesOrganizationIdDocumentsSearch",

  // Projects
  list_projects: "getWorkspacesOrganizationIdProjects",
  get_project: "getWorkspacesOrganizationIdProjectsId",
  create_project: "postWorkspacesOrganizationIdProjects",
  update_project: "patchWorkspacesOrganizationIdProjectsId",
  delete_project: "deleteWorkspacesOrganizationIdProjectsId",
  create_project_milestone:
    "postWorkspacesOrganizationIdProjectsProjectIdMilestones",
  create_project_update: "postWorkspacesOrganizationIdProjectsProjectIdUpdates",

  // Cycles
  list_cycles: "getWorkspacesOrganizationIdCycles",
  create_cycle: "postWorkspacesOrganizationIdCycles",
  update_cycle: "patchWorkspacesOrganizationIdCyclesId",
  delete_cycle: "deleteWorkspacesOrganizationIdCyclesId",

  // Labels and workflow states
  list_labels: "getWorkspacesOrganizationIdLabels",
  create_label: "postWorkspacesOrganizationIdLabels",
  update_label: "patchWorkspacesOrganizationIdLabelsId",
  delete_label: "deleteWorkspacesOrganizationIdLabelsId",
  list_states: "getWorkspacesOrganizationIdStates",
  create_state: "postWorkspacesOrganizationIdStates",
  update_state: "patchWorkspacesOrganizationIdStatesId",
  delete_state: "deleteWorkspacesOrganizationIdStatesId",

  // Documents
  list_documents: "getWorkspacesOrganizationIdDocuments",
  get_document: "getWorkspacesOrganizationIdDocumentsId",
  create_document: "postWorkspacesOrganizationIdDocuments",
  update_document: "patchWorkspacesOrganizationIdDocumentsId",
  delete_document: "deleteWorkspacesOrganizationIdDocumentsId",

  // Notifications
  list_notifications: "getWorkspacesOrganizationIdNotifications",

  // Support
  list_support_customers: "getWorkspacesOrganizationIdSupportCustomers",
  get_support_customer: "getWorkspacesOrganizationIdSupportCustomersCustomerId",
  create_support_customer: "postWorkspacesOrganizationIdSupportCustomers",
  update_support_customer:
    "patchWorkspacesOrganizationIdSupportCustomersCustomerId",
  list_support_tickets: "getWorkspacesOrganizationIdSupportTickets",
  get_support_ticket: "getWorkspacesOrganizationIdSupportTicketsTicketId",
  create_support_ticket: "postWorkspacesOrganizationIdSupportTickets",
  update_support_ticket: "patchWorkspacesOrganizationIdSupportTicketsTicketId",
  list_support_ticket_events:
    "getWorkspacesOrganizationIdSupportTicketsTicketIdEvents",
  send_support_ticket_message:
    "postWorkspacesOrganizationIdSupportTicketsTicketIdMessages",
  add_support_ticket_note:
    "postWorkspacesOrganizationIdSupportTicketsTicketIdNotes",
  mark_support_ticket_done:
    "postWorkspacesOrganizationIdSupportTicketsTicketIdDone",
  snooze_support_ticket:
    "postWorkspacesOrganizationIdSupportTicketsTicketIdSnooze",
  set_support_ticket_assignees:
    "putWorkspacesOrganizationIdSupportTicketsTicketIdAssignees",
  set_support_ticket_labels:
    "putWorkspacesOrganizationIdSupportTicketsTicketIdLabels",
  list_support_inbox: "getWorkspacesOrganizationIdSupportInbox",
};

const ALIASES_BY_TARGET = new Map<string, string[]>();
for (const [alias, target] of Object.entries(MCP_TOOL_ALIASES)) {
  const existing = ALIASES_BY_TARGET.get(target) ?? [];
  existing.push(alias);
  ALIASES_BY_TARGET.set(target, existing);
}

export function aliasesFor(toolName: string): readonly string[] {
  return ALIASES_BY_TARGET.get(toolName) ?? [];
}
