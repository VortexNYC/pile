import { processGithubWebhookPayload } from "../agents/github.js";
import { processIntercomAgentWebhookPayload } from "../agents/intercom.js";
import { processIntercomSupportWebhookPayload } from "../channels/intercom.js";
import type { WebhookProcessor, WebhookSource } from "./webhook-queue.js";

export const webhookProcessors = new Map<WebhookSource, WebhookProcessor>([
  ["intercom", processIntercomSupportWebhookPayload],
  ["intercom-agent", processIntercomAgentWebhookPayload],
  ["github", processGithubWebhookPayload],
]);
