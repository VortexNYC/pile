import { Button } from "@cloudflare/kumo/components/button";
import {
  Dialog,
  DialogClose,
  DialogRoot,
  DialogTitle,
} from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useWorkspace, wsKey } from "@/hooks/use-workspace";
import { api, unwrap } from "@/lib/api";
import { fetchAllCustomers } from "@/lib/crm-lists";
import { toastError, toastSuccess } from "@/lib/toast";

interface EditableContact {
  id: string;
  email: string;
  fullName: string | null;
  phone: string | null;
}

/** POST body for a new contact — company link only when one was picked. */
export function newContactBody(input: {
  email: string;
  fullName: string;
  phone: string;
  customerId: string;
}) {
  return {
    email: input.email.trim(),
    fullName: input.fullName.trim() || undefined,
    phone: input.phone.trim() || undefined,
    companies: input.customerId
      ? [{ companyId: input.customerId, isPrimary: true }]
      : undefined,
  };
}

/** New/edit-contact dialog — people behind tickets and deals. Create
 * fires from `pile:create-contact`; edit mounts controlled on the
 * contact page. */
export function ContactDialog({
  contact,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: {
  contact?: EditableContact;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internal, setInternal] = useState(false);
  const open = openProp ?? internal;
  const onOpenChange = onOpenChangeProp ?? setInternal;
  useEffect(() => {
    // Controlled mounts (edit mode) open themselves — only the
    // workspace-mounted instance answers the create event.
    if (openProp !== undefined) return;
    const onOpen = () => onOpenChange(true);
    window.addEventListener("pile:create-contact", onOpen);
    return () => window.removeEventListener("pile:create-contact", onOpen);
  }, [onOpenChange, openProp]);

  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState(contact?.email ?? "");
  const [fullName, setFullName] = useState(contact?.fullName ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [customerId, setCustomerId] = useState("");

  const companies = useQuery({
    queryKey: wsKey(workspace.id, "customers", "summary"),
    queryFn: () =>
      fetchAllCustomers({ organizationId: workspace.id, summary: true }),
    enabled: open && !contact,
  });

  const key = wsKey(workspace.id, "contacts");
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({
        queryKey: wsKey(workspace.id, "palette-customers"),
      }),
    ]);

  const save = useMutation({
    mutationFn: () =>
      contact
        ? unwrap(
            api.PATCH(
              "/workspaces/{organizationId}/support/customers/{customerId}",
              {
                params: {
                  path: {
                    organizationId: workspace.id,
                    customerId: contact.id,
                  },
                },
                body: {
                  email: email.trim(),
                  fullName: fullName.trim() || undefined,
                  phone: phone.trim() || undefined,
                },
              }
            )
          )
        : unwrap(
            api.POST("/workspaces/{organizationId}/support/customers", {
              params: { path: { organizationId: workspace.id } },
              body: newContactBody({ email, fullName, phone, customerId }),
            })
          ),
    onSuccess: () => {
      if (!contact) {
        setEmail("");
        setFullName("");
        setPhone("");
        setCustomerId("");
      }
      onOpenChange(false);
      toastSuccess(contact ? "Contact saved" : "Contact added");
    },
    onError: (error) => toastError(error),
    onSettled: invalidate,
  });

  const valid = email.trim().length > 0;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog className="max-w-sm p-6">
        <DialogTitle>{contact ? "Edit contact" : "New contact"}</DialogTitle>
        <form
          aria-label={contact ? "Edit contact" : "New contact"}
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !save.isPending) save.mutate();
          }}
        >
          <Input
            label="Name"
            value={fullName}
            required={false}
            onChange={(e) => setFullName(e.target.value)}
          />
          <Input
            label="Email"
            type="email"
            value={email}
            required
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Phone"
            value={phone}
            required={false}
            onChange={(e) => setPhone(e.target.value)}
          />
          {contact ? null : (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-kumo-subtle">
                Company
              </label>
              <Select
                aria-label="Company"
                value={customerId}
                onValueChange={(v) => setCustomerId(v ?? "")}
                placeholder="No company"
              >
                {(companies.data ?? []).map((c) => (
                  <Select.Option key={c.id} value={c.id}>
                    {c.name}
                  </Select.Option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending}
              disabled={!valid}
            >
              {contact ? "Save" : "Add contact"}
            </Button>
          </div>
        </form>
        <DialogClose />
      </Dialog>
    </DialogRoot>
  );
}
