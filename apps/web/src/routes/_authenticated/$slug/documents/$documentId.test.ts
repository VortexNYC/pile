import { describe, expect, it } from "vitest";

import { wsKey } from "@/hooks/use-workspace";

import { documentAncestors, documentIndexQueryKey } from "./$documentId";

const doc = (id: string, parentDocumentId: string | null = null) => ({
  id,
  parentDocumentId,
});

describe("documentIndexQueryKey (PILE-652)", () => {
  it("is distinct from the full-shape documents list key", () => {
    expect(documentIndexQueryKey("org-1")).not.toEqual(
      wsKey("org-1", "documents")
    );
  });

  it("stays inside the documents subtree so list invalidations still reach it", () => {
    const key = documentIndexQueryKey("org-1");
    const prefix = wsKey("org-1", "documents");
    expect(key.slice(0, prefix.length)).toEqual([...prefix]);
  });
});

describe("documentAncestors", () => {
  it("walks parents root-first for the breadcrumb", () => {
    const docs = [doc("root"), doc("mid", "root"), doc("leaf", "mid")];
    expect(documentAncestors(docs, "mid").map((d) => d.id)).toEqual([
      "root",
      "mid",
    ]);
  });

  it("stops at a missing parent and at the root", () => {
    const docs = [doc("leaf", "ghost")];
    expect(documentAncestors(docs, "ghost")).toEqual([]);
    expect(documentAncestors(docs, null)).toEqual([]);
  });

  it("caps traversal so a parent cycle terminates", () => {
    const docs = [doc("a", "b"), doc("b", "a")];
    expect(documentAncestors(docs, "a").length).toBeLessThanOrEqual(6);
  });
});
