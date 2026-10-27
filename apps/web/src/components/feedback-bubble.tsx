import { Button } from "@cloudflare/kumo/components/button";
import {
  Dialog,
  DialogClose,
  DialogRoot,
  DialogTitle,
} from "@cloudflare/kumo/components/dialog";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import {
  ChatCircleDots,
  Microphone,
  MicrophoneSlash,
  VideoCamera,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { FeedbackAnnotator } from "@/components/feedback-annotate";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  blobToDataUrl,
  canRecordScreenClip,
  installFeedbackCapture,
  MAX_RECORDING_MS,
  setFeedbackCaptureOptions,
  setRecordingAnchorMs,
  startTabRecording,
} from "@/lib/feedback-capture";
import {
  buildFeedbackBody,
  canCaptureScreenshot,
  captureScreenshotDataUrl,
  type FeedbackKind,
} from "@/lib/feedback-context";
import { toastError, toastSuccess } from "@/lib/toast";

export const FEEDBACK_KINDS: { value: FeedbackKind; label: string }[] = [
  { value: "bug", label: "Bug report" },
  { value: "feature", label: "Feature request" },
  { value: "other", label: "Other" },
];

/** `mm:ss` ceiling for the record button ("5:00"). */
function formatClipLimit(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Jam-style feedback bubble — floats bottom-right on every workspace
 * screen; files a bug / feature / other note straight into the
 * workspace's support tickets with a Jam-parity artifact bundle: device
 * info, console trail, network waterfall, click/key events, errors,
 * optional screenshot (with annotation) and a short screen recording. */
export function FeedbackBubble() {
  const workspace = useWorkspace();
  const permissions = usePermissions(workspace.id);
  const [open, setOpen] = useState(false);

  // Install the always-on collectors at layout mount so the console,
  // network, click, and error trail that led up to the report is
  // already buffered when the dialog opens.
  useEffect(() => installFeedbackCapture(), []);

  // Hide only on a confirmed denial (loaded, and the member cannot file
  // tickets). While permissions are loading — or if the permissions
  // query itself fails — the launcher stays visible: the feedback POST
  // is gated server-side by ticket:create either way, and an
  // error-or-pending state must never swallow the report UI.
  if (permissions.isLoaded && !permissions.can("ticket", "create")) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        aria-label="Send feedback"
        title="Report a bug or request a feature"
        onClick={() => setOpen(true)}
        className="bg-kumo-brand text-kumo-contrast fixed bottom-5 right-5 z-50 flex size-11 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-105"
      >
        <ChatCircleDots size={22} weight="fill" />
      </button>
      <DialogRoot open={open} onOpenChange={setOpen}>
        <Dialog className="max-w-lg p-6">
          <DialogTitle>Send feedback</DialogTitle>
          <div className="mt-4">
            <FeedbackForm onDone={() => setOpen(false)} />
          </div>
          <DialogClose />
        </Dialog>
      </DialogRoot>
    </>
  );
}

function FeedbackForm({ onDone }: { onDone: () => void }) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [recordingClip, setRecordingClip] = useState(false);
  // Cap-style voiceover — on by default; the browser's mic prompt fires
  // after the tab picker, and a denial still records tab audio only.
  const [includeMic, setIncludeMic] = useState(true);
  // PILE-675 opt-in — network bodies are heavier and can carry payloads
  // the reporter may not expect, so they ride an explicit toggle.
  const [includeNetworkBodies, setIncludeNetworkBodies] = useState(false);

  const submit = useMutation({
    mutationFn: async () =>
      unwrap(
        api.POST("/workspaces/{organizationId}/support/feedback", {
          params: { path: { organizationId: workspace.id } },
          body: buildFeedbackBody({
            kind,
            title,
            description,
            ...(screenshot ? { screenshotDataUrl: screenshot } : {}),
            ...(recording ? { recordingDataUrl: recording } : {}),
          }),
        })
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "tickets"),
      });
      toastSuccess("Feedback filed — thanks");
      onDone();
      await navigate({
        to: "/$slug/tickets/$ticketId",
        params: { slug: workspace.slug, ticketId: result.ticketId },
      });
    },
    onError: (error) => toastError(error),
  });

  const valid = title.trim().length > 0 && description.trim().length > 0;

  if (annotating && screenshot) {
    return (
      <FeedbackAnnotator
        src={screenshot}
        onApply={(dataUrl) => {
          setScreenshot(dataUrl);
          setAnnotating(false);
        }}
        onCancel={() => setAnnotating(false)}
      />
    );
  }

  return (
    <form
      aria-label="Send feedback"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !submit.isPending) submit.mutate();
      }}
    >
      <Select
        label="Type"
        value={kind}
        onValueChange={(value) => {
          if (FEEDBACK_KINDS.some((k) => k.value === value)) {
            setKind(value as FeedbackKind);
          }
        }}
      >
        {FEEDBACK_KINDS.map((k) => (
          <Select.Option key={k.value} value={k.value}>
            {k.label}
          </Select.Option>
        ))}
      </Select>
      <Input
        label="Title"
        value={title}
        required
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What's happening?"
      />
      <InputArea
        label="Details"
        value={description}
        required
        minRows={4}
        autoResize
        onValueChange={setDescription}
        placeholder="Steps to reproduce, what you expected, or the idea."
      />
      {screenshot ? (
        <div className="flex items-center gap-3">
          <img
            src={screenshot}
            alt="Screenshot to attach"
            className="border-kumo-line h-16 rounded border object-cover"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => setAnnotating(true)}
          >
            Annotate
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setScreenshot(null)}
          >
            Remove
          </Button>
        </div>
      ) : canCaptureScreenshot() ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            loading={capturing}
            onClick={async () => {
              setCapturing(true);
              try {
                const dataUrl = await captureScreenshotDataUrl();
                if (dataUrl) setScreenshot(dataUrl);
              } catch {
                // Member cancelled the screen picker — nothing to attach.
              } finally {
                setCapturing(false);
              }
            }}
          >
            Attach screenshot
          </Button>
        </div>
      ) : null}
      {recording ? (
        <div className="flex items-center gap-3">
          <video
            src={recording}
            aria-label="Screen recording to attach"
            className="border-kumo-line h-16 rounded border"
            muted
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setRecording(null);
              setRecordingAnchorMs(null);
            }}
          >
            Remove
          </Button>
        </div>
      ) : canRecordScreenClip() ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            icon={<VideoCamera size={16} />}
            loading={recordingClip}
            onClick={async () => {
              setRecordingClip(true);
              try {
                const clip = await startTabRecording({ includeMic });
                setRecordingAnchorMs(clip.recordingStartedAtMs);
                setRecording(await blobToDataUrl(clip.blob));
              } catch {
                // Member cancelled the share picker or the browser
                // refused — nothing to attach.
              } finally {
                setRecordingClip(false);
              }
            }}
          >
            Record up to {formatClipLimit(MAX_RECORDING_MS)}
          </Button>
          <span className="flex items-center gap-1.5">
            {includeMic ? (
              <Microphone size={14} className="text-kumo-subtle" />
            ) : (
              <MicrophoneSlash size={14} className="text-kumo-subtle" />
            )}
            <Switch
              label="Mic audio"
              checked={includeMic}
              disabled={recordingClip}
              onCheckedChange={setIncludeMic}
            />
          </span>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <Switch
          label="Include network request/response bodies"
          checked={includeNetworkBodies}
          onCheckedChange={(checked) => {
            setIncludeNetworkBodies(checked);
            setFeedbackCaptureOptions({ includeNetworkBodies: checked });
          }}
        />
        <p className="text-kumo-subtle text-xs">
          The current page URL, browser info, console logs, network requests,
          and recent clicks are attached automatically.
          {includeNetworkBodies
            ? " Network bodies are captured for requests made after you turned this on."
            : ""}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={submit.isPending}
          disabled={!valid}
        >
          File feedback
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
