import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { SlidersHorizontal } from "@phosphor-icons/react";

export interface DisplayOptions {
  ordering: "updated" | "created" | "priority";
  showEmptyGroups: boolean;
}

export const DEFAULT_DISPLAY: DisplayOptions = {
  ordering: "updated",
  showEmptyGroups: false,
};

/** Linear's Display menu — ordering + visibility toggles beside
 * Filter on the issues list. */
export function IssueDisplayMenu({
  value,
  onChange,
}: {
  value: DisplayOptions;
  onChange: (v: DisplayOptions) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="ghost" icon={<SlidersHorizontal />}>
            Display
          </Button>
        }
      />
      <DropdownMenu.Content className="min-w-44">
        <DropdownMenu.Label>Order by</DropdownMenu.Label>
        <DropdownMenu.RadioGroup
          value={value.ordering}
          onValueChange={(v) =>
            onChange({
              ...value,
              ordering: v as DisplayOptions["ordering"],
            })
          }
        >
          <DropdownMenu.RadioItem value="updated">
            Updated
          </DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="created">
            Created
          </DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="priority">
            Priority
          </DropdownMenu.RadioItem>
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator />
        <DropdownMenu.CheckboxItem
          checked={value.showEmptyGroups}
          onCheckedChange={(checked) =>
            onChange({ ...value, showEmptyGroups: checked === true })
          }
        >
          Show empty groups
        </DropdownMenu.CheckboxItem>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
