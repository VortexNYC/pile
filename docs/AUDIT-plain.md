# Plain.com Backend Audit

Source: Plain GraphQL API docs, agent docs, webhook docs, and operation index (`https://www.plain.com/docs/llms-full.txt`).

## 1. Architecture Overview

- **GraphQL-first API** at `https://core-api.uk.plain.com/graphql/v1`.
- **Single endpoint**, single `POST` transport, everything is a query or mutation.
- **API keys with fine-grained permissions**; supports machine users for agents.
- **Webhooks** are signed with `plain-request-signature` header; SDK available for verification.
- **Agent-native**: built so external agents can receive events and act on threads with the same API as human users.

## 2. Core Data Model

### 2.1 Threads (conversations/tickets)

The central object. Threads are created on inbound messages or via API. They carry state, priority, assignment, labels, custom fields, a timeline of events/messages, and discussions.

- **State**: todo / done (and likely more via labels/fields).
- **Priority**: modeled as a first-class field.
- **Customer**: linked to one customer.
- **Additional assignees**: supports multiple assignees.
- **Timeline**: chronological entries (emails, chat messages, notes, events).
- **Discussions**: side-conversations within a thread.
- **Fields**: custom thread fields with schema.
- **Links**: links to other threads.

### 2.2 Customers

Individual contacts. Can belong to tenants/groups, have cards, events, surveys, and custom fields.

- **Email / identity**.
- **Customer groups** for segmentation.
- **Tenants** (companies/organizations) a customer belongs to.
- **Customer cards**: UI cards rendered from JSON for rich customer context.
- **Customer events**: timeline events on the customer (e.g., `createCustomerEvent`).
- **Surveys**: customer satisfaction / feedback.

### 2.3 Tenants

Companies or organizations. Customers can be in multiple tenants. Tenants have fields and schemas.

### 2.4 Users & Machine Users

- **Users**: human team members, with roles, status (active/away), tiers, billing rotas.
- **Machine users**: agent identity, has public name, API keys, permissions.
- **Roles & custom roles**: permission system.
- **Tiers**: user grouping (e.g., support tiers).

### 2.5 Workspace

- **Settings**: email domains, support email addresses, Slack/Discord/Teams channel integrations.
- **API keys / webhooks**.
- **Billing plan & credits**.

## 3. Messaging & Channels

Plain supports multiple native channels and a custom-channel protocol:

- **Email**: inbound/outbound, email verification, signatures, previews.
- **Slack**: workspace + channel + sidekick integrations; customer resolution from Slack.
- **MS Teams**: workspace + channel integrations.
- **Discord**: workspace + channel integrations.
- **Chat**: chat apps, embed tokens, demo channels.
- **API / custom channels**: `createThread`, `sendNewEmail`, `replyToThread`, custom channel protocol for Discourse/Hubspot/etc.
- **Broadcasts**: bulk outbound messages (`createBroadcast`, `scheduleBroadcast`, `sendBulkEmail`).

## 4. Agent / AI Support

Plain is explicitly built for agents:

- **Machine users**: agent identity.
- **Webhooks**: events like `thread.thread_created`, `thread.email_received`, `thread.assignment_changed`.
- **MCP server**: exposes tools for threads, customers, tenants, help center, user/workspace.
- **Agent skill / Cursor integration**: agent-assisted workflows.
- **Sidekick**: custom skills and MCP server for agents.
- **Suggested replies**: `addGeneratedReply` for agent-drafted but human-approved replies.
- **Notes**: internal-only timeline entries.
- **Routing**: workflows assign threads to machine users or users.
- **AI tone rules**: generated tone guidance.
- **AI feedback / approvals**: `createAiFeedback`, `resolveAgentApproval`.

## 5. Help Center & Knowledge

- **Help center**: groups, articles.
- **Knowledge sources**: indexed documents, help center, customer card data.
- **Indexed documents**: `createIndexedDocument` for RAG.
- **Search**: knowledge source search for agent prompts.
- **Customer cards**: JSON-driven UI components shown in thread sidebar.

## 6. Productivity & Workflow

- **Labels / label types**: classification, tags.
- **Snippets**: canned responses (`createSnippet`).
- **Tasks**: subtasks inside threads (`createTask`, `deleteTask`).
- **Autoresponders**: auto-reply rules (`createAutoresponder`).
- **Escalation paths**: routing/escalation rules.
- **Workflows**: `createWorkflow`, `createWorkflowRule`, `createWorkflowStep`.
- **Service level agreements (SLAs)**: `createServiceLevelAgreement`.
- **Saved thread views**: `createSavedThreadsView`.
- **Favorites pages / My favorite page**.

## 7. Integrations

Plain has first-class integrations with many tools, each requiring auth and channel mappings:

- **Linear** (`createLinearAppIntegration`, `createMyLinearIntegration`).
- **GitHub** (`createGithubUserAuthIntegration`).
- **Slack** (`createWorkspaceSlackIntegration`, `bulkJoinSlackChannels`).
- **MS Teams** (`createMyMSTeamsIntegration`).
- **Discord** (`createUserAuthDiscordChannelIntegration`).
- **Hubspot** (custom channel example).
- **Discourse** (custom channel example).
- **Cursor** (`createWorkspaceCursorIntegration`).
- **Hyperline** (`createHyperlineBillingPortalSession`, `createHyperlineComponentsAuthToken`).

## 8. Import & Migration

- `importCustomers`
- `importTenants`
- `importThread`
- `importThreadDiscussion`
- `importThreadMessages`
- `createImportSync`

Imports preserve original timestamps and conversation history.

## 9. Webhooks & Events

- Signed POST to a configured URL.
- Events: thread created/updated, email received/sent, assignment changed, customer updated, etc.
- SDK for verifying `plain-request-signature`.
- Webhook targets and workflow-driven routing.

## 10. Billing & Credits

- `changeBillingPlan`
- `purchaseCredits`
- `previewBillingPlanChange`
- `calculateRoleChangeCost`
- Usage/credit model.

## 11. Reporting & Feedback

- Customer surveys.
- AI feedback.
- Saved views for queue triage.
- Customer events for activity tracking.

## 12. Security & Admin

- API keys with permissions (`createApiKey`, `deleteApiKey`).
- User roles and custom roles (`createCustomRole`, `assignRolesToUser`).
- Workspace invites and membership.
- File uploads/downloads with signed URLs.
- HMAC webhook signatures.

## 13. Key Takeaways for Pile

1. **Thread == Issue**: Plain's `Thread` is the closest analog to a Pile `Issue`.
2. **Customer + Tenant == Contact + Company/Workspace**: reuse the `support-contacts` model.
3. **Timeline == comments + history**: Pile `comments` and `issue_history` can model the thread timeline.
4. **Machine user == Agent**: already planned in Pile; agent sessions and activities exist.
5. **Labels, snippets, tasks, SLAs** map directly to Pile `labels`, `templates`/`comments`, `tasks` (new), `cycles`/deadlines.
6. **Channels** are ingestion: each is a webhook/POST that creates/updates a thread.
7. **Custom channel protocol** is the pattern for plugging in any external source (Discourse, Hubspot, etc.).
8. **Help center + knowledge sources** are documents; Pile documents can model them.
9. **GraphQL is the API shape**; Pile should expose REST/OpenAPI first, but the object model can mirror Plain's.
10. **MCP server is the agent interface**: Pile's MCP generation should expose the same verbs.

## 14. Gaps to Decide

- Plain uses a **single workspace-wide email address**; Pile needs per-workspace support inboxes.
- Plain has **native chat widget**; Pile would need a chat SDK or iframe.
- Plain has **billing/credits** for support usage; Pile may need `ISS-5` billing first.
- Plain's **customer cards** are UI components; Pile can defer to JSON-rendered components.
