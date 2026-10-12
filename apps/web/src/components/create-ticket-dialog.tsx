import { Button } from "@cloudflare/kumo/components/button";
import {
  Dialog,
  DialogClose,
  DialogRoot,
  DialogTitle,
} from "@cloudflare/kumo/components/dialog";
import { Input, InputArea } from "@cloudflare/kumo/components/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/toast";

/** Create-ticket dialog — the Support section's create grammar,
 * matching CreateIssueDialog. */
export function CreateTicketDialog({
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internal, setInternal] = useState(false);
  const open = openProp ?? internal;
  const onOpenChange = onOpenChangeProp ?? setInternal;
  useEffect(() => {
    const onOpen = () => onOpenChange(true);
    window.addEventListener("pile:create-ticket", onOpen);
    return () => window.removeEventListener("pile:create-ticket", onOpen);
  }, [onOpenChange]);
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog className="max-w-lg p-6">
        <DialogTitle>New ticket</DialogTitle>
        <div className="mt-4">
          <NewTicketForm onDone={() => onOpenChange(false)} />
        </div>
        <DialogClose />
      </Dialog>
    </DialogRoot>
  );
}

function NewTicketForm({ onDone }: { onDone: () => void }) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const organizationId = workspace.id;

  const create = useMutation({
    mutationFn: async () => {
      const contact = await unwrap(
        api.POST("/workspaces/{organizationId}/support/customers", {
          params: { path: { organizationId } },
          body: { email: email.trim(), fullName: fullName.trim() || undefined },
        })
      );
      return unwrap(
        api.POST("/workspaces/{organizationId}/support/tickets", {
          params: { path: { organizationId } },
          body: {
            customerId: contact.customer.id,
            title: title.trim(),
            sourceChannel: "api",
            externalSource: "manual",
            ...(message.trim()
              ? {
                  message: {
                    textContent: message.trim(),
                    channel: "api" as const,
                  },
                }
              : {}),
          },
        })
      );
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: wsKey(organizationId, "tickets"),
      });
      toastSuccess("Ticket created");
      onDone();
      await navigate({
        to: "/$slug/tickets/$ticketId",
        params: { slug: workspace.slug, ticketId: result.ticket.id },
      });
    },
    onError: (error) => toastError(error),
  });

  const valid = email.trim().length > 0 && title.trim().length > 0;

  return (
    <form
      aria-label="New ticket"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !create.isPending) create.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Customer email"
          type="email"
          value={email}
          required
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          label="Customer name"
          value={fullName}
          required={false}
          onChange={(e) => setFullName(e.target.value)}
        />
      </div>
      <Input
        label="Subject"
        value={title}
        required
        onChange={(e) => setTitle(e.target.value)}
      />
      <InputArea
        label="What did they say?"
        value={message}
        required={false}
        minRows={3}
        autoResize
        onValueChange={setMessage}
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={create.isPending}
          disabled={!valid}
        >
          Create ticket
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
