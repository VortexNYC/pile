import { describe, expect, it } from "vitest";

import { createKeychain, isClipperSession, SESSION_KEY } from "./keychain.js";

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of list) {
        if (key in data) {
          result[key] = data[key];
        }
      }
      return result;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        delete data[key];
      }
    },
    data,
  };
}

const session = {
  baseUrl: "https://pile.nyc",
  token: "tok_write",
  workspaceId: "org_vortex_main",
  workspaceName: "Vortex",
  workspaceSlug: "vortex",
};

describe("clipper keychain", () => {
  it("stores and reads a workspace-scoped session", async () => {
    const storage = memoryStorage();
    const keychain = createKeychain(storage);

    await keychain.setSession(session);

    expect(storage.data[SESSION_KEY]).toEqual(session);
    await expect(keychain.getSession()).resolves.toEqual(session);
  });

  it("returns null when storage is empty or invalid", async () => {
    const empty = createKeychain(memoryStorage());
    await expect(empty.getSession()).resolves.toBeNull();

    const invalid = createKeychain(
      memoryStorage({ [SESSION_KEY]: { token: "x" } })
    );
    await expect(invalid.getSession()).resolves.toBeNull();
  });

  it("clears the stored session", async () => {
    const storage = memoryStorage({ [SESSION_KEY]: session });
    const keychain = createKeychain(storage);

    await keychain.clearSession();

    expect(storage.data[SESSION_KEY]).toBeUndefined();
    await expect(keychain.getSession()).resolves.toBeNull();
  });

  it("rejects incomplete sessions", async () => {
    const keychain = createKeychain(memoryStorage());
    await expect(
      keychain.setSession({ token: "x", workspaceId: "org" })
    ).rejects.toThrow("Invalid clipper session");
  });

  it("accepts only complete session objects", () => {
    expect(isClipperSession(session)).toBe(true);
    expect(isClipperSession(null)).toBe(false);
    expect(isClipperSession({ ...session, token: "" })).toBe(false);
  });
});
