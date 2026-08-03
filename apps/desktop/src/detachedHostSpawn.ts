// FILE: detachedHostSpawn.ts
// Purpose: Build the spawn options that let the Synara server outlive the UI
//          that started it, and open the log file descriptors a detached process
//          needs in place of inherited pipes.
// Layer: Desktop main process
// Exports: detachedHostStdio, detachedHostSpawnOptions, openHostLogDescriptors,
//          closeHostLogDescriptors, HostLogDescriptors
//
// Why the stdio shape changes
// ---------------------------
// A child with `stdio: ["ignore", "pipe", "pipe", ...]` writes into pipes owned
// by the parent. When the UI exits those pipe read ends close, and the next
// write from the server raises EPIPE — so a "detached" process spawned that way
// dies on its first log line after the UI quits. Surviving the parent means
// writing into file descriptors that do not belong to the parent at all.
//
// This also ends the fd-3 capability handoff. That pipe only carried a 32-byte
// secret, and a detached process cannot be handed one; the secret now travels
// by environment, which the server already prefers over the fd
// (browserHostRpcClient.ts resolveBrowserHostCapability).

import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * stdio for a process that must survive its parent.
 *
 * stdin is "ignore" rather than "inherit": inheriting the UI's stdin means the
 * server holds a terminal the user may close, and a detached process reading a
 * closed terminal is a stall nobody can see.
 */
export function detachedHostStdio(stdoutFd: number, stderrFd: number): ["ignore", number, number] {
  return ["ignore", stdoutFd, stderrFd];
}

export interface HostLogDescriptors {
  readonly stdoutFd: number;
  readonly stderrFd: number;
  readonly path: string;
}

/**
 * Opens the append-only descriptors the detached host writes into.
 *
 * One file, two descriptors: interleaving stdout and stderr in a single log
 * preserves the ordering between a message and the error it caused, which two
 * files cannot express. Opened "a" so a restart appends rather than truncating
 * the record of why the previous host died — the single most useful thing in
 * the file at exactly the moment someone reads it.
 *
 * Mode 0600: the log carries session paths and provider chatter, and this file
 * outlives the UI, so it must not be world-readable on a shared machine.
 */
export function openHostLogDescriptors(logDirectory: string, fileName: string): HostLogDescriptors {
  FS.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const path = Path.join(logDirectory, fileName);
  const stdoutFd = FS.openSync(path, "a", 0o600);
  let stderrFd: number;
  try {
    stderrFd = FS.openSync(path, "a", 0o600);
  } catch (error) {
    // Never leak the first descriptor when the second open fails; the parent
    // may go on to retry, and a leaked fd per attempt exhausts the table.
    FS.closeSync(stdoutFd);
    throw error;
  }
  return { stdoutFd, stderrFd, path };
}

/**
 * Closes the parent's copies after the spawn.
 *
 * The child holds its own duplicates, so these are the parent's alone and
 * closing them is required, not optional: hold them and the UI keeps the file
 * open for its whole life, and on Windows that blocks log rotation outright.
 * Errors are swallowed because a descriptor that cannot be closed is already
 * gone, and throwing here would fail a spawn that actually succeeded.
 */
export function closeHostLogDescriptors(descriptors: HostLogDescriptors): void {
  for (const fd of [descriptors.stdoutFd, descriptors.stderrFd]) {
    try {
      FS.closeSync(fd);
    } catch {
      // Already closed, or never valid. Either way there is nothing to release.
    }
  }
}

export interface DetachedHostSpawnInput {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdoutFd: number;
  readonly stderrFd: number;
}

/**
 * Spawn options for the host.
 *
 * `detached: true` is what actually severs the lifetime: it puts the child in
 * its own process group, so a signal sent to the UI's group — a terminal
 * closing, a `kill` on the group id — is not delivered to the server as well.
 * Without it, "detached" describes only the stdio and the host still dies with
 * the session that started it.
 *
 * The caller must also `unref()` the returned child. detached governs signals;
 * unref governs whether the parent's event loop waits for it. Both are needed:
 * detached without unref keeps the UI alive at quit time, waiting on a server
 * that is designed never to exit.
 */
export function detachedHostSpawnOptions(input: DetachedHostSpawnInput): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: true;
  windowsHide: true;
  stdio: ["ignore", number, number];
} {
  return {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    // Without this a detached child on Windows flashes a console window every
    // launch, and the host is started on every UI start.
    windowsHide: true,
    stdio: detachedHostStdio(input.stdoutFd, input.stderrFd),
  };
}
