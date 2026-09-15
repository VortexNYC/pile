import { processGithubWebhookPayload } from "../agents/github.js";
import { processGitlabWebhookPayload } from "../agents/gitlab.js";
import { processIntercomAgentWebhookPayload } from "../agents/intercom.js";
import { processNotionWebhookPayload } from "../api/notion-webhook.js";
import {
  processJamCreatedWebhookPayload,
  processJamIntercomOptedOutWebhookPayload,
  processJamIntercomRecordedWebhookPayload,
  processJamRecordingLinkCreatedWebhookPayload,
} from "../api/support-capture.js";
import { processEmailWebhookPayload } from "../channels/email.js";
import { processSlackSupportWebhookPayload } from "../channels/slack.js";
import type { WebhookProcessor, WebhookSource } from "./webhook-queue.js";

export const webhookProcessors = new Map<WebhookSource, WebhookProcessor>([
  ["intercom-agent", processIntercomAgentWebhookPayload],
  ["github", processGithubWebhookPayload],
  ["gitlab", processGitlabWebhookPayload],
  ["email", processEmailWebhookPayload],
  ["notion", processNotionWebhookPayload],
  ["slack", processSlackSupportWebhookPayload],
  ["jam", processJamCreatedWebhookPayload],
  ["jam-intercom-recorded", processJamIntercomRecordedWebhookPayload],
  ["jam-intercom-opted-out", processJamIntercomOptedOutWebhookPayload],
  ["jam-recording-link", processJamRecordingLinkCreatedWebhookPayload],
]);
