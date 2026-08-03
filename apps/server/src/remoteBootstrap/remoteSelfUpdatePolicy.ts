// FILE: remoteSelfUpdatePolicy.ts
// Purpose: Decide, on each poll tick, whether a remote host should upgrade
//          itself — the "poll →" step that precedes the drain/swap/handshake/
//          rollback flow bootstrapRemoteServer already implements.
// Layer: Server / remote broker
// Exports: parseReleaseVersion, compareReleaseVersions, evaluateSelfUpdatePoll,
//          SelfUpdateDecision
//
// Why a pure decision, separate from the reactor
// ----------------------------------------------
// The reactor that runs this on a timer fetches the latest release from a
// registry and, on an "upgrade" verdict, calls bootstrapRemoteServer with the
// upgrade field set. Both of those are effects — a network read and a
// multi-step install — and neither can be exhaustively tested against the cases
// that decide safety: a registry that reports an OLDER version than what is
// installed, a registry that is briefly unreachable, a release that fails to
// install over and over. Those live here, as data in and a decision out.
//
// bootstrapRemoteServer already owns the risky half (evaluateUpgradeGate drains,
// activateRelease swaps, verifyProvisioningHandshake checks, rollbackRemoteServer
// restores the pinned previous). This module only decides WHETHER to hand it a
// target, and never hands it one that would move the host backward or sideways.

export interface ReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Parses a pinned release id (`major.minor.patch`, optional leading `v`).
 *
 * Full patch precision, unlike parseBuildVersion which stops at major.minor:
 * an upgrade from 0.6.3 to 0.6.4 is a real upgrade, and a poll that could not
 * see the patch would either miss it or, worse, treat the two as equal and
 * upgrade in a loop. Returns null for anything unparseable so the caller
 * decides the fail-safe direction explicitly rather than guessing a number.
 */
export function parseReleaseVersion(releaseId: string | undefined): ReleaseVersion | null {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[.+-]|$)/.exec(releaseId ?? "");
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((n) => Number.isSafeInteger(n))) return null;
  return { major, minor, patch };
}

/**
 * Orders two release versions: negative when `a` precedes `b`, positive when it
 * follows, zero when equal. Precedence is major, then minor, then patch — the
 * standard semver ordering for the numeric core.
 */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export type SelfUpdateDecision =
  | { readonly action: "upgrade"; readonly targetReleaseId: string }
  | { readonly action: "up-to-date" }
  | { readonly action: "disabled" }
  | { readonly action: "unknown-latest" }
  | { readonly action: "unparseable"; readonly which: "current" | "latest" }
  | { readonly action: "give-up"; readonly consecutiveFailures: number };

export interface SelfUpdatePollInput {
  /** Release id currently installed on the host, read from the host itself. */
  readonly currentReleaseId: string;
  /**
   * Latest release the version source reports, or null when the source could
   * not be reached. Null is NOT an error to act on — it is the absence of a
   * decision, and the poll waits for the next tick.
   */
  readonly latestReleaseId: string | null;
  /** The user's opt-in. A host never upgrades itself unless this is true. */
  readonly autoUpdateEnabled: boolean;
  /** How many upgrade attempts have failed in a row. */
  readonly consecutiveFailures: number;
  /** After this many consecutive failures, stop trying until something resets. */
  readonly maxConsecutiveFailures: number;
}

/**
 * The poll decision.
 *
 * The order of the guards is the safety argument:
 *
 * 1. `disabled` first — an opted-out host does nothing, whatever the registry
 *    says. This is the strongest guarantee and must not be reachable-past.
 * 2. `give-up` next — a host that has failed N times in a row stops. Each
 *    failed upgrade drains, swaps, fails the handshake, and rolls back; looping
 *    that forever against a bad release burns the box and the network. The
 *    counter resets elsewhere (a new latest, a manual retry).
 * 3. `unknown-latest` — a null latest is the absence of information. Acting on
 *    it could only mean guessing, and the fail-safe for "we don't know" is to
 *    do nothing and re-check next tick.
 * 4. Parse both. An unparseable version on either side is treated as "do not
 *    act": upgrading toward or away from a number we cannot order is exactly the
 *    move that could go backward.
 * 5. Only then, compare. Upgrade ONLY when latest is strictly greater than
 *    current. Equal is up-to-date; LESS is also up-to-date, never a downgrade —
 *    a registry briefly serving a stale older "latest" must not roll the host
 *    back.
 */
export function evaluateSelfUpdatePoll(input: SelfUpdatePollInput): SelfUpdateDecision {
  if (!input.autoUpdateEnabled) {
    return { action: "disabled" };
  }

  if (input.consecutiveFailures >= input.maxConsecutiveFailures) {
    return { action: "give-up", consecutiveFailures: input.consecutiveFailures };
  }

  if (input.latestReleaseId === null) {
    return { action: "unknown-latest" };
  }

  const current = parseReleaseVersion(input.currentReleaseId);
  if (!current) {
    return { action: "unparseable", which: "current" };
  }
  const latest = parseReleaseVersion(input.latestReleaseId);
  if (!latest) {
    return { action: "unparseable", which: "latest" };
  }

  // Strictly greater only. Equal or lesser is up-to-date, never a downgrade.
  if (compareReleaseVersions(latest, current) > 0) {
    return { action: "upgrade", targetReleaseId: input.latestReleaseId };
  }
  return { action: "up-to-date" };
}

/**
 * The failure state the poll consumes, tracked PER TARGET RELEASE.
 *
 * `consecutiveFailures` on its own is not enough, because it has to answer two
 * questions that pull in opposite directions: should a host stop hammering a
 * release that keeps failing to install, AND should it try a newly published
 * release even though the previous one failed? Counting failures against a
 * specific target answers both — the count climbs while one release keeps
 * failing, and resets the moment a different release is attempted.
 */
export interface SelfUpdateProgress {
  /** The release the failures are against, or null when there is no failing streak. */
  readonly failingTargetReleaseId: string | null;
  readonly consecutiveFailures: number;
}

export const INITIAL_SELF_UPDATE_PROGRESS: SelfUpdateProgress = {
  failingTargetReleaseId: null,
  consecutiveFailures: 0,
};

export type SelfUpdateAttemptOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly targetReleaseId: string };

/**
 * Folds one upgrade attempt into the progress state.
 *
 * - A success clears the streak: whatever we reached is now current, and the
 *   next poll starts fresh.
 * - A failure against the SAME target increments — this is what eventually
 *   trips the give-up guard, so a release that cannot install stops being
 *   retried forever.
 * - A failure against a DIFFERENT target starts a new streak at one. A newly
 *   published release is not the release that was failing, so it gets its own
 *   budget; without this a single bad release would poison every release after
 *   it, and a host that gave up once would never update again.
 */
export function recordSelfUpdateAttempt(
  previous: SelfUpdateProgress,
  outcome: SelfUpdateAttemptOutcome,
): SelfUpdateProgress {
  if (outcome.kind === "succeeded") {
    return INITIAL_SELF_UPDATE_PROGRESS;
  }
  if (previous.failingTargetReleaseId === outcome.targetReleaseId) {
    return {
      failingTargetReleaseId: outcome.targetReleaseId,
      consecutiveFailures: previous.consecutiveFailures + 1,
    };
  }
  return { failingTargetReleaseId: outcome.targetReleaseId, consecutiveFailures: 1 };
}
