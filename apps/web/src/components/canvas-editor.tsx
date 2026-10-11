import { Button } from "@cloudflare/kumo/components/button";
import {
  ArrowRight,
  Cursor,
  Diamond,
  Hand,
  Minus,
  PencilSimple,
  Square,
  TextT,
  Circle,
} from "@phosphor-icons/react";
import { useState } from "react";

import { CanvasSurface, type Tool } from "./canvas/editor";

const TOOLS: Array<{ tool: Tool; icon: React.ReactNode; label: string }> = [
  { tool: "select", icon: <Cursor />, label: "Select (V)" },
  { tool: "pan", icon: <Hand />, label: "Pan (H)" },
  { tool: "rect", icon: <Square />, label: "Rectangle (R)" },
  { tool: "ellipse", icon: <Circle />, label: "Ellipse (O)" },
  { tool: "diamond", icon: <Diamond />, label: "Diamond (D)" },
  { tool: "arrow", icon: <ArrowRight />, label: "Arrow (A)" },
  { tool: "line", icon: <Minus />, label: "Line (L)" },
  { tool: "freedraw", icon: <PencilSimple />, label: "Draw (P)" },
  { tool: "text", icon: <TextT />, label: "Text (T)" },
];

/** Our own canvas — Kumo chrome over the scene engine. Scene JSON
 * lives in the document's content (contentFormat: "canvas"). */
export function CanvasEditor({
  sceneJson,
  onChange,
}: {
  sceneJson: string;
  onChange: (json: string) => void;
}) {
  const [tool, setTool] = useState<Tool>("select");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 rounded-lg border border-kumo-line bg-kumo-canvas p-1 w-fit">
        {TOOLS.map(({ tool: t, icon, label }) => (
          <Button
            key={t}
            variant={tool === t ? "secondary" : "ghost"}
            size="sm"
            icon={icon}
            aria-label={label}
            title={label}
            onClick={() => setTool(t)}
          />
        ))}
      </div>
      <CanvasSurface
        sceneJson={sceneJson}
        tool={tool}
        onChange={onChange}
        onToolUsed={() => setTool("select")}
      />
      <div className="text-xs text-kumo-subtle">
        Scroll to pan · ⌘scroll to zoom · Delete removes selection
      </div>
    </div>
  );
}
