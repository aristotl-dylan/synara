// FILE: hostAttach.ts
// Purpose: Turn an adoption decision into the endpoint the UI should use — the
//          running host's, or a freshly reserved one for a host we are about to
//          start.
// Layer: Desktop main process
// Exports: HostEndpoint, AttachOutcome, resolveHostEndpoint, probeHostHealth
//
// Why the endpoint has to be decided here
// ---------------------------------------
// Bootstrap reserves a loopback port before anything else, which is right when
// this UI is going to start the server and wrong when it is going to attach:
// the running host is already bound to the port in its record, and a UI that
// reserved its own would point every request at a port nothing is listening on.
// So the endpoint follows the decision rather than preceding it.

import {
  decideHostAdoption,
  describeHostAdoptionRefusal,
  type HostAdoptionFacts,
} from "@synara/shared/hostAdoption";

export interface HostEndpoint {
  readonly origin: string;
  readonly port: number;
}

export type AttachOutcome =
  | { readonly kind: "attached"; readonly endpoint: HostEndpoint; readonly pid: number }
  | { readonly kind: "start-host"; readonly reason: string };

/**
 * A host that answers /health with startupReady.
 *
 * The record proves a server started, not that it is still serving: a host
 * wedged on a bad migration, or one whose port was taken over by something else
 * after a pid recycle, both leave a record that looks adoptable. Only a response
 * settles it.
 *
 * Never cached on failure. A host that is briefly unreachable during a slow
 * turn must not be written off as dead for the rest of the session — the whole
 * point of attaching is that the host outlives any one window.
 */
export async function probeHostHealth(input: {
  readonly origin: string;
  readonly timeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}): Promise<boolean> {
  const timeoutMs = input.timeoutMs ?? 2_000;
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(`${input.origin}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { startupReady?: unknown };
    // startupReady, not merely a 200: the route answers while subsystems are
    // still coming up, and attaching to a half-started host produces failures
    // the user reads as Synara being broken.
    return payload.startupReady === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decides whether to attach, and to what.
 *
 * Two gates, in order. The record gate is cheap and local and rejects the
 * common cases (nothing running, stale record, wrong interface). The health
 * probe costs a round trip and is only reached for a record that survived, so
 * a cold start pays nothing for it.
 */
export async function resolveHostEndpoint(input: {
  readonly facts: HostAdoptionFacts;
  readonly probe?: (origin: string) => Promise<boolean>;
}): Promise<AttachOutcome> {
  const decision = decideHostAdoption(input.facts);
  if (decision.kind === "spawn") {
    return { kind: "start-host", reason: describeHostAdoptionRefusal(decision.reason) };
  }

  const probe = input.probe ?? ((origin: string) => probeHostHealth({ origin }));
  if (!(await probe(decision.origin))) {
    return {
      kind: "start-host",
      reason: "the recorded host did not answer a health check",
    };
  }

  const port = Number(new URL(decision.origin).port);
  if (!Number.isInteger(port) || port <= 0) {
    // The record carries a port field, but the origin is what we would actually
    // connect to; disagreement between them means the record is not describing
    // a server we can reach.
    return { kind: "start-host", reason: "the recorded host origin has no usable port" };
  }

  return { kind: "attached", endpoint: { origin: decision.origin, port }, pid: decision.pid };
}
