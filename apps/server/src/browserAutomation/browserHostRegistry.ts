// FILE: browserHostRegistry.ts
// Purpose: The in-memory state of which desktops are registered as browser
//          automation hosts, plus the pure transitions that keep it correct as
//          windows connect, focus, disconnect, and hold multi-step leases.
// Layer: Server / browser-automation broker
// Exports: BrowserHostRegistryState, EMPTY_BROWSER_HOST_REGISTRY,
//          registerBrowserHost, unregisterBrowserHost, focusBrowserHost,
//          routeBrowserCall, RouteBrowserCallResult
//
// Why the state and its transitions are pure
// ------------------------------------------
// selectBrowserHost (browserHostSelection.ts) decides WHICH host runs a call;
// this owns the state it reads and the lease it writes. Keeping the transitions
// pure means the lifecycle bugs that actually bite are testable without a live
// desktop: a lease surviving the disconnect of the host it pointed at, focus
// order going stale so a background window keeps winning, a re-register wiping
// the focus a window already had. Each is a wrong map, not a wrong RPC.

import {
  type BrowserHostLease,
  type BrowserHostSelection,
  type RegisteredBrowserHost,
  selectBrowserHost,
} from "./browserHostSelection.ts";

export interface BrowserHostRegistryState {
  /** Registered hosts by connection id. */
  readonly hosts: ReadonlyMap<string, RegisteredBrowserHost>;
  /** Sticky assignments: which connection a multi-step interaction is bound to. */
  readonly leases: ReadonlyMap<string, BrowserHostLease>;
  /**
   * Monotonic focus counter. Every focus event takes the next value, so a
   * larger focusOrder always means "focused more recently" — the tiebreak
   * selection relies on. It only ever increases, so it cannot collide.
   */
  readonly focusSequence: number;
}

export const EMPTY_BROWSER_HOST_REGISTRY: BrowserHostRegistryState = {
  hosts: new Map(),
  leases: new Map(),
  focusSequence: 0,
};

export interface RegisterBrowserHostInput {
  readonly connectionId: string;
  readonly environmentId: string;
  readonly supportedOperations: ReadonlySet<string>;
}

/**
 * Adds or replaces a host.
 *
 * A re-register (same connection announcing new capabilities) preserves the
 * host's existing focus state and order: a window that was focused and then
 * re-announced its operation set has not moved, and dropping its focus would
 * make it lose to a stale background window until the user clicked it again.
 * A genuinely new connection starts unfocused with order 0.
 */
export function registerBrowserHost(
  state: BrowserHostRegistryState,
  input: RegisterBrowserHostInput,
): BrowserHostRegistryState {
  const existing = state.hosts.get(input.connectionId);
  const hosts = new Map(state.hosts);
  hosts.set(input.connectionId, {
    connectionId: input.connectionId,
    environmentId: input.environmentId,
    supportedOperations: input.supportedOperations,
    focused: existing?.focused ?? false,
    focusOrder: existing?.focusOrder ?? 0,
  });
  return { ...state, hosts };
}

/**
 * Removes a host and prunes every lease that pointed at it.
 *
 * The pruning is the load-bearing part. A lease outliving its connection is a
 * lease pinning future calls to a dead desktop; selection would keep choosing a
 * connection that can no longer answer. Dropping the lease here lets the next
 * call fail over to a live host instead.
 */
export function unregisterBrowserHost(
  state: BrowserHostRegistryState,
  connectionId: string,
): BrowserHostRegistryState {
  if (!state.hosts.has(connectionId)) return state;
  const hosts = new Map(state.hosts);
  hosts.delete(connectionId);
  const leases = new Map(state.leases);
  for (const [interactionKey, lease] of leases) {
    if (lease.connectionId === connectionId) leases.delete(interactionKey);
  }
  return { ...state, hosts, leases };
}

/**
 * Marks one host as the focused window.
 *
 * The OS has a single focused window, so this focuses the target and clears
 * `focused` on every other host — otherwise two windows could both claim focus
 * and the tiebreak would be meaningless. The target takes the next focus
 * sequence, so it also becomes the most-recently-focused for the recency
 * tiebreak among windows that later blur.
 *
 * A focus for a connection we do not know is a no-op: a race where the window
 * announced focus just after disconnecting must not resurrect it.
 */
export function focusBrowserHost(
  state: BrowserHostRegistryState,
  connectionId: string,
): BrowserHostRegistryState {
  const target = state.hosts.get(connectionId);
  if (!target) return state;
  const focusSequence = state.focusSequence + 1;
  const hosts = new Map<string, RegisteredBrowserHost>();
  for (const [id, host] of state.hosts) {
    if (id === connectionId) {
      hosts.set(id, { ...host, focused: true, focusOrder: focusSequence });
    } else if (host.focused) {
      hosts.set(id, { ...host, focused: false });
    } else {
      hosts.set(id, host);
    }
  }
  return { ...state, hosts, focusSequence };
}

export interface RouteBrowserCallInput {
  readonly environmentId: string;
  readonly operation: string;
  /** Identifies the interaction a lease pins, e.g. a thread+tab key. Opaque here. */
  readonly interactionKey: string;
}

export interface RouteBrowserCallResult {
  readonly state: BrowserHostRegistryState;
  readonly selection: BrowserHostSelection;
}

/**
 * Routes a call and records the lease.
 *
 * Reuses the interaction's existing lease if it still qualifies (selection
 * enforces that), and on a fresh selection writes the lease so the next call in
 * the interaction stays on the same browser. A non-`selected` outcome leaves the
 * lease untouched — there is nothing to pin, and clearing it would drop a still-
 * valid assignment on a transient miss.
 */
export function routeBrowserCall(
  state: BrowserHostRegistryState,
  input: RouteBrowserCallInput,
): RouteBrowserCallResult {
  const selection = selectBrowserHost({
    hosts: [...state.hosts.values()],
    environmentId: input.environmentId,
    operation: input.operation,
    lease: state.leases.get(input.interactionKey) ?? null,
  });

  if (selection.kind !== "selected") {
    return { state, selection };
  }

  const leases = new Map(state.leases);
  leases.set(input.interactionKey, { connectionId: selection.connectionId });
  return { state: { ...state, leases }, selection };
}
