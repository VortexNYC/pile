import { PreviewCard } from "@base-ui/react/preview-card";

/** The hover-peek grammar — every entity's preview card: meta chips,
 * title, clipped description. Same shape as IssuePeek, entity-agnostic.
 * Wrap any link/row with the data you already have. */
export function EntityHover({
  meta,
  title,
  description,
  children,
}: {
  meta?: React.ReactNode;
  title: string;
  description?: string | null;
  children: React.ReactElement;
}) {
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={children} />
      <PreviewCard.Portal>
        <PreviewCard.Positioner>
          <PreviewCard.Popup className="border-kumo-line bg-kumo-canvas w-80 rounded-lg border p-4 shadow-lg">
            <div className="flex flex-col gap-2">
              {meta ? (
                <div className="flex items-center gap-2">{meta}</div>
              ) : null}
              <p className="text-sm font-medium text-kumo-default">{title}</p>
              {description ? (
                <p className="text-xs text-kumo-subtle line-clamp-3">
                  {description}
                </p>
              ) : null}
            </div>
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
