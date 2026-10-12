import { useCallback, useEffect, useRef, useState } from "react";

import {
  bounds,
  hitTest,
  parseScene,
  screenToScene,
  serializeScene,
  type CanvasElement,
  type ElementType,
  type Scene,
} from "./scene";

export type Tool = ElementType | "select" | "pan";

const STROKE = "#1f2937";
const SELECT = "#2563eb";

/** Rough-sketch path — jitter gives it the hand-drawn feel. */
function traceShape(ctx: CanvasRenderingContext2D, el: CanvasElement) {
  const { x, y, w, h } = el;
  ctx.beginPath();
  switch (el.type) {
    case "rect":
      ctx.rect(x, y, w, h);
      break;
    case "diamond":
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w / 2, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
      break;
    case "ellipse":
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "line":
    case "arrow":
    case "freedraw": {
      const pts = el.points ?? [];
      if (pts.length === 0) break;
      ctx.moveTo(x + pts[0]![0], y + pts[0]![1]);
      for (const [px, py] of pts.slice(1)) ctx.lineTo(x + px, y + py);
      break;
    }
    case "text":
      break;
  }
}

function drawElement(ctx: CanvasRenderingContext2D, el: CanvasElement) {
  ctx.strokeStyle = el.stroke;
  ctx.lineWidth = el.strokeWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (el.type === "text") {
    ctx.font = `${16 * (el.strokeWidth || 2)}px system-ui`;
    ctx.fillStyle = el.stroke;
    ctx.fillText(el.text ?? "", el.x, el.y);
    return;
  }

  if (el.type === "freedraw" || el.type === "line") {
    traceShape(ctx, el);
    ctx.stroke();
    return;
  }
  if (el.type === "arrow") {
    traceShape(ctx, el);
    ctx.stroke();
    const pts = el.points ?? [];
    if (pts.length >= 2) {
      const [x1, y1] = pts[pts.length - 2]!;
      const [x2, y2] = pts[pts.length - 1]!;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const len = 10 + el.strokeWidth * 2;
      ctx.beginPath();
      ctx.moveTo(el.x + x2, el.y + y2);
      ctx.lineTo(
        el.x + x2 - len * Math.cos(angle - 0.4),
        el.y + y2 - len * Math.sin(angle - 0.4)
      );
      ctx.moveTo(el.x + x2, el.y + y2);
      ctx.lineTo(
        el.x + x2 - len * Math.cos(angle + 0.4),
        el.y + y2 - len * Math.sin(angle + 0.4)
      );
      ctx.stroke();
    }
    return;
  }
  // closed shapes
  traceShape(ctx, el);
  if (el.fill) {
    ctx.fillStyle = el.fill;
    ctx.fill();
  }
  ctx.stroke();
}

interface Drag {
  mode: "draw" | "move" | "pan" | "marquee";
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  draft?: CanvasElement;
  moved?: boolean;
}

export function CanvasSurface({
  sceneJson,
  onChange,
  tool,
  onToolUsed,
}: {
  sceneJson: string;
  onChange: (json: string) => void;
  tool: Tool;
  onToolUsed?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene>(parseScene(sceneJson));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [, force] = useState(0);

  // hydrate external changes (doc refetch) when idle
  useEffect(() => {
    if (!dragRef.current) sceneRef.current = parseScene(sceneJson);
  }, [sceneJson]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { viewport } = sceneRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.save();
    ctx.scale(viewport.zoom, viewport.zoom);
    ctx.translate(-viewport.scrollX, -viewport.scrollY);
    for (const el of sceneRef.current.elements) drawElement(ctx, el);
    if (dragRef.current?.draft) drawElement(ctx, dragRef.current.draft);
    const selected = sceneRef.current.elements.find((e) => e.id === selectedId);
    if (selected) {
      const b = bounds(selected);
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = 1 / viewport.zoom;
      ctx.setLineDash([4 / viewport.zoom, 4 / viewport.zoom]);
      ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }, [selectedId]);

  useEffect(() => {
    redraw();
    const onResize = () => redraw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [redraw]);

  const commit = useCallback(() => {
    onChange(serializeScene(sceneRef.current));
  }, [onChange]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const [x, y] = screenToScene(
      e.clientX - rect.left,
      e.clientY - rect.top,
      sceneRef.current.viewport
    );

    if (tool === "pan" || e.button === 1 || e.shiftKey) {
      dragRef.current = {
        mode: "pan",
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
      };
      return;
    }
    if (tool === "select") {
      const hit = [...sceneRef.current.elements]
        .toReversed()
        .find((el) => hitTest(el, x, y));
      setSelectedId(hit?.id ?? null);
      if (hit) {
        dragRef.current = {
          mode: "move",
          startX: x,
          startY: y,
          lastX: x,
          lastY: y,
        };
      }
      force((n) => n + 1);
      return;
    }
    // drawing tools
    const base: CanvasElement = {
      id: crypto.randomUUID(),
      type: tool as ElementType,
      x,
      y,
      w: 0,
      h: 0,
      stroke: STROKE,
      strokeWidth: 2,
    };
    if (tool === "freedraw" || tool === "line" || tool === "arrow") {
      base.points = [[0, 0]];
    }
    if (tool === "text") {
      const text = window.prompt("Text");
      if (text) {
        base.text = text;
        base.w = text.length * 8;
        base.h = 20;
        sceneRef.current.elements.push(base);
        commit();
      }
      onToolUsed?.();
      return;
    }
    dragRef.current = {
      mode: "draw",
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      draft: base,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const [x, y] = screenToScene(
      e.clientX - rect.left,
      e.clientY - rect.top,
      sceneRef.current.viewport
    );
    drag.moved = true;

    if (drag.mode === "pan") {
      const vp = sceneRef.current.viewport;
      vp.scrollX -= x - drag.lastX;
      vp.scrollY -= y - drag.lastY;
    } else if (drag.mode === "move" && selectedId) {
      const el = sceneRef.current.elements.find((s) => s.id === selectedId);
      if (el) {
        el.x += x - drag.lastX;
        el.y += y - drag.lastY;
      }
    } else if (drag.mode === "draw" && drag.draft) {
      const el = drag.draft;
      if (el.type === "freedraw") {
        el.points!.push([x - el.x, y - el.y]);
      } else if (el.type === "line" || el.type === "arrow") {
        el.points = [
          [0, 0],
          [x - el.x, y - el.y],
        ];
        el.w = x - el.x;
        el.h = y - el.y;
      } else {
        el.w = x - el.x;
        el.h = y - el.y;
      }
    }
    drag.lastX = x;
    drag.lastY = y;
    redraw();
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.mode === "draw" && drag.draft && drag.moved) {
      // normalize negative dims
      const el = drag.draft;
      if (el.w < 0) {
        el.x += el.w;
        el.w = -el.w;
      }
      if (el.h < 0) {
        el.y += el.h;
        el.h = -el.h;
      }
      sceneRef.current.elements.push(el);
      commit();
      onToolUsed?.();
    } else if (drag.mode === "move" && drag.moved) {
      commit();
    }
    redraw();
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const vp = sceneRef.current.viewport;
    if (e.metaKey || e.ctrlKey) {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const [x, y] = screenToScene(sx, sy, vp);
      const next = Math.min(
        4,
        Math.max(0.2, vp.zoom * (e.deltaY > 0 ? 0.9 : 1.1))
      );
      vp.zoom = next;
      // keep the zoom centred on the pointer
      const [nx, ny] = screenToScene(sx, sy, vp);
      vp.scrollX += x - nx;
      vp.scrollY += y - ny;
    } else {
      vp.scrollX += e.deltaX / vp.zoom;
      vp.scrollY += e.deltaY / vp.zoom;
    }
    commit();
    redraw();
  };

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!selectedId) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        sceneRef.current.elements = sceneRef.current.elements.filter(
          (el) => el.id !== selectedId
        );
        setSelectedId(null);
        commit();
        redraw();
      }
    },
    [selectedId, commit, redraw]
  );
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  return (
    <canvas
      ref={canvasRef}
      className="h-[70vh] w-full rounded-lg border border-kumo-line bg-white touch-none"
      style={{ cursor: tool === "pan" ? "grab" : "crosshair" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    />
  );
}
