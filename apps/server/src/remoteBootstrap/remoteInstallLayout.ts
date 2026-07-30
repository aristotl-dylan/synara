// FILE: remoteInstallLayout.ts
// Purpose: One definition of where a bootstrapped Synara lives on a remote host.
//          Every path the bootstrapper touches — and, critically, every path
//          uninstall deletes — is derived here, so cleanup can be scoped to an
//          exact tree instead of a pattern.
// Layer: Server / remote broker
// Exports: RemoteInstallLayout, remoteInstallLayout, remoteReleaseDirectory,
//          isPathInsideInstallRoot, assertSafeInstallRoot

import { containsControlCharacter, normalizeReleaseId } from "./releaseId";

/**
 * The absolute paths of one remote install, rooted at `root`.
 *
 * The layout is deliberately release-versioned:
 *
 *   <root>/releases/<releaseId>/    an extracted, immutable release
 *   <root>/current                  symlink -> the active release
 *   <root>/previous                 symlink -> the rollback target
 *   <root>/state/                   environment id, credential, pidfile
 *
 * Activation is a symlink swap, so a failed upload can never leave a
 * half-written tree at the path the supervisor launches from.
 */
export interface RemoteInstallLayout {
  readonly root: string;
  readonly releasesDirectory: string;
  readonly currentLink: string;
  readonly previousLink: string;
  readonly stateDirectory: string;
  readonly stagingDirectory: string;
  readonly pidFile: string;
  readonly credentialFile: string;
  readonly environmentIdFile: string;
  readonly logFile: string;
  readonly lockFile: string;
}

/**
 * Roots we refuse to manage.
 *
 * The uninstall path recursively deletes the root, so a caller-supplied root
 * that is `/`, a bare home directory, or a relative path would turn cleanup
 * into data loss. This list is the guard, and it is asserted at construction
 * time rather than at delete time so a bad root can never be installed to in
 * the first place.
 */
const FORBIDDEN_INSTALL_ROOTS: ReadonlySet<string> = new Set([
  "/",
  "/root",
  "/home",
  "/usr",
  "/usr/local",
  "/etc",
  "/var",
  "/tmp",
  "/opt",
  "/Users",
]);

/** Strips redundant separators and any trailing slash, preserving a leading `/`. */
function normalizePosixPath(value: string): string {
  const collapsed = value.replaceAll(/\/+/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

/**
 * A remote install root must be absolute, free of traversal segments, and deep
 * enough that deleting it cannot take out a system or home directory.
 */
export function assertSafeInstallRoot(root: string): string {
  const normalized = normalizePosixPath(root.trim());
  if (!normalized.startsWith("/")) {
    throw new Error(`Remote install root must be an absolute POSIX path: ${root}`);
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Remote install root must not contain relative segments: ${root}`);
  }
  if (segments.some((segment) => containsControlCharacter(segment))) {
    throw new Error(`Remote install root contains illegal characters: ${root}`);
  }
  if (FORBIDDEN_INSTALL_ROOTS.has(normalized)) {
    throw new Error(`Refusing to manage a Synara install at ${normalized}`);
  }
  // `/home/alice` and `/Users/alice` are a user's whole home directory; only a
  // subdirectory of one may be managed.
  if (segments.length < 3 && (segments[0] === "home" || segments[0] === "Users")) {
    throw new Error(`Refusing to manage a Synara install at a home directory root: ${normalized}`);
  }
  return normalized;
}

export function remoteInstallLayout(root: string): RemoteInstallLayout {
  const normalizedRoot = assertSafeInstallRoot(root);
  return {
    root: normalizedRoot,
    releasesDirectory: `${normalizedRoot}/releases`,
    currentLink: `${normalizedRoot}/current`,
    previousLink: `${normalizedRoot}/previous`,
    stateDirectory: `${normalizedRoot}/state`,
    stagingDirectory: `${normalizedRoot}/staging`,
    pidFile: `${normalizedRoot}/state/synara.pid`,
    credentialFile: `${normalizedRoot}/state/auth-token`,
    environmentIdFile: `${normalizedRoot}/state/environment-id`,
    logFile: `${normalizedRoot}/state/synara.log`,
    lockFile: `${normalizedRoot}/state/bootstrap.lock`,
  };
}

export function remoteReleaseDirectory(layout: RemoteInstallLayout, releaseId: string): string {
  return `${layout.releasesDirectory}/${normalizeReleaseId(releaseId)}`;
}

/**
 * True when `candidate` is the install root or lives strictly inside it.
 *
 * Every destructive operation is gated on this, so a computed path that somehow
 * escaped the layout (a crafted release id, a symlinked staging dir) is refused
 * rather than deleted.
 */
export function isPathInsideInstallRoot(layout: RemoteInstallLayout, candidate: string): boolean {
  const normalized = normalizePosixPath(candidate);
  if (!normalized.startsWith("/")) return false;
  if (normalized.split("/").includes("..")) return false;
  return normalized === layout.root || normalized.startsWith(`${layout.root}/`);
}
