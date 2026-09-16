import { describe, expect, it } from "vitest";

import {
  applyCatalogMode,
  getCatalogMode,
  getCatalogProvider,
  validateProviderSetup,
} from "./catalog.js";

describe("agent provider catalog", () => {
  it("gives Codex a hosted cloud mode and a BYO mode", () => {
    const provider = getCatalogProvider("codex");
    expect(provider?.modes.map((mode) => mode.id)).toEqual(["hosted", "byo"]);
  });

  it("rejects hosted Codex without a token", () => {
    expect(() => validateProviderSetup("codex", "hosted", {})).toThrow(/token/);
  });

  it("rejects Cursor BYO without machine or pool name", () => {
    expect(() =>
      validateProviderSetup("cursor", "byo", {
        token: "ck-1",
        config: { env: { type: "pool" } },
      })
    ).toThrow(/config.env.name/);
  });

  it("accepts Devin hosted with token and org", () => {
    expect(() =>
      validateProviderSetup("devin", "hosted", {
        token: "devin-key",
        providerOrgId: "org-1",
      })
    ).not.toThrow();
  });

  it("stamps Codex environment from mode", () => {
    expect(applyCatalogMode("codex", "hosted", null).environment).toEqual({
      type: "openai_hosted",
    });
    expect(applyCatalogMode("codex", "byo", {}).environment).toEqual({
      type: "self_hosted",
    });
  });

  it("has no hosted mode for codex-cli", () => {
    expect(getCatalogMode("codex-cli", "hosted")).toBeUndefined();
  });
});
