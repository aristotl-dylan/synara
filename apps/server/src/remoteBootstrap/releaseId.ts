// FILE: releaseId.ts
// Purpose: Validate the one caller-influenced component of every remote path.
// Layer: Server / remote broker
// Exports: normalizeReleaseId, isValidReleaseId, containsControlCharacter

/**
 * A release id becomes a directory name under the install root and a systemd
 * unit's WorkingDirectory. It is derived from a version string that ultimately
 * came from a release artifact, so it is treated as untrusted input: only
 * characters that are inert in a path AND in a unit file are accepted.
 *
 * Rejecting is the whole point — `..`, `/`, NUL, newline, and `%` (a systemd
 * specifier escape) must never reach a path or a unit.
 */
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * True when a string contains a NUL, newline, carriage return, or any other C0
 * control character.
 *
 * Written as a code-point scan rather than a regex so the intent is explicit
 * and so no escaping subtlety can quietly narrow what it catches. Control
 * characters are the tokens that split a systemd unit line, terminate a path,
 * or forge a second command, so this is a hard reject everywhere it is used.
 */
export function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isValidReleaseId(value: string): boolean {
  if (!RELEASE_ID_PATTERN.test(value)) return false;
  // Belt and braces: the pattern already excludes `/`, but a value consisting
  // only of dots would still be a traversal segment.
  return !/^\.+$/.test(value) && !value.includes("..");
}

export function normalizeReleaseId(value: string): string {
  const trimmed = value.trim();
  if (!isValidReleaseId(trimmed)) {
    throw new Error(`Invalid remote release id: ${JSON.stringify(value)}`);
  }
  return trimmed;
}
