import { Button } from "@cloudflare/kumo/components/button";
import {
  Dialog,
  DialogClose,
  DialogRoot,
  DialogTitle,
} from "@cloudflare/kumo/components/dialog";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { ChatCircleDots } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import {
  buildFeedbackBody,
  canCaptureScreenshot,
  captureScreenshotDataUrl,
  installConsoleCapture,
  type FeedbackKind,
} from "@/lib/feedback-context";
import { toastError, toastSuccess } from "@/lib/toast";

export const FEEDBACK_KINDS: { value: FeedbackKind; label: string }[] = [
  { value: "bug", label: "Bug report" },
  { value: "feature", label: "Feature request" },
  { value: "other", label: "Other" },
];

/** Jam-style feedback bubble — floats bottom-right on every workspace
 * screen; files a bug / feature / other note straight into the
 * workspace's support tickets with auto-captured context (URL, device
 * info, recent console errors, optional screenshot). */
export function FeedbackBubble() {
  const workspace = useWorkspace();
  const permissions = usePermissions(workspace.id);
  const [open, setOpen] = useState(false);

  // Install the always-on console lookback at layout mount so errors
  // that happened before the dialog opened are still captured.
  useEffect(() => installConsoleCapture(), []);

  if (!permissions.isLoaded || !permissions.can("ticket", "create")) {
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
  const [capturing, setCapturing] = useState(false);

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
      <p className="text-kumo-subtle text-xs">
        The current page URL, browser info, and recent console errors are
        attached automatically.
      </p>
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
