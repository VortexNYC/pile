import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import {
  Buildings,
  FileText,
  Headset,
  ListChecks,
  Plus,
  TrendUp,
  User,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";

import { usePermissions } from "@/hooks/use-permissions";
import { useWorkspace } from "@/hooks/use-workspace";

/** Header "+" — one entry per creatable surface, each opening its own
 * dialog form (or the document composer route). */
export function CreateMenu() {
  const workspace = useWorkspace();
  const permissions = usePermissions(workspace.id);
  const navigate = useNavigate();

  const items = [
    permissions.can("issue", "create") && (
      <DropdownMenu.Item
        key="issue"
        icon={<ListChecks />}
        onClick={() =>
          window.dispatchEvent(new CustomEvent("pile:create-issue"))
        }
      >
        New issue
      </DropdownMenu.Item>
    ),
    permissions.can("ticket", "create") && (
      <DropdownMenu.Item
        key="ticket"
        icon={<Headset />}
        onClick={() =>
          window.dispatchEvent(new CustomEvent("pile:create-ticket"))
        }
      >
        New ticket
      </DropdownMenu.Item>
    ),
    permissions.can("document", "create") && (
      <DropdownMenu.Item
        key="document"
        icon={<FileText />}
        onClick={() =>
          void navigate({
            to: "/$slug/documents/new",
            params: { slug: workspace.slug },
          })
        }
      >
        New document
      </DropdownMenu.Item>
    ),
    permissions.can("customer", "create") && (
      <DropdownMenu.Item
        key="customer"
        icon={<Buildings />}
        onClick={() =>
          window.dispatchEvent(new CustomEvent("pile:create-customer"))
        }
      >
        New company
      </DropdownMenu.Item>
    ),
    permissions.can("ticket", "create") && (
      <DropdownMenu.Item
        key="contact"
        icon={<User />}
        onClick={() =>
          window.dispatchEvent(new CustomEvent("pile:create-contact"))
        }
      >
        New contact
      </DropdownMenu.Item>
    ),
    permissions.can("deal", "create") && (
      <DropdownMenu.Item
        key="deal"
        icon={<TrendUp />}
        onClick={() =>
          window.dispatchEvent(new CustomEvent("pile:create-deal"))
        }
      >
        New deal
      </DropdownMenu.Item>
    ),
  ].filter(Boolean);

  if (items.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            shape="square"
            variant="ghost"
            icon={<Plus size={18} />}
            aria-label="Create"
          />
        }
      />
      <DropdownMenu.Content align="end" className="min-w-40">
        {items}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
