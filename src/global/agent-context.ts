export const DEFAULT_AGENTS_MD = `# Agent operating notes

## Support captures

Issues and support tickets may carry capture artifacts — debugger.json
(console, network with timing + GraphQL fields, actions, errors), replay.html
(self-contained rrweb replay with the event array embedded), video, and
screenshots. Before debugging, fetch them:

    GET /workspaces/{org}/support/tickets/{ticketId}/artifacts

or \`pile\` CLI: list the ticket's artifacts, read debugger.json first.

## Workflow

- Support tickets escalate to issues via the ticket's issueId.
- Replies to customers go through ticket messages (channel "chat" for widget
  conversations).
`;
