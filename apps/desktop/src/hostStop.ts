// FILE: hostStop.ts
// Purpose: Stop a detached Synara host by pid, for the one case where the
//          desktop must genuinely take it down — installing an update that
//          replaces the server binary underneath it.
// Layer: Desktop main process
// Exports: stopDetachedHost, StopHostOutcome
//
// Why this exists at all
// ----------------------
// `stopBackendAndWaitForExit()` stops `backendProcess`, which is the child this
// UI spawned. A detached host is not that child — the field is null — so that
// function returns having stopped nothing, silently. Before this module the
// update path therefore installed a new server while the old one kept running
// and kept writing to the same SYNARA_HOME.
//
// This is the ONLY path that may stop a host the UI does not own. Quitting a
// window must leave it serving; see the attach guard in main.ts.

import { isProcessAlive, readHostRuntimeRecord } from "./hostRuntimeRecord";

export interface StopDrainResult {
  /** True when the count reached zero before the deadline. */
  readonly drained: boolean;
  /** Last count read; null when the host did not report one (unknown). */
  readonly lastRunningTurns: number | null;
  readonly waitedMs: number;
}

export type StopHostOutcome =
  | {
      readonly kind: "stopped";
      readonly pid: number;
      readonly forced: boolean;
      readonly drain?: StopDrainResult;
    }
  | { readonly kind: "not-running" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly pid: number; readonly reason: string };

export interface StopDetachedHostInput {
  readonly recordPath: string;
  /** This process, so a UI can never signal itself into oblivion. */
  readonly currentPid?: number;
  readonly gracefulTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
  /**
   * How long to wait for running turns to finish before signalling. A turn in
   * flight is the user's work; stopping without waiting kills it. The wait is
   * bounded — a wedged turn must not block an update forever — and the SIGTERM
   * that follows lets the server terminalize whatever is still open.
   */
  readonly drainTimeoutMs?: number;
  readonly drainPollIntervalMs?: number;
  /**
   * Reads the host's running-turn count, or null when it cannot be determined.
   * Defaults to polling `<origin>/health` and reading `activeTurns`. A null
   * count means "unknown" and does NOT block — we cannot wait on a number we
   * cannot read, and hanging would be worse than an interrupted turn.
   */
  readonly readActiveTurns?: () => Promise<number | null>;
  readonly fetchImplementation?: typeof fetch;
  /** Test seams. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly isAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_GRACEFUL_TIMEOUT_MS = 10_000;
const DEFAULT_FORCE_TIMEOUT_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_POLL_INTERVAL_MS = 500;
const POLL_INTERVAL_MS = 100;

/** Reads `activeTurns` from `<origin>/health`; null on any failure or absence. */
async function fetchActiveTurns(
  origin: string,
  fetchImplementation: typeof fetch,
): Promise<number | null> {
  try {
    const response = await fetchImplementation(`${origin}/health`);
    if (!response.ok) return null;
    const body = (await response.json()) as { activeTurns?: unknown };
    return typeof body.activeTurns === "number" ? body.activeTurns : null;
  } catch {
    return null;
  }
}

/**
 * Waits for the running-turn count to reach zero, bounded by a deadline.
 *
 * A null read is treated as zero for the purpose of continuing: we cannot wait
 * on a count the host will not report, and blocking on "unknown" would hang the
 * update indefinitely. The bound is the other guard — a genuinely stuck turn
 * drains-out at the deadline and the stop proceeds anyway.
 */
async function drainRunningTurns(input: {
  readonly read: () => Promise<number | null>;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<StopDrainResult> {
  let waited = 0;
  let last = await input.read();
  while ((last ?? 0) > 0 && waited < input.timeoutMs) {
    await input.sleep(input.pollMs);
    waited += input.pollMs;
    last = await input.read();
  }
  // `drained` is a CONFIRMATION of zero, so null (unknown) is not drained even
  // though a null does not block the loop. The loop uses `?? 0` to avoid waiting
  // on a count it cannot read; this uses strict equality to avoid claiming a
  // drain it never observed.
  return { drained: last === 0, lastRunningTurns: last, waitedMs: waited };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(input: {
  readonly pid: number;
  readonly timeoutMs: number;
  readonly isAlive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const deadline = input.timeoutMs;
  let waited = 0;
  while (waited < deadline) {
    if (!input.isAlive(input.pid)) return true;
    await input.sleep(POLL_INTERVAL_MS);
    waited += POLL_INTERVAL_MS;
  }
  return !input.isAlive(input.pid);
}

/**
 * Stops the recorded host, SIGTERM first.
 *
 * SIGTERM lets the server run its finalizers: terminalize open turns, and
 * remove its own runtime record.
 *
 * The record is the measured difference, not database integrity. Both paths
 * were run against the real server: SIGTERM cleared the record and left
 * `PRAGMA integrity_check: ok` with no stray WAL; SIGKILL ALSO left
 * `integrity_check: ok` — SQLite's WAL is crash-safe, so the database survives
 * either way — but left the record behind pointing at a dead pid. That stale
 * record is what the next launch then has to recognise and reject.
 *
 * It drains first. Before signalling, it waits for the host's running-turn
 * count (polled from `<origin>/health`, field `activeTurns`) to reach zero,
 * bounded by `drainTimeoutMs`. A turn in flight is the user's work; stopping
 * without waiting kills it. This mirrors `evaluateUpgradeGate` in
 * remoteBootstrap, which refuses to swap while `activeTurnCount > 0` — the same
 * rule the remote path already follows, now available to the local one because
 * the server reports the count.
 *
 * The drain is bounded and degrades safely. A wedged turn drains-out at the
 * deadline and the stop proceeds; a host that will not report a count (null)
 * does not block at all, because hanging on "unknown" is worse than an
 * interrupted turn. Whatever is still open when SIGTERM lands is terminalized
 * by the server's finalizers rather than lost.
 *
 * SIGTERM before SIGKILL, SIGKILL only after the graceful window, for the
 * reasons above.
 */
export async function stopDetachedHost(input: StopDetachedHostInput): Promise<StopHostOutcome> {
  const kill = input.kill ?? ((pid, signal) => process.kill(pid, signal));
  const isAlive = input.isAlive ?? isProcessAlive;
  const sleep = input.sleep ?? defaultSleep;

  const record = readHostRuntimeRecord(input.recordPath);
  if (!record) return { kind: "not-running" };

  const currentPid = input.currentPid ?? process.pid;
  if (record.pid === currentPid) {
    // Only reachable if a record somehow names this process. Signalling
    // ourselves here would take down the UI mid-update.
    return { kind: "refused", reason: "the recorded host is this process" };
  }

  if (!isAlive(record.pid)) {
    // Already gone — the record is stale. Nothing to stop, and the update may
    // proceed.
    return { kind: "not-running" };
  }

  // Wait for in-flight turns to finish before signalling. Read from the seam if
  // given, else poll the recorded origin's /health.
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const read =
    input.readActiveTurns ?? (() => fetchActiveTurns(record.origin, fetchImplementation));
  const drain = await drainRunningTurns({
    read,
    timeoutMs: input.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    pollMs: input.drainPollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS,
    sleep,
  });

  try {
    kill(record.pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { kind: "not-running" };
    // EPERM means the host belongs to another user. Installing over it would
    // leave two servers on one home, so this is a hard stop, not a warning.
    return {
      kind: "failed",
      pid: record.pid,
      reason: `could not signal the host (${code ?? "unknown error"})`,
    };
  }

  if (
    await waitForExit({
      pid: record.pid,
      timeoutMs: input.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS,
      isAlive,
      sleep,
    })
  ) {
    return { kind: "stopped", pid: record.pid, forced: false, drain };
  }

  try {
    kill(record.pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { kind: "stopped", pid: record.pid, forced: true, drain };
    return {
      kind: "failed",
      pid: record.pid,
      reason: `could not force-stop the host (${code ?? "unknown error"})`,
    };
  }

  if (
    await waitForExit({
      pid: record.pid,
      timeoutMs: input.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS,
      isAlive,
      sleep,
    })
  ) {
    return { kind: "stopped", pid: record.pid, forced: true, drain };
  }

  // Reported rather than assumed: a host that survives SIGKILL is wedged in
  // uninterruptible IO, and installing a new server over it is how a home ends
  // up with two writers.
  return {
    kind: "failed",
    pid: record.pid,
    reason: "the host did not exit after SIGKILL",
  };
}

/** Whether an update may proceed after a stop attempt. */
export function mayInstallAfterStop(outcome: StopHostOutcome): boolean {
  return outcome.kind === "stopped" || outcome.kind === "not-running";
}
