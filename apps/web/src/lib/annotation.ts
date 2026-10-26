/** Screenshot annotation for the feedback bubble — Jam's "mark it up"
 * step. Ops are stored in normalized 0–1 coordinates so the small
 * dialog canvas and the full-resolution composite share one op list. */

export interface AnnotationPoint {
  x: number;
  y: number;
}

export type AnnotationOp =
  | { kind: "rect"; from: AnnotationPoint; to: AnnotationPoint }
  | { kind: "stroke"; points: AnnotationPoint[] };

export const ANNOTATION_COLOR = "#f43f5e";
export const ANNOTATION_LINE_WIDTH = 3;

/** Clamp a pointer position into the 0–1 normalized space. */
export function normalizePoint(x: number, y: number): AnnotationPoint {
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Two dragged corners → an upright rectangle. */
export function normalizeRect(
  from: AnnotationPoint,
  to: AnnotationPoint
): NormalizedRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** The subset of CanvasRenderingContext2D the ops draw through — a real
 * 2D context satisfies it, and tests can stub it without DOM canvas. */
export interface AnnotationContext {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

export function drawAnnotationOp(
  ctx: AnnotationContext,
  op: AnnotationOp,
  width: number,
  height: number
): void {
  ctx.strokeStyle = ANNOTATION_COLOR;
  ctx.fillStyle = "rgba(244, 63, 94, 0.18)";
  ctx.lineWidth = ANNOTATION_LINE_WIDTH;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (op.kind === "rect") {
    const rect = normalizeRect(op.from, op.to);
    ctx.fillRect(
      rect.x * width,
      rect.y * height,
      rect.width * width,
      rect.height * height
    );
    ctx.strokeRect(
      rect.x * width,
      rect.y * height,
      rect.width * width,
      rect.height * height
    );
    return;
  }
  if (op.points.length === 0) return;
  ctx.beginPath();
  const first = op.points[0]!;
  ctx.moveTo(first.x * width, first.y * height);
  for (const point of op.points.slice(1)) {
    ctx.lineTo(point.x * width, point.y * height);
  }
  ctx.stroke();
}

export function drawAnnotationOps(
  ctx: AnnotationContext,
  ops: AnnotationOp[],
  width: number,
  height: number
): void {
  for (const op of ops) {
    drawAnnotationOp(ctx, op, width, height);
  }
}

/** Composite the screenshot + annotation ops at full resolution and
 * return a fresh PNG data URL. Browser-only (Image + canvas). */
export async function annotateImageDataUrl(
  dataUrl: string,
  ops: AnnotationOp[]
): Promise<string> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.addEventListener("load", () => resolve(el));
    el.addEventListener("error", () =>
      reject(new Error("Failed to load screenshot for annotation"))
    );
    el.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width === 0 || canvas.height === 0) {
    return dataUrl;
  }
  ctx.drawImage(image, 0, 0);
  drawAnnotationOps(ctx, ops, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
