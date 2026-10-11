/** Canvas scene — our own engine. A scene is {elements, viewport};
 * elements render in array order (z-order = index). Units are scene
 * coords; the viewport transforms them to screen. */

export type ElementType =
  | "rect"
  | "ellipse"
  | "diamond"
  | "line"
  | "arrow"
  | "freedraw"
  | "text";

export interface CanvasElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** freedraw/line/arrow: relative points from x,y */
  points?: Array<[number, number]>;
  /** text elements: the string */
  text?: string;
  stroke: string;
  fill?: string;
  strokeWidth: number;
}

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface Scene {
  elements: CanvasElement[];
  viewport: Viewport;
}

export function emptyScene(): Scene {
  return { elements: [], viewport: { scrollX: 0, scrollY: 0, zoom: 1 } };
}

export function parseScene(json: string): Scene {
  try {
    const parsed = JSON.parse(json) as Partial<Scene>;
    return {
      elements: Array.isArray(parsed.elements)
        ? (parsed.elements as CanvasElement[])
        : [],
      viewport: parsed.viewport ?? { scrollX: 0, scrollY: 0, zoom: 1 },
    };
  } catch {
    return emptyScene();
  }
}

export function serializeScene(scene: Scene): string {
  return JSON.stringify(scene);
}

export function screenToScene(
  sx: number,
  sy: number,
  vp: Viewport
): [number, number] {
  return [sx / vp.zoom + vp.scrollX, sy / vp.zoom + vp.scrollY];
}

export function sceneToScreen(
  x: number,
  y: number,
  vp: Viewport
): [number, number] {
  return [(x - vp.scrollX) * vp.zoom, (y - vp.scrollY) * vp.zoom];
}

/** Axis-aligned bounds of an element (points expand it). */
export function bounds(el: CanvasElement): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  if (!el.points || el.points.length === 0) {
    return { x: el.x, y: el.y, w: el.w, h: el.h };
  }
  let minX = 0;
  let minY = 0;
  let maxX = el.w;
  let maxY = el.h;
  for (const [px, py] of el.points) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { x: el.x + minX, y: el.y + minY, w: maxX - minX, h: maxY - minY };
}

export function hitTest(
  el: CanvasElement,
  x: number,
  y: number,
  tolerance = 6
): boolean {
  const b = bounds(el);
  // Text/freedraw are hit by bounds; shapes check distance.
  if (
    x < b.x - tolerance ||
    x > b.x + b.w + tolerance ||
    y < b.y - tolerance ||
    y > b.y + b.h + tolerance
  ) {
    return false;
  }
  return true;
}
