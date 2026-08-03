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

export type StopHostOutcome =
  | { readonly kind: "stopped"; readonly pid: number; readonly forced: boolean }
  | { readonly kind: "not-running" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly pid: number; readonly reason: string };

export interface StopDetachedHostInput {
  readonly recordPath: string;
  /** This process, so a UI can never signal itself into oblivion. */
  readonly currentPid?: number;
  readonly gracefulTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
  /** Test seams. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly isAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_GRACEFUL_TIMEOUT_MS = 10_000;
const DEFAULT_FORCE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

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
 * SIGTERM lets the server run its finalizers: that is what flushes the SQLite
 * journal, terminalizes open turns, and removes the runtime record. Going
 * straight to SIGKILL would leave a record pointing at a dead pid and a
 * database that the next start has to recover — which is survivable, but it is
 * the thing we are able to avoid here and cannot avoid after a crash.
 *
 * SIGKILL only after the graceful window. A host mid-turn can legitimately take
 * seconds to drain, and killing it early converts an orderly update into the
 * crash path.
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
    return { kind: "stopped", pid: record.pid, forced: false };
  }

  try {
    kill(record.pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { kind: "stopped", pid: record.pid, forced: true };
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
    return { kind: "stopped", pid: record.pid, forced: true };
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
