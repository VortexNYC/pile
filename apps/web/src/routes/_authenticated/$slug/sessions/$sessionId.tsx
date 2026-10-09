import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import {
  ArrowSquareOut,
  PaperPlaneRight,
  StopCircle,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { Markdown } from "@/components/markdown";
import { Page } from "@/components/page";
import { ErrorState, LoadingState } from "@/components/states";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap, type paths } from "@/lib/api";
import {
  derivedStatusVariant,
  formatRelative,
  sessionStatusVariant,
} from "@/lib/labels";

type SessionDetailResponse =
  paths["/workspaces/{organizationId}/agent/sessions/{sessionId}"]["get"]["responses"][200]["content"]["application/json"];
// The route returns the full shape unless ?summary=1 — narrow the union
// on a field the summary shape drops.
type FullSession = Extract<SessionDetailResponse, { actorType: unknown }>;

export const Route = createFileRoute(
  "/_authenticated/$slug/sessions/$sessionId"
)({
  component: SessionDetail,
});

const TERMINAL = new Set(["completed", "failed", "canceled"]);

const LIVE_MS = 2500;

// prompt.* events carry the human's actual text in the payload — the
// event message is just bookkeeping ("queued (31 chars)").
function promptText(event: { type: string; payload?: unknown }): string | null {
  if (!event.type.startsWith("prompt.")) return null;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const prompt = (payload as Record<string, unknown>).prompt;
  return typeof prompt === "string" ? prompt : null;
}

function SessionDetail() {
  const workspace = useWorkspace();
  const { sessionId } = Route.useParams();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");

  const sessionKey = wsKey(workspace.id, "agent-sessions", sessionId);
  const eventsKey = wsKey(workspace.id, "agent-sessions", sessionId, "events");

  const session = useQuery({
    queryKey: sessionKey,
    queryFn: async (): Promise<FullSession> => {
      const data = await unwrap(
        api.GET("/workspaces/{organizationId}/agent/sessions/{sessionId}", {
          params: {
            path: { organizationId: workspace.id, sessionId },
          },
        })
      );
      if (!("actorType" in data)) {
        throw new Error("Unexpected summary session shape");
      }
      return data;
    },
    refetchInterval: (query) =>
      query.state.data && TERMINAL.has(query.state.data.status)
        ? false
        : LIVE_MS,
  });

  const events = useQuery({
    queryKey: eventsKey,
    queryFn: async () =>
      (
        await unwrap(
          api.GET(
            "/workspaces/{organizationId}/agent/sessions/{sessionId}/events",
            {
              params: {
                path: { organizationId: workspace.id, sessionId },
                query: { limit: "200" },
              },
            }
          )
        )
      ).events,
    refetchInterval: () => {
      const status = session.data?.status;
      if (status && TERMINAL.has(status)) return false;
      return LIVE_MS;
    },
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: sessionKey });
    void queryClient.invalidateQueries({ queryKey: eventsKey });
  };

  const sendPrompt = useMutation({
    mutationFn: (text: string) =>
      unwrap(
        api.POST(
          "/workspaces/{organizationId}/agent/sessions/{sessionId}/prompt",
          {
            params: { path: { organizationId: workspace.id, sessionId } },
            body: { prompt: text },
          }
        )
      ),
    onSuccess: () => {
      setPrompt("");
      invalidate();
    },
  });

  const cancel = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST(
          "/workspaces/{organizationId}/agent/sessions/{sessionId}/cancel",
          { params: { path: { organizationId: workspace.id, sessionId } } }
        )
      ),
    onSuccess: invalidate,
  });

  const s = session.data;
  const live = s !== undefined && !TERMINAL.has(s.status);
  const derivedVariant = derivedStatusVariant(s?.derivedStatus);

  return (
    <Page
      title={s?.label ?? "Agent session"}
      description={s ? `${s.provider} · ${sessionId.slice(0, 8)}` : undefined}
      actions={
        <div className="flex items-center gap-2">
          {s?.url ? (
            <Button
              variant="secondary"
              icon={<ArrowSquareOut />}
              onClick={() => window.open(s.url ?? "", "_blank")}
            >
              Provider session
            </Button>
          ) : null}
          {live ? (
            <Button
              variant="secondary"
              icon={<StopCircle />}
              onClick={() => void cancel.mutateAsync()}
              disabled={cancel.isPending}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      }
    >
      {session.isPending ? (
        <LoadingState label="Loading session" />
      ) : session.isError || !s ? (
        <ErrorState
          error={session.error}
          onRetry={() => void session.refetch()}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={sessionStatusVariant(s.status)}>{s.status}</Badge>
            {derivedVariant ? (
              <Badge variant={derivedVariant}>
                {s.derivedStatus?.replace("_", " ")}
              </Badge>
            ) : null}
            <Link
              to="/$slug/issues/$issueId"
              params={{ slug: workspace.slug, issueId: s.issueId }}
              className="text-kumo-link hover:underline text-sm"
            >
              Issue
            </Link>
            {s.prUrl ? (
              <a
                href={s.prUrl}
                target="_blank"
                rel="noreferrer"
                className="text-kumo-link hover:underline text-sm"
              >
                PR {s.prState ? `(${s.prState})` : ""}
              </a>
            ) : null}
            {s.branch ? (
              <span className="text-kumo-subtle text-sm">{s.branch}</span>
            ) : null}
          </div>
          {s.status === "completed" && s.result ? (
            <LayerCard>
              <p className="text-sm whitespace-pre-wrap">{s.result}</p>
            </LayerCard>
          ) : null}
          <LayerCard className="p-0">
            <div className="divide-y divide-kumo-line">
              {(() => {
                // Human-facing view: agent activities + the user's own
                // prompts. session.* lifecycle rows, `activity` mirror
                // events, and prompt bookkeeping (followup_skipped etc.)
                // are plumbing — the terminal has those.
                const feed = (events.data ?? []).filter(
                  (e) => e.kind === "activity" || e.type === "prompt.followup"
                );
                if (feed.length === 0) {
                  return (
                    <p className="p-4 text-sm text-kumo-subtle">
                      No activity yet.
                    </p>
                  );
                }
                return feed.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-baseline gap-3 px-4 py-2.5"
                  >
                    <Badge
                      variant={
                        event.type === "error"
                          ? "red"
                          : event.type === "elicitation"
                            ? "purple"
                            : event.type.startsWith("prompt.")
                              ? "green"
                              : event.type === "response"
                                ? "blue"
                                : "neutral"
                      }
                    >
                      {event.type.startsWith("prompt.") ? "you" : event.type}
                    </Badge>
                    <div className="flex-1 text-sm min-w-0">
                      <Markdown
                        workspaceSlug={workspace.slug}
                        content={promptText(event) ?? event.message}
                      />
                    </div>
                    <span className="text-xs text-kumo-subtle shrink-0">
                      {formatRelative(event.createdAt)}
                    </span>
                  </div>
                ));
              })()}
            </div>
          </LayerCard>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const text = prompt.trim();
              if (text.length > 0) void sendPrompt.mutateAsync(text);
            }}
          >
            <div className="flex-1">
              <Input
                aria-label="Prompt the agent"
                placeholder={
                  live
                    ? "Send a follow-up to this session"
                    : "Session is finished"
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={!live || sendPrompt.isPending}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              icon={<PaperPlaneRight />}
              disabled={
                !live || prompt.trim().length === 0 || sendPrompt.isPending
              }
            >
              Send
            </Button>
          </form>
          {sendPrompt.isError ? (
            <p className="text-sm text-kumo-danger">
              Follow-up failed — the sandbox may be gone. Retry dispatch for a
              cold session.
            </p>
          ) : null}
        </>
      )}
    </Page>
  );
}
