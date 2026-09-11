import { processGithubWebhookPayload } from "../agents/github.js";
import { processIntercomAgentWebhookPayload } from "../agents/intercom.js";
import {
  processJamCreatedWebhookPayload,
  processJamIntercomOptedOutWebhookPayload,
  processJamIntercomRecordedWebhookPayload,
  processJamRecordingLinkCreatedWebhookPayload,
} from "../api/support-capture.js";
import { processIntercomSupportWebhookPayload } from "../channels/intercom.js";
import { processPlainSupportWebhookPayload } from "../channels/plain.js";
import { processSlackSupportWebhookPayload } from "../channels/slack.js";
import { processZendeskSupportWebhookPayload } from "../channels/zendesk.js";
import type { WebhookProcessor, WebhookSource } from "./webhook-queue.js";

export const webhookProcessors = new Map<WebhookSource, WebhookProcessor>([
  ["intercom", processIntercomSupportWebhookPayload],
  ["intercom-agent", processIntercomAgentWebhookPayload],
  ["github", processGithubWebhookPayload],
  ["slack", processSlackSupportWebhookPayload],
  ["plain", processPlainSupportWebhookPayload],
  ["zendesk", processZendeskSupportWebhookPayload],
  ["jam", processJamCreatedWebhookPayload],
  ["jam-intercom-recorded", processJamIntercomRecordedWebhookPayload],
  ["jam-intercom-opted-out", processJamIntercomOptedOutWebhookPayload],
  ["jam-recording-link", processJamRecordingLinkCreatedWebhookPayload],
]);
