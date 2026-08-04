// FILE: browserHostSelection.ts
// Purpose: Pick which registered desktop should run a browser tool call — the
//          routing decision at the heart of reaching the in-app browser from a
//          remote environment.
// Layer: Server / browser-automation broker
// Exports: RegisteredBrowserHost, BrowserHostLease, selectBrowserHost,
//          BrowserHostSelection
//
// Why this is a pure decision
// ---------------------------
// The in-app browser is an Electron artifact and cannot run on a headless host,
// but its control channel is plain JSON-RPC (ping/getInfo/executeTool), so a
// remote environment can drive a DESKTOP's browser through the server. Desktops
// register here; a tool call is routed to one of them.
//
// The routing is data-in / decision-out so the cases that decide correctness are
// testable without a live desktop or a real webview: no desktop registered for
// the environment, several registered but none supporting the operation, a
// multi-step interaction that must stay on ONE browser, a focused window that
// should win over a background one. A broker that discovered those by making RPC
// calls could not be checked against them exhaustively.

export interface RegisteredBrowserHost {
  /** Unique per live connection; the identity a lease pins to. */
  readonly connectionId: string;
  /** The environment this desktop is registered against. Routing is scoped to it. */
  readonly environmentId: string;
  /** Operations this desktop's build understands (executeTool names). */
  readonly supportedOperations: ReadonlySet<string>;
  /** Whether this is the desktop window the user is currently looking at. */
  readonly focused: boolean;
  /** Higher means more recently focused; used to break ties among unfocused windows. */
  readonly focusOrder: number;
}

/**
 * A sticky assignment from an earlier call in the same interaction.
 *
 * Multi-step browser work — open, then snapshot, then click — must land on the
 * SAME browser, or the click acts on a page a different desktop never opened. A
 * lease records which connection the interaction is bound to.
 */
export interface BrowserHostLease {
  readonly connectionId: string;
}

export type BrowserHostSelection =
  | { readonly kind: "selected"; readonly connectionId: string }
  // No desktop is registered for this environment at all.
  | { readonly kind: "no-host" }
  // Desktops are registered, but none of them speak the requested operation —
  // e.g. every attached window is an older build. Distinct from no-host so the
  // caller can say WHICH kind of unavailability it is instead of a bare failure.
  | { readonly kind: "unsupported" };

export interface SelectBrowserHostInput {
  readonly hosts: readonly RegisteredBrowserHost[];
  readonly environmentId: string;
  readonly operation: string;
  /** The interaction's current assignment, if any. */
  readonly lease?: BrowserHostLease | null;
}

/**
 * Ranks two candidate hosts, best first. Returns negative when `a` should be
 * preferred over `b`.
 *
 * Capability first: a window that supports more operations is likelier to
 * satisfy the next call in the interaction too, so keeping work there avoids a
 * mid-interaction reassignment. Then focus: the window the user is actually
 * looking at wins, because a browser action they can see is the least
 * surprising. Then recency of focus, so the most-recently-used background
 * window beats a stale one.
 */
function preferHost(a: RegisteredBrowserHost, b: RegisteredBrowserHost): number {
  if (a.supportedOperations.size !== b.supportedOperations.size) {
    return b.supportedOperations.size - a.supportedOperations.size;
  }
  if (a.focused !== b.focused) {
    return a.focused ? -1 : 1;
  }
  return b.focusOrder - a.focusOrder;
}

/**
 * Selects the desktop for a browser tool call.
 *
 * The lease is honoured FIRST, and only if the leased host still qualifies — is
 * still registered for this environment and still supports the operation. A
 * dead or now-incapable lease is dropped and selection falls through to a fresh
 * ranking, so an interaction whose desktop went away fails over rather than
 * pinning to a corpse.
 */
export function selectBrowserHost(input: SelectBrowserHostInput): BrowserHostSelection {
  const eligible = input.hosts.filter(
    (host) =>
      host.environmentId === input.environmentId && host.supportedOperations.has(input.operation),
  );

  if (eligible.length === 0) {
    // Distinguish "nothing here" from "nothing capable": if any desktop is
    // registered for the environment, the problem is the operation, not the
    // absence of a browser.
    const anyForEnvironment = input.hosts.some(
      (host) => host.environmentId === input.environmentId,
    );
    return anyForEnvironment ? { kind: "unsupported" } : { kind: "no-host" };
  }

  if (input.lease) {
    const leased = eligible.find((host) => host.connectionId === input.lease?.connectionId);
    if (leased) {
      return { kind: "selected", connectionId: leased.connectionId };
    }
    // The leased host is gone or no longer supports the operation; fall through
    // to a fresh selection rather than fail the interaction outright.
  }

  // toSorted, not sort: never mutate the caller's array — a registry that hands
  // the same array to concurrent selections must not see it reordered underfoot.
  const ranked = [...eligible].sort(preferHost);
  return { kind: "selected", connectionId: ranked[0]!.connectionId };
}
