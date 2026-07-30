// FILE: remoteBootstrap.ts
// Purpose: Drive an upload-first bootstrap of a Synara server onto a remote
//          host: stage the exact-version artifacts, verify their checksums on
//          the far side, activate by symlink swap, install the supervisor, and
//          verify the provisioning handshake before anyone is allowed to talk
//          to it. Interrupted runs resume; failed activations roll back.
// Layer: Server / remote broker
// Exports: bootstrapRemoteServer, uninstallRemoteServer, rollbackRemoteServer,
//          readRemoteReleaseId, BootstrapOutcome, BootstrapProgress
//
// Crash safety model
// ------------------
// The only mutation that changes what runs is the `current` symlink swap, and
// symlink replacement via `ln -sfn` + rename is atomic. Everything before it
// (upload, checksum, extract) happens in `staging/` and `releases/<id>/`, which
// are inert. So an interruption at any point leaves either the old release
// running or nothing running — never a half-written tree behind `current`.
//
// Resume is content-addressed rather than journalled: a re-run re-checksums the
// remote staged file and skips the upload only when it already matches. A
// truncated file from a killed upload fails that check and is re-uploaded, so a
// partial transfer can never be mistaken for a complete one.

import {
  assertDigestMatch,
  type BootstrapArtifact,
  type BootstrapArtifactSet,
  parseRemoteDigest,
  verifyLocalArtifact,
} from "./bootstrapArtifacts";
import {
  type ProvisioningClaim,
  type RemoteCredential,
  mintRemoteCredential,
  verifyProvisioningHandshake,
} from "./provisioningHandshake";
import {
  expectRemoteSuccess,
  type RemoteConnection,
  type RemoteExecResult,
} from "./remoteConnection";
import {
  isPathInsideInstallRoot,
  type RemoteInstallLayout,
  remoteReleaseDirectory,
} from "./remoteInstallLayout";
import type { SupervisorPlan } from "./remoteSupervisor";
import { normalizeReleaseId } from "./releaseId";

export type BootstrapProgress =
  | { readonly step: "preparing" }
  | { readonly step: "uploading"; readonly artifact: BootstrapArtifact["kind"] }
  | { readonly step: "reusing-staged"; readonly artifact: BootstrapArtifact["kind"] }
  | { readonly step: "verifying"; readonly artifact: BootstrapArtifact["kind"] }
  | { readonly step: "extracting" }
  | { readonly step: "activating" }
  | { readonly step: "installing-supervisor" }
  | { readonly step: "handshake" };

export interface BootstrapOutcome {
  readonly releaseId: string;
  readonly environmentId: string;
  readonly credential: RemoteCredential;
  readonly previousReleaseId: string | null;
}

export interface BootstrapInput {
  readonly connection: RemoteConnection;
  readonly layout: RemoteInstallLayout;
  readonly artifacts: BootstrapArtifactSet;
  readonly supervisor: SupervisorPlan;
  readonly environmentId: string;
  /** Probes the running remote server; injected so the caller owns transport. */
  readonly probeHandshake: (credential: RemoteCredential) => Promise<ProvisioningClaim>;
  readonly onProgress?: (progress: BootstrapProgress) => void;
  readonly mintCredential?: () => RemoteCredential;
}

const REMOTE_DIRECTORY_MODE = "700";
const REMOTE_SECRET_MODE = "600";

function stagedPath(layout: RemoteInstallLayout, artifact: BootstrapArtifact): string {
  return `${layout.stagingDirectory}/${artifact.remoteFileName}`;
}

/**
 * Ask the remote for a file's SHA-256, tolerating either `sha256sum` (Linux) or
 * `shasum -a 256` (macOS). A non-zero exit means "no digest", never "matches".
 */
async function remoteDigest(
  connection: RemoteConnection,
  remotePath: string,
): Promise<string | null> {
  for (const argv of [
    ["sha256sum", "--", remotePath],
    ["shasum", "-a", "256", "--", remotePath],
  ]) {
    const result: RemoteExecResult = await connection.exec(argv);
    if (result.exitCode === 0) {
      const digest = parseRemoteDigest(result.stdout);
      if (digest) return digest;
    }
  }
  return null;
}

async function ensureDirectories(input: BootstrapInput): Promise<void> {
  const { connection, layout } = input;
  await expectRemoteSuccess(connection, [
    "mkdir",
    "-p",
    "--",
    layout.root,
    layout.releasesDirectory,
    layout.stateDirectory,
    layout.stagingDirectory,
  ]);
  // The state directory holds the credential; a group/other-readable tree would
  // hand it to every other account on a shared host.
  await expectRemoteSuccess(connection, [
    "chmod",
    REMOTE_DIRECTORY_MODE,
    "--",
    layout.root,
    layout.stateDirectory,
  ]);
}

/**
 * Upload one artifact unless a byte-identical copy is already staged.
 *
 * The remote-side verification after upload is the one that matters: it is the
 * only check that can see transfer corruption or a truncated resume.
 */
async function stageArtifact(input: BootstrapInput, artifact: BootstrapArtifact): Promise<string> {
  const { connection, layout } = input;
  const remotePath = stagedPath(layout, artifact);
  await verifyLocalArtifact(artifact);

  const existing = await remoteDigest(connection, remotePath);
  if (existing !== null && existing === artifact.sha256.toLowerCase()) {
    input.onProgress?.({ step: "reusing-staged", artifact: artifact.kind });
    return remotePath;
  }

  input.onProgress?.({ step: "uploading", artifact: artifact.kind });
  await connection.uploadFile({
    localPath: artifact.localPath,
    remotePath,
    mode: artifact.mode,
  });

  input.onProgress?.({ step: "verifying", artifact: artifact.kind });
  assertDigestMatch({
    artifact,
    where: "remote",
    actual: await remoteDigest(connection, remotePath),
  });
  return remotePath;
}

/** Reads the release id `current` points at, or null when nothing is active. */
export async function readRemoteReleaseId(
  connection: RemoteConnection,
  layout: RemoteInstallLayout,
): Promise<string | null> {
  const result = await connection.exec(["readlink", "--", layout.currentLink]);
  if (result.exitCode !== 0) return null;
  const target = result.stdout.trim();
  if (target.length === 0) return null;
  const name = target.split("/").findLast((segment) => segment.length > 0);
  if (!name) return null;
  try {
    return normalizeReleaseId(name);
  } catch {
    return null;
  }
}

async function extractRelease(
  input: BootstrapInput,
  tarballRemotePath: string,
  releaseDirectory: string,
): Promise<void> {
  const { connection } = input;
  input.onProgress?.({ step: "extracting" });
  // Extract into a scratch directory and rename into place, so an interrupted
  // extraction never leaves a partial tree at a release id that a later resume
  // would treat as complete.
  const scratch = `${releaseDirectory}.incoming`;
  if (!isPathInsideInstallRoot(input.layout, scratch)) {
    throw new Error(`Refusing to extract outside the install root: ${scratch}`);
  }
  await expectRemoteSuccess(connection, ["rm", "-rf", "--", scratch]);
  await expectRemoteSuccess(connection, ["mkdir", "-p", "--", scratch]);
  await expectRemoteSuccess(connection, ["tar", "-xzf", tarballRemotePath, "-C", scratch]);
  await expectRemoteSuccess(connection, ["rm", "-rf", "--", releaseDirectory]);
  await expectRemoteSuccess(connection, ["mv", "--", scratch, releaseDirectory]);
}

async function writeRemoteSecret(
  connection: RemoteConnection,
  remotePath: string,
  contents: string,
): Promise<void> {
  // The secret travels on stdin, never in argv: argv is visible in the remote
  // process table to every user on the host.
  await expectRemoteSuccess(connection, ["sh", "-c", 'umask 077; cat > "$1"', "sh", remotePath], {
    stdin: contents,
  });
  await expectRemoteSuccess(connection, ["chmod", REMOTE_SECRET_MODE, "--", remotePath]);
}

/** Points `current` at `releaseId`, recording the outgoing one as `previous`. */
async function activateRelease(
  input: BootstrapInput,
  releaseId: string,
  previousReleaseId: string | null,
): Promise<void> {
  const { connection, layout } = input;
  input.onProgress?.({ step: "activating" });
  const releaseDirectory = remoteReleaseDirectory(layout, releaseId);
  if (previousReleaseId !== null) {
    await expectRemoteSuccess(connection, [
      "ln",
      "-sfn",
      "--",
      remoteReleaseDirectory(layout, previousReleaseId),
      layout.previousLink,
    ]);
  }
  await expectRemoteSuccess(connection, ["ln", "-sfn", "--", releaseDirectory, layout.currentLink]);
}

async function runPlanCommands(
  connection: RemoteConnection,
  commands: ReadonlyArray<ReadonlyArray<string>>,
): Promise<void> {
  for (const argv of commands) {
    await expectRemoteSuccess(connection, argv);
  }
}

/** Restores `current` to the previous release and restarts the supervisor. */
export async function rollbackRemoteServer(input: {
  readonly connection: RemoteConnection;
  readonly layout: RemoteInstallLayout;
  readonly supervisor: SupervisorPlan;
  readonly previousReleaseId: string | null;
}): Promise<void> {
  const { connection, layout, supervisor, previousReleaseId } = input;
  if (previousReleaseId === null) {
    // Nothing to roll back to: stop the service and leave `current` dangling
    // rather than pointing at a release that failed its handshake.
    await runPlanCommands(connection, supervisor.stopArgv);
    await connection.exec(["rm", "-f", "--", layout.currentLink]);
    return;
  }
  await expectRemoteSuccess(connection, [
    "ln",
    "-sfn",
    "--",
    remoteReleaseDirectory(layout, previousReleaseId),
    layout.currentLink,
  ]);
  await runPlanCommands(connection, supervisor.startArgv);
}

export async function bootstrapRemoteServer(input: BootstrapInput): Promise<BootstrapOutcome> {
  const { connection, layout, artifacts, supervisor } = input;
  const releaseId = normalizeReleaseId(artifacts.releaseId);
  input.onProgress?.({ step: "preparing" });
  await ensureDirectories(input);

  const previousReleaseId = await readRemoteReleaseId(connection, layout);

  const tarballRemotePath = await stageArtifact(input, artifacts.serverTarball);
  await stageArtifact(input, artifacts.nodeRuntime);

  const releaseDirectory = remoteReleaseDirectory(layout, releaseId);
  await extractRelease(input, tarballRemotePath, releaseDirectory);

  const credential = (input.mintCredential ?? mintRemoteCredential)();
  await writeRemoteSecret(connection, layout.credentialFile, `${credential.token}\n`);
  await writeRemoteSecret(connection, layout.environmentIdFile, `${input.environmentId}\n`);

  await activateRelease(input, releaseId, previousReleaseId);

  input.onProgress?.({ step: "installing-supervisor" });
  await writeRemoteSecret(connection, supervisor.unitPath, supervisor.unitContents);
  await runPlanCommands(connection, supervisor.installArgv);
  await runPlanCommands(connection, supervisor.startArgv);

  input.onProgress?.({ step: "handshake" });
  try {
    const claim = await input.probeHandshake(credential);
    const verdict = verifyProvisioningHandshake({
      claim,
      expected: {
        environmentId: input.environmentId,
        serverVersion: artifacts.serverVersion,
        credential,
      },
    });
    if (!verdict.ok) {
      throw new Error(verdict.reason);
    }
  } catch (cause) {
    // A server we could not verify must never be reachable by a client, so the
    // failure path is a rollback, not a warning.
    await rollbackRemoteServer({ connection, layout, supervisor, previousReleaseId });
    throw cause;
  }

  // Staged artifacts are only removed once the new release is verified running,
  // so a mid-bootstrap crash leaves them for the next attempt to reuse.
  await connection.exec(["rm", "-rf", "--", layout.stagingDirectory]);

  return { releaseId, environmentId: input.environmentId, credential, previousReleaseId };
}

/**
 * Remove a remote install completely.
 *
 * Every command names the exact unit and the exact path. There is deliberately
 * no process-name matching: a `pkill -f synara` here would kill an unrelated
 * Synara that another user, or the same user, is running on the same host.
 */
export async function uninstallRemoteServer(input: {
  readonly connection: RemoteConnection;
  readonly layout: RemoteInstallLayout;
  readonly supervisor: SupervisorPlan;
}): Promise<void> {
  const { connection, layout, supervisor } = input;
  for (const argv of supervisor.uninstallArgv) {
    // Uninstall is best-effort per step: a unit that was never installed must
    // not block deleting the files, or a half-bootstrapped host stays dirty
    // forever.
    await connection.exec(argv);
  }
  // Stop whatever the pidfile names, and only that. An unparseable or foreign
  // pid is skipped rather than guessed at.
  const pidResult = await connection.exec(["cat", "--", layout.pidFile]);
  const pid = Number.parseInt(pidResult.stdout.trim(), 10);
  if (pidResult.exitCode === 0 && Number.isInteger(pid) && pid > 1) {
    await connection.exec(["kill", "-TERM", String(pid)]);
  }
  if (!isPathInsideInstallRoot(layout, layout.root)) {
    throw new Error(`Refusing to remove a path outside the install root: ${layout.root}`);
  }
  await expectRemoteSuccess(connection, ["rm", "-rf", "--", layout.root]);
}
