import { Menu } from "@base-ui/react/menu";

const itemClass =
  "flex cursor-default items-center px-3 py-1.5 text-sm text-kumo-default outline-none data-[highlighted]:bg-kumo-tint";
const labelClass = "px-3 py-1 text-xs font-medium text-kumo-subtle";

/** Click a field chip → pick a value → the parent PATCHes it. The
 * inline-edit primitive behind issue/project field menus. */
export function FieldMenu({
  title,
  options,
  labels,
  onSelect,
  children,
}: {
  title: string;
  options: readonly string[];
  labels: Record<string, string>;
  onSelect: (value: string) => void;
  children: React.ReactElement;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger render={children} />
      <Menu.Portal>
        <Menu.Positioner>
          <Menu.Popup className="border-kumo-line bg-kumo-canvas min-w-36 rounded-lg border p-1 shadow-lg">
            <Menu.Group>
              <Menu.GroupLabel className={labelClass}>{title}</Menu.GroupLabel>
              {options.map((option) => (
                <Menu.Item
                  key={option}
                  className={itemClass}
                  onClick={() => onSelect(option)}
                >
                  {labels[option] ?? option}
                </Menu.Item>
              ))}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
