// FILE: hostRuntimeRecord.ts
// Purpose: Read the runtime record the server writes on listen, and gather the
//          live facts `decideHostAdoption` needs, so the desktop can attach to a
//          running host instead of starting a second one over it.
// Layer: Desktop main process
// Exports: readHostRuntimeRecord, isProcessAlive, gatherHostAdoptionFacts,
//          hostRuntimeRecordPathFor
//
// The record is written by apps/server/src/serverRuntimeState.ts (atomically, on
// listen) and removed by a finalizer on clean shutdown. This module only reads
// it. Anything it cannot parse is treated as absent rather than repaired: a
// half-written or foreign record is not evidence of a host, and guessing at one
// is how a second writer gets adopted.

import * as FS from "node:fs";
import * as Path from "node:path";

import type { HostAdoptionFacts, HostRuntimeRecord } from "@synara/shared/hostAdoption";

/** Where the server puts it. Must match ServerConfigShape.serverRuntimeStatePath. */
export function hostRuntimeRecordPathFor(stateDir: string): string {
  return Path.join(stateDir, "server-runtime.json");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Reads and validates the record.
 *
 * Returns undefined for every failure — missing, unreadable, malformed JSON,
 * wrong field types. The caller cannot act differently on these and a record it
 * cannot trust is exactly as useful as no record at all.
 */
export function readHostRuntimeRecord(path: string): HostRuntimeRecord | undefined {
  let raw: string;
  try {
    raw = FS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A torn read of a file being replaced. The write is atomic (temp + rename),
    // so this is rare, but it is not an error worth surfacing — the next check
    // will start a host.
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    !isPositiveInteger(record.version) ||
    !isPositiveInteger(record.pid) ||
    !isPositiveInteger(record.port) ||
    typeof record.origin !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    return undefined;
  }

  return {
    version: record.version,
    pid: record.pid,
    port: record.port,
    origin: record.origin,
    startedAt: record.startedAt,
  };
}

/**
 * Whether a pid currently names a live process.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM counts as ALIVE: the process exists but belongs to another
 * user, which is a host we must not adopt AND must not start a second server
 * over. Treating that as dead is how two users on one machine end up writing to
 * one SYNARA_HOME.
 *
 * This cannot distinguish the recorded host from an unrelated process that
 * inherited its pid after a recycle. The origin probe the caller performs next
 * is what closes that gap; liveness alone is necessary, not sufficient.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function gatherHostAdoptionFacts(input: {
  readonly stateDir: string;
  readonly currentPid?: number;
}): HostAdoptionFacts {
  const record = readHostRuntimeRecord(hostRuntimeRecordPathFor(input.stateDir));
  return {
    record,
    processAlive: record === undefined ? false : isProcessAlive(record.pid),
    currentPid: input.currentPid ?? process.pid,
  };
}
