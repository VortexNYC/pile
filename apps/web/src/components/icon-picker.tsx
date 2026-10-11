import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Popover } from "@cloudflare/kumo/components/popover";
import { useState, type ReactElement } from "react";

const GROUPS: Array<{ label: string; icons: string[] }> = [
  {
    label: "Docs",
    icons: ["📄", "📝", "📋", "📌", "📎", "🗂️", "📚", "📖", "🧾", "📑"],
  },
  {
    label: "Work",
    icons: ["🎯", "🚀", "⚡", "🔧", "🧪", "🛠️", "🏗️", "🧩", "📊", "📈"],
  },
  {
    label: "People",
    icons: ["👤", "👥", "🤝", "🙋", "💬", "📣", "🤖", "👾", "🧠", "💡"],
  },
  {
    label: "States",
    icons: ["✅", "❌", "⏳", "🔥", "⭐", "❗", "🟢", "🟡", "🔴", "🚧"],
  },
  {
    label: "Objects",
    icons: ["🎨", "🖼️", "🗺️", "📦", "🔒", "🔑", "🏷️", "💾", "🗃️", "🎁"],
  },
];

const ALL = GROUPS.flatMap((g) => g.icons);

/** Notion's icon picker — emoji popover on entity icons. */
export function IconPicker({
  onSelect,
  onRemove,
  children,
}: {
  onSelect: (icon: string) => void;
  onRemove?: () => void;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groups = query
    ? [{ label: "Results", icons: ALL.filter((i) => i.includes(query)) }]
    : GROUPS;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={children} />
      <Popover.Content className="w-72 p-3">
        <div className="flex flex-col gap-2">
          <Input
            aria-label="Search icons"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex max-h-56 flex-col gap-3 overflow-auto">
            {groups.map((g) => (
              <div key={g.label}>
                <div className="pb-1 text-xs text-kumo-subtle">{g.label}</div>
                <div className="grid grid-cols-8 gap-1">
                  {g.icons.map((icon) => (
                    <button
                      key={icon}
                      type="button"
                      className="hover:bg-kumo-tint rounded-md p-1 text-lg"
                      onClick={() => {
                        onSelect(icon);
                        setOpen(false);
                      }}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {onRemove ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onRemove();
                setOpen(false);
              }}
            >
              Remove icon
            </Button>
          ) : null}
        </div>
      </Popover.Content>
    </Popover>
  );
}
