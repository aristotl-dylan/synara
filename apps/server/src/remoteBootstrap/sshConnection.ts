// FILE: sshConnection.ts
// Purpose: A direct `ssh`/`scp` implementation of RemoteConnection, sufficient
//          to bootstrap a host on its own. It is intentionally the SIMPLEST
//          possible backing for the interface; the multiplexed, probe-validated
//          connection layer replaces this without the bootstrapper noticing.
// Layer: Server / remote broker
// Exports: sshConnectionOptionArgv, SshTarget, createSshConnection
//
// Security posture:
//  - Host-key verification cannot be turned off. There is no option, flag, or
//    config field that produces `StrictHostKeyChecking=no`; the only knob is
//    WHICH known_hosts file is consulted.
//  - Commands are built as argv and encoded with `quotePosixShellCommand`
//    exactly once, at the boundary where OpenSSH is going to hand the payload
//    to a remote login shell regardless of what we do.

import { spawn } from "node:child_process";

import { quotePosixShellCommand } from "@synara/shared/posixShell";

import {
  type RemoteConnection,
  type RemoteExecOptions,
  type RemoteExecResult,
} from "./remoteConnection";

export interface SshTarget {
  readonly host: string;
  readonly user: string;
  readonly port?: number;
  /** Absolute path to the identity file; never the key material itself. */
  readonly identityFile?: string;
  /** Absolute path to a known_hosts file. Defaults to OpenSSH's own. */
  readonly knownHostsFile?: string;
  /**
   * Whether an unknown host key may be accepted and recorded on first contact.
   *
   * This is `accept-new`, NOT `no`: an unknown key is pinned once, and a
   * CHANGED key still fails hard. Turning verification off entirely is not
   * representable in this type by design.
   */
  readonly trustOnFirstUse?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The `-o` options every ssh/scp invocation carries.
 *
 * `StrictHostKeyChecking` is always emitted explicitly so a permissive value in
 * the user's `~/.ssh/config` cannot silently weaken it — the command line wins.
 */
export function sshConnectionOptionArgv(target: SshTarget): ReadonlyArray<string> {
  const argv: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    `StrictHostKeyChecking=${target.trustOnFirstUse ? "accept-new" : "yes"}`,
    "-o",
    "ConnectTimeout=15",
  ];
  if (target.knownHostsFile) {
    argv.push("-o", `UserKnownHostsFile=${target.knownHostsFile}`);
  }
  if (target.identityFile) {
    argv.push("-o", "IdentitiesOnly=yes", "-i", target.identityFile);
  }
  return argv;
}

function describeTarget(target: SshTarget): string {
  return target.port
    ? `${target.user}@${target.host}:${target.port}`
    : `${target.user}@${target.host}`;
}

function runLocal(
  file: string,
  argv: ReadonlyArray<string>,
  options: RemoteExecOptions | undefined,
): Promise<RemoteExecResult> {
  return new Promise((resolve, reject) => {
    // `spawn` with an argv array: no shell is involved on the LOCAL side, so a
    // hostile hostname or path cannot inject here.
    const child = spawn(file, [...argv], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(cause);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });

    if (options?.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export function createSshConnection(
  target: SshTarget,
  run: typeof runLocal = runLocal,
): RemoteConnection {
  const baseArgv = sshConnectionOptionArgv(target);
  const portArgv = target.port ? ["-p", String(target.port)] : [];
  const destination = `${target.user}@${target.host}`;

  return {
    describe: describeTarget(target),
    exec(argv, options) {
      // `ssh host <words>` joins its trailing words with a space and runs the
      // result through the remote login shell. Encoding the argv here is the
      // only correct response; the caller never sees a command string.
      return run(
        "ssh",
        [...baseArgv, ...portArgv, destination, quotePosixShellCommand(argv)],
        options,
      );
    },
    async uploadFile({ localPath, remotePath, mode }) {
      // Upload to a sibling temp path and rename, so an interrupted transfer
      // never leaves truncated bytes at the destination the bootstrapper will
      // later checksum and trust.
      const temporaryPath = `${remotePath}.partial`;
      const scpPortArgv = target.port ? ["-P", String(target.port)] : [];
      const result = await run(
        "scp",
        [...baseArgv, ...scpPortArgv, "--", localPath, `${destination}:${temporaryPath}`],
        undefined,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to upload ${localPath} to ${describeTarget(target)}: ${result.stderr.trim()}`,
        );
      }
      if (mode !== undefined) {
        const chmod = await this.exec([
          "chmod",
          mode.toString(8).padStart(3, "0"),
          "--",
          temporaryPath,
        ]);
        if (chmod.exitCode !== 0) {
          throw new Error(`Failed to set mode on ${remotePath}: ${chmod.stderr.trim()}`);
        }
      }
      const moved = await this.exec(["mv", "--", temporaryPath, remotePath]);
      if (moved.exitCode !== 0) {
        throw new Error(`Failed to finalize ${remotePath}: ${moved.stderr.trim()}`);
      }
    },
  };
}
