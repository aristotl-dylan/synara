// FILE: launchAgent.ts
// Purpose: Render a launchd user agent and the launchctl argv that manages it,
//          for any Synara host that must come back after a logout or a reboot.
// Layer: Shared runtime utility
// Exports: renderLaunchAgentPlist, launchAgentPath, bootstrapArgv, bootoutArgv,
//          kickstartArgv, escapeXmlText, LaunchAgentSpec
//
// Why shared rather than in the remote bootstrapper
// -------------------------------------------------
// A desktop that hosts sessions and a remote box that hosts sessions want the
// same thing from launchd: start at login, restart on abnormal exit, log to one
// file. The remote side already had this; the desktop cannot import it, because
// apps/desktop depends on @synara/shared and not on @synara/server.
//
// What is NOT shared is the install layout. The remote installer owns a release
// tree with current/previous symlinks it swaps and rolls back; a desktop's
// server is replaced by the app updater and has no such tree. Generalising over
// both would mean inventing fields for one of them, so this takes the five
// values a plist actually needs and lets each caller supply them.

/**
 * Escapes text for an XML text node.
 *
 * Apostrophes are deliberately not escaped: `&apos;` is legal XML but the
 * predefined entity set for text nodes does not require it, and paths with
 * apostrophes are common enough on macOS ("Dylan's Mac") that emitting the
 * entity would make the plist harder to read for no gain in correctness.
 */
export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** launchd rejects labels outside this shape, and so do we, before writing one. */
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface LaunchAgentSpec {
  /** Reverse-DNS label; also the filename stem and the launchctl service name. */
  readonly label: string;
  /** Executable plus arguments. Never a shell string. */
  readonly argv: readonly string[];
  readonly workingDirectory: string;
  /** stdout and stderr both, so a message and the error it caused stay ordered. */
  readonly logPath: string;
  readonly environment?: Readonly<Record<string, string>>;
}

function assertLabel(label: string): string {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`Invalid launchd label: ${JSON.stringify(label)}`);
  }
  return label;
}

function assertAbsolute(path: string, what: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("..")) {
    throw new Error(`${what} must be an absolute path without "..": ${JSON.stringify(path)}`);
  }
  return trimmed;
}

/**
 * Renders the agent.
 *
 * `KeepAlive`/`SuccessfulExit=false` rather than a bare `KeepAlive` boolean:
 * the boolean form restarts the job even after it exits cleanly, which turns a
 * deliberate stop into a restart loop. This form restarts only abnormal exits,
 * so stopping the host to install an update actually stops it.
 */
export function renderLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const label = assertLabel(spec.label);
  if (spec.argv.length === 0) {
    throw new Error("A launch agent needs at least a program to run.");
  }
  const workingDirectory = assertAbsolute(spec.workingDirectory, "WorkingDirectory");
  const logPath = assertAbsolute(spec.logPath, "log path");

  const argumentLines = spec.argv
    .map((token) => `    <string>${escapeXmlText(token)}</string>`)
    .join("\n");

  const environment = spec.environment ?? {};
  // Sorted so the same spec always renders byte-identically; an agent that
  // differs only by key order would look changed to anything comparing files.
  const environmentLines = Object.keys(environment)
    .sort()
    .flatMap((key) => [
      `    <key>${escapeXmlText(key)}</key>`,
      `    <string>${escapeXmlText(environment[key] ?? "")}</string>`,
    ]);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXmlText(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argumentLines,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXmlText(workingDirectory)}</string>`,
    ...(environmentLines.length > 0
      ? ["  <key>EnvironmentVariables</key>", "  <dict>", ...environmentLines, "  </dict>"]
      : []),
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXmlText(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXmlText(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function launchAgentPath(homeDirectory: string, label: string): string {
  return `${assertAbsolute(homeDirectory, "home directory")}/Library/LaunchAgents/${assertLabel(label)}.plist`;
}

/**
 * The GUI domain for a uid.
 *
 * `gui/<uid>`, not `user/<uid>`: the user domain exists without a login session
 * and a job there cannot reach the window server or the login keychain. A host
 * that must launch provider CLIs needs the session the user actually logged
 * into.
 */
export function launchdGuiDomain(userId: number): string {
  if (!Number.isInteger(userId) || userId < 0) {
    throw new Error(`Invalid user id: ${userId}`);
  }
  return `gui/${userId}`;
}

/** Loads the agent and starts it. Argv arrays throughout; never a shell string. */
export function bootstrapArgv(userId: number, plistPath: string): readonly string[] {
  return ["launchctl", "bootstrap", launchdGuiDomain(userId), assertAbsolute(plistPath, "plist")];
}

/**
 * Unloads it.
 *
 * Takes the SERVICE target (`gui/<uid>/<label>`), not the plist path. bootout
 * accepts both, but the path form fails once the file is gone — which is
 * exactly the state an uninstall is trying to reach, so the path form makes
 * uninstall order-dependent for no reason.
 */
export function bootoutArgv(userId: number, label: string): readonly string[] {
  return ["launchctl", "bootout", `${launchdGuiDomain(userId)}/${assertLabel(label)}`];
}

/**
 * Restarts a loaded agent.
 *
 * `-k` kills the running instance first. Without it kickstart is a no-op on a
 * job that is already running, so an update that swapped the binary would leave
 * the old one serving.
 */
export function kickstartArgv(userId: number, label: string): readonly string[] {
  return ["launchctl", "kickstart", "-k", `${launchdGuiDomain(userId)}/${assertLabel(label)}`];
}
