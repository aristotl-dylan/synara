import { describe, expect, it } from "vitest";

import {
  type BrowserHostRegistryState,
  EMPTY_BROWSER_HOST_REGISTRY,
  focusBrowserHost,
  registerBrowserHost,
  routeBrowserCall,
  unregisterBrowserHost,
} from "./browserHostRegistry";

function register(
  state: BrowserHostRegistryState,
  connectionId: string,
  overrides: { environmentId?: string; operations?: string[] } = {},
): BrowserHostRegistryState {
  return registerBrowserHost(state, {
    connectionId,
    environmentId: overrides.environmentId ?? "env-1",
    supportedOperations: new Set(overrides.operations ?? ["open", "snapshot", "click"]),
  });
}

describe("registerBrowserHost", () => {
  it("adds a new host, unfocused at order zero", () => {
    const state = register(EMPTY_BROWSER_HOST_REGISTRY, "a");
    expect(state.hosts.get("a")).toMatchObject({ focused: false, focusOrder: 0 });
  });

  it("preserves focus when a host re-registers with new capabilities", () => {
    // A window that was focused and then re-announced its operations has not
    // moved; dropping its focus would make it lose to a stale background window.
    let state = register(EMPTY_BROWSER_HOST_REGISTRY, "a");
    state = focusBrowserHost(state, "a");
    const focusedOrder = state.hosts.get("a")!.focusOrder;
    state = register(state, "a", { operations: ["open"] });
    expect(state.hosts.get("a")).toMatchObject({ focused: true, focusOrder: focusedOrder });
    expect([...state.hosts.get("a")!.supportedOperations]).toEqual(["open"]);
  });
});

describe("unregisterBrowserHost", () => {
  it("removes the host", () => {
    let state = register(EMPTY_BROWSER_HOST_REGISTRY, "a");
    state = unregisterBrowserHost(state, "a");
    expect(state.hosts.has("a")).toBe(false);
  });

  it("prunes leases that pointed at the departed host", () => {
    // The load-bearing case: a lease outliving its connection would pin future
    // calls to a dead desktop.
    let state = register(register(EMPTY_BROWSER_HOST_REGISTRY, "a"), "b");
    const routed = routeBrowserCall(state, {
      environmentId: "env-1",
      operation: "click",
      interactionKey: "thread-1",
    });
    state = routed.state;
    const leasedTo = (routed.selection as { connectionId: string }).connectionId;
    expect(state.leases.get("thread-1")).toBeDefined();

    state = unregisterBrowserHost(state, leasedTo);
    expect(state.leases.has("thread-1")).toBe(false);
  });

  it("leaves leases pointing at other hosts intact", () => {
    let state = register(register(EMPTY_BROWSER_HOST_REGISTRY, "a"), "b");
    state = routeBrowserCall(state, {
      environmentId: "env-1",
      operation: "click",
      interactionKey: "thread-1",
    }).state;
    const leasedTo = state.leases.get("thread-1")!.connectionId;
    const other = leasedTo === "a" ? "b" : "a";
    state = unregisterBrowserHost(state, other);
    expect(state.leases.get("thread-1")?.connectionId).toBe(leasedTo);
  });

  it("is a no-op for an unknown connection", () => {
    const state = register(EMPTY_BROWSER_HOST_REGISTRY, "a");
    expect(unregisterBrowserHost(state, "ghost")).toBe(state);
  });
});

describe("focusBrowserHost", () => {
  it("focuses the target and clears focus on every other window", () => {
    // The OS has one focused window; two claiming focus makes the tiebreak
    // meaningless.
    let state = register(register(EMPTY_BROWSER_HOST_REGISTRY, "a"), "b");
    state = focusBrowserHost(state, "a");
    state = focusBrowserHost(state, "b");
    expect(state.hosts.get("a")!.focused).toBe(false);
    expect(state.hosts.get("b")!.focused).toBe(true);
  });

  it("assigns a strictly increasing focus order", () => {
    let state = register(register(EMPTY_BROWSER_HOST_REGISTRY, "a"), "b");
    state = focusBrowserHost(state, "a");
    const first = state.hosts.get("a")!.focusOrder;
    state = focusBrowserHost(state, "b");
    const second = state.hosts.get("b")!.focusOrder;
    expect(second).toBeGreaterThan(first);
  });

  it("ignores a focus for an unknown connection", () => {
    // A window announcing focus just after disconnecting must not resurrect it.
    const state = register(EMPTY_BROWSER_HOST_REGISTRY, "a");
    expect(focusBrowserHost(state, "ghost")).toBe(state);
  });

  it("makes the focused window win selection", () => {
    let state = register(register(EMPTY_BROWSER_HOST_REGISTRY, "a"), "b");
    state = focusBrowserHost(state, "b");
    const selection = routeBrowserCall(state, {
      environmentId: "env-1",
      operation: "click",
      interactionKey: "fresh",
    }).selection;
    expect(selection).toEqual({ kind: "selected", connectionId: "b" });
  });
});

describe("routeBrowserCall", () => {
  it("records a lease on the first call and reuses it on the next", () => {
    let state = register(register(EMPTY_BROWSER_HOST_REGISTRY, "leased"), "shinier");
    // First call binds the interaction to whichever host wins.
    let routed = routeBrowserCall(state, {
      environmentId: "env-1",
      operation: "open",
      interactionKey: "thread-7",
    });
    state = routed.state;
    const bound = (routed.selection as { connectionId: string }).connectionId;

    // Now focus the OTHER window so ranking would prefer it — the lease must win.
    const other = bound === "leased" ? "shinier" : "leased";
    state = focusBrowserHost(state, other);

    routed = routeBrowserCall(state, {
      environmentId: "env-1",
      operation: "click",
      interactionKey: "thread-7",
    });
    expect(routed.selection).toEqual({ kind: "selected", connectionId: bound });
  });

  it("keeps interactions on separate leases", () => {
    let state = register(EMPTY_BROWSER_HOST_REGISTRY, "a");
    state = routeBrowserCall(state, {
      environmentId: "env-1",
      operation: "open",
      interactionKey: "thread-1",
    }).state;
    state = routeBrowserCall(state, {
      environmentId: "env-1",
      operation: "open",
      interactionKey: "thread-2",
    }).state;
    expect(state.leases.get("thread-1")).toBeDefined();
    expect(state.leases.get("thread-2")).toBeDefined();
  });

  it("does not write a lease when nothing was selected", () => {
    // No host for the environment → no-host → no lease to pin.
    const state = register(EMPTY_BROWSER_HOST_REGISTRY, "a", { environmentId: "env-1" });
    const routed = routeBrowserCall(state, {
      environmentId: "env-2",
      operation: "click",
      interactionKey: "thread-9",
    });
    expect(routed.selection).toEqual({ kind: "no-host" });
    expect(routed.state.leases.has("thread-9")).toBe(false);
  });

  it("does not mutate the input state map", () => {
    const state = register(EMPTY_BROWSER_HOST_REGISTRY, "a");
    const before = state.leases.size;
    routeBrowserCall(state, {
      environmentId: "env-1",
      operation: "open",
      interactionKey: "thread-1",
    });
    // The original state is unchanged; the new lease is only in the returned state.
    expect(state.leases.size).toBe(before);
  });
});
