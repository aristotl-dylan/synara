// FILE: hostAdoption.ts
// Purpose: Decide whether a Synara host recorded on disk may be adopted by a UI
//          that is starting up, rather than spawning a second server over it.
// Layer: Shared runtime utility
// Exports: HostAdoptionDecision, decideHostAdoption, isLoopbackOrigin,
//          hostRuntimeRecordPath
//
// Why this is shared, and pure
// ----------------------------
// The desktop decides whether to attach; the server decides whether it is
// allowed to become the writer. Those two must agree exactly, or both processes
// conclude they own the same SYNARA_HOME and the SQLite journal gets two
// writers. `apps/desktop` cannot import from `apps/server` (it depends on
// @synara/shared only), so a rule written in either app would have to be
// duplicated in the other — and a duplicated rule is one that drifts.
//
// The decision takes facts rather than reading them: `process.kill(pid, 0)` and
// an HTTP probe are effects, and a decision procedure that performs them cannot
// be exhaustively tested against the cases that matter (a recycled pid, a
// record written by a different install, a host bound to a public interface).

/** Shape written by the server on listen. Mirrors PersistedServerRuntimeState. */
export interface HostRuntimeRecord {
  readonly version: number;
  readonly pid: number;
  readonly port: number;
  readonly origin: string;
  readonly startedAt: string;
}

export type HostAdoptionDecision =
  | { readonly kind: "adopt"; readonly origin: string; readonly pid: number }
  | { readonly kind: "spawn"; readonly reason: HostAdoptionRefusal };

/**
 * Why a recorded host was not adopted. Named rather than boolean because these
 * land in a log the user reads when Synara "started twice", and "stale" versus
 * "not-loopback" point at completely different problems.
 */
export type HostAdoptionRefusal =
  | "no-record"
  | "unsupported-version"
  | "dead-process"
  | "self"
  | "non-loopback-origin"
  | "malformed-origin";

/** The version this build understands. A newer record is refused, not guessed at. */
export const SUPPORTED_HOST_RECORD_VERSION = 1;

/**
 * Whether an origin points at this machine's loopback interface.
 *
 * Adoption hands the UI's session traffic to whatever answers at this origin, so
 * a record naming a routable address must never be adopted: on a shared or
 * hostile network that is another machine's server, and the UI would attach to
 * it holding this user's data. Hostnames are refused outright — `localhost`
 * resolves through /etc/hosts and DNS, and neither is ours to trust here.
 */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const hostname = url.hostname;
  // URL normalizes bracketed IPv6 literals, so `[::1]` arrives as `[::1]`.
  if (hostname === "[::1]" || hostname === "::1") return true;
  // 127.0.0.0/8 in full: 127.0.0.2 is as loopback as 127.0.0.1, and a record
  // written on a box using one is still legitimately ours.
  //
  // No octet range check: `new URL` above rejects a dotted quad with an
  // out-of-range part outright ("http://127.0.0.256" throws), so a range test
  // here is unreachable — and an unreachable guard is one no test can hold to
  // account. The digit test still earns its place: it rejects hostnames that
  // merely split into four parts, which URL accepts.
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((part) => /^\d{1,3}$/.test(part))) return false;
  return octets[0] === "127";
}

export interface HostAdoptionFacts {
  /** Decoded record, or undefined when absent/unreadable/malformed. */
  readonly record: HostRuntimeRecord | undefined;
  /** Whether a process with the recorded pid currently exists. */
  readonly processAlive: boolean;
  /** This process's own pid, so a UI never adopts the server it is hosting. */
  readonly currentPid: number;
}

/**
 * The adoption rule.
 *
 * A record is only ever a claim: it is written on listen and removed by a
 * finalizer, so any path that skips finalizers — SIGKILL, a panic, a power cut —
 * leaves one behind pointing at nothing. Every check below exists because some
 * failure mode produces a record that looks fine.
 */
export function decideHostAdoption(facts: HostAdoptionFacts): HostAdoptionDecision {
  const { record } = facts;
  if (!record) return { kind: "spawn", reason: "no-record" };

  // A record from a future version may carry fields whose absence changes what
  // adoption means. Refusing costs one extra server start; guessing risks
  // attaching under rules this build does not implement.
  if (record.version !== SUPPORTED_HOST_RECORD_VERSION) {
    return { kind: "spawn", reason: "unsupported-version" };
  }

  // Ordered before the liveness check: our own pid is trivially alive, and
  // treating that as an adoptable host makes a process attach to itself.
  if (record.pid === facts.currentPid) {
    return { kind: "spawn", reason: "self" };
  }

  if (!facts.processAlive) {
    return { kind: "spawn", reason: "dead-process" };
  }

  // Checked last so a stale record naming a bad origin still reports the more
  // actionable "dead-process" rather than sending the user after a network
  // problem that no longer exists.
  let originIsLoopback: boolean;
  try {
    originIsLoopback = isLoopbackOrigin(record.origin);
  } catch {
    return { kind: "spawn", reason: "malformed-origin" };
  }
  if (!originIsLoopback) {
    return { kind: "spawn", reason: "non-loopback-origin" };
  }

  return { kind: "adopt", origin: record.origin, pid: record.pid };
}

/**
 * Human-readable cause, for the log line that explains why a second server
 * started. Kept next to the refusals so a new one cannot be added without a
 * message.
 */
export function describeHostAdoptionRefusal(reason: HostAdoptionRefusal): string {
  switch (reason) {
    case "no-record":
      return "no running host was recorded";
    case "unsupported-version":
      return "the recorded host uses a newer runtime record than this build understands";
    case "dead-process":
      return "the recorded host process is no longer running";
    case "self":
      return "the recorded host is this process";
    case "non-loopback-origin":
      return "the recorded host is not bound to loopback";
    case "malformed-origin":
      return "the recorded host origin could not be parsed";
  }
}
