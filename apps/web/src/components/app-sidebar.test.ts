import { describe, expect, it } from "vitest";

import { navItemVisible, visibleSettingsPaths } from "./app-sidebar";

describe("visibleSettingsPaths", () => {
  it("shows Developer to members — self-serve API keys are not admin-gated", () => {
    const paths = visibleSettingsPaths(false);
    expect(paths).toContain("settings/developer");
  });

  it("keeps admin-only settings hidden from members", () => {
    const paths = visibleSettingsPaths(false);
    expect(paths).not.toContain("settings");
    expect(paths).not.toContain("settings/roles");
    expect(paths).not.toContain("settings/agents");
  });

  it("shows every settings page to admins", () => {
    const paths = visibleSettingsPaths(true);
    expect(paths).toEqual([
      "settings",
      "settings/members",
      "settings/roles",
      "settings/surfaces",
      "settings/fields",
      "settings/developer",
      "settings/agents",
    ]);
  });
});

describe("navItemVisible (PILE-652)", () => {
  it("keeps chrome mounted while permissions are in flight or errored", () => {
    expect(navItemVisible(false, false)).toBe(true);
    expect(navItemVisible(false, true)).toBe(true);
  });

  it("hides a surface only on a loaded, explicit denial", () => {
    expect(navItemVisible(true, false)).toBe(false);
    expect(navItemVisible(true, true)).toBe(true);
  });
});
