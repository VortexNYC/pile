import { describe, expect, it, vi } from "vitest";

import { handleViewInPile } from "./actions.js";

describe("slack actions", () => {
  it("posts the Pile URL from the action value", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const thread = { post };
    const event = {
      value: "https://pile.nyc/org-1/issues/ISS-42",
      thread,
    };

    await handleViewInPile(event);

    expect(post).toHaveBeenCalledWith(
      "Open in Pile: https://pile.nyc/org-1/issues/ISS-42"
    );
  });

  it("does nothing when the value is missing", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const thread = { post };

    await handleViewInPile({ thread });

    expect(post).not.toHaveBeenCalled();
  });

  it("does nothing when the thread is missing", async () => {
    await expect(
      handleViewInPile({ value: "https://pile.nyc/org-1/issues/ISS-42" })
    ).resolves.toBeUndefined();
  });
});
