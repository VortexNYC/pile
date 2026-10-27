import { Button } from "@cloudflare/kumo/components/button";
import { Highlighter, PenNib } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  annotateImageDataUrl,
  drawAnnotationOps,
  normalizePoint,
  type AnnotationOp,
  type AnnotationPoint,
} from "@/lib/annotation";

type Tool = "rect" | "pen";

/** In-dialog screenshot markup: drag to drop highlight rectangles or
 * freehand strokes, then Apply bakes them into the screenshot that gets
 * attached. Ops live in normalized 0–1 space so the small editor canvas
 * and the full-res composite stay in sync. */
export function FeedbackAnnotator({
  src,
  onApply,
  onCancel,
}: {
  src: string;
  onApply: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("rect");
  const [ops, setOps] = useState<AnnotationOp[]>([]);
  const [draft, setDraft] = useState<AnnotationOp | null>(null);
  const drawing = useRef<{ tool: Tool; from: AnnotationPoint } | null>(null);
  const [applying, setApplying] = useState(false);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !image || !ctx) return;
    // Keep canvas pixels aligned with the rendered image so normalized
    // ops land where the pointer actually was.
    const { clientWidth, clientHeight } = image;
    if (
      clientWidth > 0 &&
      clientHeight > 0 &&
      (canvas.width !== clientWidth || canvas.height !== clientHeight)
    ) {
      canvas.width = clientWidth;
      canvas.height = clientHeight;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawAnnotationOps(ctx, ops, canvas.width, canvas.height);
    if (draft) drawAnnotationOps(ctx, [draft], canvas.width, canvas.height);
  }, [ops, draft]);

  useEffect(() => {
    paint();
  }, [paint]);

  const pointFromEvent = (event: React.PointerEvent): AnnotationPoint => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0 || bounds.height === 0) {
      return { x: 0, y: 0 };
    }
    return normalizePoint(
      (event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant={tool === "rect" ? "primary" : "ghost"}
          icon={<Highlighter size={14} />}
          onClick={() => setTool("rect")}
        >
          Highlight
        </Button>
        <Button
          type="button"
          size="xs"
          variant={tool === "pen" ? "primary" : "ghost"}
          icon={<PenNib size={14} />}
          onClick={() => setTool("pen")}
        >
          Pen
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={ops.length === 0}
          onClick={() => setOps((prev) => prev.slice(0, -1))}
        >
          Undo
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={ops.length === 0}
          onClick={() => setOps([])}
        >
          Clear
        </Button>
      </div>
      <div className="relative">
        <img
          ref={imageRef}
          src={src}
          alt="Screenshot to annotate"
          onLoad={paint}
          className="border-kumo-line block w-full rounded border"
        />
        <canvas
          ref={canvasRef}
          aria-label="Annotation canvas"
          className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = pointFromEvent(event);
            drawing.current = { tool, from: point };
            setDraft(
              tool === "rect"
                ? { kind: "rect", from: point, to: point }
                : { kind: "stroke", points: [point] }
            );
          }}
          onPointerMove={(event) => {
            const current = drawing.current;
            if (!current) return;
            const point = pointFromEvent(event);
            setDraft((prev) =>
              current.tool === "rect"
                ? { kind: "rect", from: current.from, to: point }
                : prev?.kind === "stroke"
                  ? { kind: "stroke", points: [...prev.points, point] }
                  : prev
            );
          }}
          onPointerUp={() => {
            if (draft) setOps((prev) => [...prev, draft]);
            setDraft(null);
            drawing.current = null;
          }}
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="primary"
          loading={applying}
          disabled={ops.length === 0}
          onClick={async () => {
            setApplying(true);
            try {
              onApply(await annotateImageDataUrl(src, ops));
            } finally {
              setApplying(false);
            }
          }}
        >
          Apply annotation
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Back
        </Button>
      </div>
    </div>
  );
}
