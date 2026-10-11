import {
  Dialog,
  DialogClose,
  DialogRoot,
  DialogTitle,
} from "@cloudflare/kumo/components/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { IssueForm, type IssueFormValues } from "@/components/issue-form";
import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/toast";

/** ⌘N quick-create — Circle's sidebar create-issue modal. Mount once
 * in the workspace layout; it listens for ⌘N / Ctrl+N. */
export function CreateIssueDialog() {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "n") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const create = useMutation({
    mutationFn: (values: IssueFormValues) =>
      unwrap(
        api.POST("/workspaces/{organizationId}/issues", {
          params: { path: { organizationId: workspace.id } },
          body: {
            title: values.title,
            description: values.description.trim() || undefined,
            status: values.status,
            priority: values.priority,
          },
        })
      ),
    onSuccess: async (issue) => {
      await queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "issues"),
      });
      setOpen(false);
      toastSuccess("Issue created");
      await navigate({
        to: "/$slug/issues/$issueId",
        params: { slug: workspace.slug, issueId: issue.id },
      });
    },
    onError: (error) => toastError(error),
  });

  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <Dialog className="max-w-lg p-6">
        <DialogTitle>New issue</DialogTitle>
        <div className="mt-4">
          <IssueForm
            initial={{
              title: "",
              description: "",
              status: "todo",
              priority: "medium",
            }}
            submitLabel="Create issue"
            pending={create.isPending}
            onSubmit={(values) => create.mutate(values)}
            onCancel={() => setOpen(false)}
          />
        </div>
        <DialogClose />
      </Dialog>
    </DialogRoot>
  );
}
