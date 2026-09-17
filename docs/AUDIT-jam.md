# Jam.dev Audit

Source: `https://jam.dev/docs/llms.txt` and `https://jam.dev/docs/whats-in-a-jam.md`.

## 1. What Jam Is

Hosted bug reporting tool. Captures bugs with screenshot, screen recording, or Instant Replay. Attaches console logs, network requests, user events, and device info. Routes reports to issue trackers, support desks, Slack, or AI agents.

## 2. Capture Methods

| Method               | How                                                                   |
| -------------------- | --------------------------------------------------------------------- |
| Chrome extension     | One-click screenshot/tab recording/desktop recording.                 |
| iOS app              | Mobile bug reports.                                                   |
| Recording Links      | No-install, no-account; share a URL, customer records on the site.    |
| Instant Replay       | Rewind last 2 minutes of activity.                                    |
| SDK (`@jam.dev/sdk`) | `jam.metadata()` attaches custom logs (user ID, feature flags, etc.). |

## 3. What's in a Jam

- Visual context (screenshot or video).
- Custom logs / metadata.
- DevTools: console logs, network requests, user events.
- Device and browser details.
- Figma embed support.
- AI-generated titles and repro steps (`Jam AI`).

## 4. Integrations

- Issue trackers: Jira, Linear, GitHub, GitLab, Asana, ClickUp, Azure DevOps, Notion.
- Support desks: Zendesk, Freshdesk, HubSpot, ServiceNow, Jira Service Management, Intercom (Fin).
- Chat/AI: Slack, Sentry, FullStory, LogRocket, MCP for Claude/Cursor/VS Code.
- Webhooks: `jam.dev/docs/webhooks` for custom event fan-out.
- Recording Links for customer support: request a recording inside Zendesk/Freshdesk/HubSpot/ServiceNow/Jira/Intercom.

## 5. Workspaces & Access

- Members and roles: Viewer, Creator, Admin.
- Default access per Jam + per-Jam visibility overrides.
- Audit logs for access/membership changes.
- SSO.
- SOC 2 Type II, AES-256, automatic blurring.

## 6. Developer API Surface

- **SDK:** `jam.metadata()` for custom logs; `npm i @jam.dev/sdk`.
- **MCP server:** exposes tools to read Jam details, console logs, network requests, frames, transcripts.
- **CLI:** `jam` CLI to authenticate, read/write Jams, record, manage recording links.
- **Personal access tokens:** for headless / CI.
- **Webhooks:** new Jam created events.

## 7. Key Primitives

- **Capture token / public key?** Jam uses browser extension and recording links; Crikket is closer to the embeddable public-key model.
- **Metadata is live:** `jam.metadata()` callback is invoked at capture time, not page load.
- **DevTools as first-class context:** console, network, user events are core, not addons.
- **Recording Links for support:** no install on customer side; the link opens a recorder on the page.
- **AI is post-capture:** titles and repro steps, plus MCP for coding agents.

## 8. What to Borrow for Pile

- **Capture as a support channel.** A support ticket can be created from a Jam-style capture, with attachments for screenshot/video and debugger JSON.
- **Recording links for support.** Send a customer a link to record their issue without an extension.
- **`jam.metadata()` pattern.** A `pile.capture.metadata()` SDK call on the customer's site attaches custom data to the ticket.
- **DevTools attachment per ticket.** `support_ticket_messages` can link to attachments for console log and network JSON.
- **MCP / AI agent integration.** Pile's MCP layer can expose the same "read Jam context" tools.
- **Issue tracker promotion.** Jam turns captures into Jira/Linear/GitHub issues. Pile can turn a capture `support_ticket` into a Pile `issue` via `issue_id`.

## 9. Gaps to Decide

- Jam is SaaS-first and does not expose a self-hosted embed SDK like Crikket. Pile can build a Crikket-style SDK (`@pile/capture`) for its own capture channel.
- Jam's AI features are hosted. Pile provides primitives; customers bring their own model.
