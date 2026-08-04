import { describe, expect, it } from "vitest";

import {
  type RegisteredBrowserHost,
  selectBrowserHost,
  type SelectBrowserHostInput,
} from "./browserHostSelection";

function host(overrides: Partial<RegisteredBrowserHost> = {}): RegisteredBrowserHost {
  return {
    connectionId: "conn-a",
    environmentId: "env-1",
    supportedOperations: new Set(["open", "snapshot", "click"]),
    focused: false,
    focusOrder: 0,
    ...overrides,
  };
}

function select(overrides: Partial<SelectBrowserHostInput> = {}) {
  return selectBrowserHost({
    hosts: [],
    environmentId: "env-1",
    operation: "click",
    ...overrides,
  });
}

describe("selectBrowserHost", () => {
  it("reports no-host when nothing is registered for the environment", () => {
    expect(select({ hosts: [] })).toEqual({ kind: "no-host" });
  });

  it("reports no-host when the only registered desktop is for another environment", () => {
    expect(select({ hosts: [host({ environmentId: "env-2" })] })).toEqual({ kind: "no-host" });
  });

  it("reports unsupported when a desktop is registered but lacks the operation", () => {
    // Distinct from no-host: a browser IS attached, it just can't do this — the
    // caller can say which, e.g. "your desktop is on an older build".
    expect(
      select({ hosts: [host({ supportedOperations: new Set(["open"]) })], operation: "click" }),
    ).toEqual({ kind: "unsupported" });
  });

  it("selects the only eligible host", () => {
    expect(select({ hosts: [host({ connectionId: "only" })] })).toEqual({
      kind: "selected",
      connectionId: "only",
    });
  });

  it("scopes selection to the request's environment", () => {
    expect(
      select({
        hosts: [
          host({ connectionId: "other-env", environmentId: "env-2" }),
          host({ connectionId: "mine" }),
        ],
        environmentId: "env-1",
      }),
    ).toEqual({ kind: "selected", connectionId: "mine" });
  });

  describe("ranking", () => {
    it("prefers the more capable window", () => {
      expect(
        select({
          hosts: [
            host({ connectionId: "narrow", supportedOperations: new Set(["click"]) }),
            host({
              connectionId: "broad",
              supportedOperations: new Set(["open", "snapshot", "click"]),
            }),
          ],
        }),
      ).toEqual({ kind: "selected", connectionId: "broad" });
    });

    it("prefers the focused window when capability ties", () => {
      expect(
        select({
          hosts: [
            host({ connectionId: "background", focused: false, focusOrder: 9 }),
            host({ connectionId: "foreground", focused: true, focusOrder: 1 }),
          ],
        }),
      ).toEqual({ kind: "selected", connectionId: "foreground" });
    });

    it("prefers the most recently focused when capability and focus tie", () => {
      expect(
        select({
          hosts: [
            host({ connectionId: "stale", focusOrder: 2 }),
            host({ connectionId: "recent", focusOrder: 8 }),
          ],
        }),
      ).toEqual({ kind: "selected", connectionId: "recent" });
    });

    it("capability outranks focus", () => {
      // A focused but less-capable window must not beat an unfocused more-capable
      // one: keeping work on the capable window avoids a mid-interaction switch.
      expect(
        select({
          hosts: [
            host({
              connectionId: "focused-narrow",
              focused: true,
              supportedOperations: new Set(["click"]),
            }),
            host({
              connectionId: "unfocused-broad",
              focused: false,
              supportedOperations: new Set(["open", "snapshot", "click"]),
            }),
          ],
        }),
      ).toEqual({ kind: "selected", connectionId: "unfocused-broad" });
    });
  });

  describe("lease", () => {
    it("stays on the leased host so a multi-step interaction keeps one browser", () => {
      // The leased host is LESS preferred by ranking, but the interaction opened
      // its page there — a click must not jump to a browser that never opened it.
      const selection = select({
        hosts: [
          host({ connectionId: "leased", focused: false, focusOrder: 0 }),
          host({ connectionId: "shinier", focused: true, focusOrder: 9 }),
        ],
        lease: { connectionId: "leased" },
      });
      expect(selection).toEqual({ kind: "selected", connectionId: "leased" });
    });

    it("fails over to a fresh ranking when the leased host is gone", () => {
      // The desktop holding the interaction closed; the click should reassign
      // rather than fail, so the agent can re-open on a live browser.
      expect(
        select({
          hosts: [host({ connectionId: "survivor" })],
          lease: { connectionId: "dead" },
        }),
      ).toEqual({ kind: "selected", connectionId: "survivor" });
    });

    it("ignores a lease whose host no longer supports the operation", () => {
      expect(
        select({
          hosts: [
            host({ connectionId: "leased", supportedOperations: new Set(["open"]) }),
            host({ connectionId: "capable", supportedOperations: new Set(["open", "click"]) }),
          ],
          operation: "click",
          lease: { connectionId: "leased" },
        }),
      ).toEqual({ kind: "selected", connectionId: "capable" });
    });

    it("reports unavailability, not a stale lease, when the environment has no hosts", () => {
      expect(select({ hosts: [], lease: { connectionId: "leased" } })).toEqual({ kind: "no-host" });
    });
  });

  it("does not mutate the caller's host array", () => {
    const hosts = [
      host({ connectionId: "a", focusOrder: 1 }),
      host({ connectionId: "b", focusOrder: 9 }),
    ];
    const order = hosts.map((h) => h.connectionId);
    selectBrowserHost({ hosts, environmentId: "env-1", operation: "click" });
    expect(hosts.map((h) => h.connectionId)).toEqual(order);
  });
});
