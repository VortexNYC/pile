import { Excalidraw } from "@excalidraw/excalidraw";

import "@excalidraw/excalidraw/index.css";

/** A canvas document — Excalidraw scene JSON stored as the document's
 * content (contentFormat: "canvas"). Same entity, same rails, same
 * shares as every other doc. */
export function CanvasEditor({
  sceneJson,
  onChange,
}: {
  sceneJson: string;
  onChange: (json: string) => void;
}) {
  const initial = (() => {
    try {
      return JSON.parse(sceneJson) as {
        elements?: unknown[];
        appState?: Record<string, unknown>;
      };
    } catch {
      return {};
    }
  })();

  return (
    <div className="h-[70vh] w-full rounded-lg border border-kumo-line overflow-hidden">
      <Excalidraw
        initialData={{
          elements: (initial.elements ?? []) as never,
          appState: initial.appState,
        }}
        onChange={(elements, appState) =>
          onChange(
            JSON.stringify({
              elements,
              appState: {
                ...appState,
                collaborators: undefined,
              },
            })
          )
        }
      />
    </div>
  );
}
