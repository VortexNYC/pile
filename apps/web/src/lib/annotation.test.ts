import { describe, expect, it } from "vitest";

import {
  ANNOTATION_COLOR,
  type AnnotationContext,
  drawAnnotationOps,
  normalizePoint,
  normalizeRect,
} from "./annotation";

describe("normalizePoint", () => {
  it("clamps into the 0–1 range", () => {
    expect(normalizePoint(0.5, 0.5)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizePoint(-1, 2)).toEqual({ x: 0, y: 1 });
  });
});

describe("normalizeRect", () => {
  it("uprights a rect dragged from any corner", () => {
    const rect = normalizeRect({ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.1 });
    expect(rect.x).toBeCloseTo(0.2);
    expect(rect.y).toBeCloseTo(0.1);
    expect(rect.width).toBeCloseTo(0.6);
    expect(rect.height).toBeCloseTo(0.8);
  });

  it("handles already-upright drags", () => {
    const rect = normalizeRect({ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6 });
    expect(rect.x).toBeCloseTo(0.1);
    expect(rect.y).toBeCloseTo(0.2);
    expect(rect.width).toBeCloseTo(0.3);
    expect(rect.height).toBeCloseTo(0.4);
  });
});

function recordingCtx(): AnnotationContext & {
  calls: { method: string; args: number[] }[];
} {
  const calls: { method: string; args: number[] }[] = [];
  const record =
    (method: string) =>
    (...args: number[]) => {
      calls.push({ method, args });
    };
  return {
    calls,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    lineJoin: "miter",
    lineCap: "butt",
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
    strokeRect: record("strokeRect"),
    fillRect: record("fillRect"),
  };
}

describe("drawAnnotationOps", () => {
  it("scales a rect op into canvas pixels and fills + strokes it", () => {
    const ctx = recordingCtx();
    drawAnnotationOps(
      ctx,
      [{ kind: "rect", from: { x: 0, y: 0 }, to: { x: 0.5, y: 0.25 } }],
      200,
      400
    );
    expect(ctx.fillStyle).toBe("rgba(244, 63, 94, 0.18)");
    expect(ctx.strokeStyle).toBe(ANNOTATION_COLOR);
    expect(ctx.calls).toContainEqual({
      method: "fillRect",
      args: [0, 0, 100, 100],
    });
    expect(ctx.calls).toContainEqual({
      method: "strokeRect",
      args: [0, 0, 100, 100],
    });
  });

  it("draws a stroke through every point", () => {
    const ctx = recordingCtx();
    drawAnnotationOps(
      ctx,
      [
        {
          kind: "stroke",
          points: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.5 },
            { x: 1, y: 1 },
          ],
        },
      ],
      100,
      100
    );
    expect(ctx.calls).toEqual([
      { method: "beginPath", args: [] },
      { method: "moveTo", args: [0, 0] },
      { method: "lineTo", args: [50, 50] },
      { method: "lineTo", args: [100, 100] },
      { method: "stroke", args: [] },
    ]);
  });

  it("skips empty strokes", () => {
    const ctx = recordingCtx();
    drawAnnotationOps(ctx, [{ kind: "stroke", points: [] }], 100, 100);
    expect(ctx.calls).toEqual([]);
  });
});
