import { describe, expect, it } from "vitest";

import {
  compareReleaseVersions,
  evaluateSelfUpdatePoll,
  INITIAL_SELF_UPDATE_PROGRESS,
  parseReleaseVersion,
  recordSelfUpdateAttempt,
  type SelfUpdatePollInput,
} from "./remoteSelfUpdatePolicy";

describe("parseReleaseVersion", () => {
  it.each([
    ["0.6.3", { major: 0, minor: 6, patch: 3 }],
    ["v1.2.34", { major: 1, minor: 2, patch: 34 }],
    ["0.7.0-rc.1", { major: 0, minor: 7, patch: 0 }],
    ["10.20.30+build", { major: 10, minor: 20, patch: 30 }],
  ])("parses %s", (input, expected) => {
    expect(parseReleaseVersion(input)).toEqual(expected);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["major.minor only", "0.6"],
    ["not numbers", "latest"],
    ["trailing garbage without separator", "0.6.3nope"],
  ])("rejects %s", (_label, input) => {
    expect(parseReleaseVersion(input as string | undefined)).toBeNull();
  });
});

describe("compareReleaseVersions", () => {
  const v = (s: string) => parseReleaseVersion(s)!;
  it("orders by major, then minor, then patch", () => {
    expect(compareReleaseVersions(v("0.6.3"), v("0.7.0"))).toBeLessThan(0);
    expect(compareReleaseVersions(v("0.6.3"), v("0.6.4"))).toBeLessThan(0);
    expect(compareReleaseVersions(v("1.0.0"), v("0.9.9"))).toBeGreaterThan(0);
    expect(compareReleaseVersions(v("0.6.3"), v("0.6.3"))).toBe(0);
    // Patch must not dominate minor: 0.6.10 > 0.6.9 numerically, not lexically.
    expect(compareReleaseVersions(v("0.6.10"), v("0.6.9"))).toBeGreaterThan(0);
  });
});

function input(overrides: Partial<SelfUpdatePollInput> = {}): SelfUpdatePollInput {
  return {
    currentReleaseId: "0.6.3",
    latestReleaseId: "0.7.0",
    autoUpdateEnabled: true,
    consecutiveFailures: 0,
    maxConsecutiveFailures: 3,
    ...overrides,
  };
}

describe("evaluateSelfUpdatePoll", () => {
  it("upgrades to a strictly newer release", () => {
    expect(evaluateSelfUpdatePoll(input())).toEqual({
      action: "upgrade",
      targetReleaseId: "0.7.0",
    });
  });

  it("upgrades a patch bump too", () => {
    expect(
      evaluateSelfUpdatePoll(input({ currentReleaseId: "0.6.3", latestReleaseId: "0.6.4" })),
    ).toEqual({ action: "upgrade", targetReleaseId: "0.6.4" });
  });

  it("does nothing when already current", () => {
    expect(
      evaluateSelfUpdatePoll(input({ currentReleaseId: "0.7.0", latestReleaseId: "0.7.0" })),
    ).toEqual({ action: "up-to-date" });
  });

  it("NEVER downgrades when the registry reports an older latest", () => {
    // A registry briefly serving a stale older "latest" must not roll the host
    // back. This is the single most important guard in the module.
    expect(
      evaluateSelfUpdatePoll(input({ currentReleaseId: "0.7.0", latestReleaseId: "0.6.3" })),
    ).toEqual({ action: "up-to-date" });
  });

  it("does nothing when opted out, whatever the registry says", () => {
    expect(
      evaluateSelfUpdatePoll(input({ autoUpdateEnabled: false, latestReleaseId: "9.9.9" })),
    ).toEqual({ action: "disabled" });
  });

  it("disabled takes precedence over a pending give-up", () => {
    // Ordering: an opted-out host does nothing even if it also happens to have
    // failed repeatedly.
    expect(
      evaluateSelfUpdatePoll(
        input({ autoUpdateEnabled: false, consecutiveFailures: 5, maxConsecutiveFailures: 3 }),
      ),
    ).toEqual({ action: "disabled" });
  });

  it("gives up after the failure threshold", () => {
    // Each failed upgrade drains, swaps, fails the handshake, and rolls back;
    // looping that against a bad release forever burns the box.
    expect(
      evaluateSelfUpdatePoll(input({ consecutiveFailures: 3, maxConsecutiveFailures: 3 })),
    ).toEqual({ action: "give-up", consecutiveFailures: 3 });
  });

  it("keeps trying below the failure threshold", () => {
    expect(
      evaluateSelfUpdatePoll(input({ consecutiveFailures: 2, maxConsecutiveFailures: 3 })),
    ).toMatchObject({ action: "upgrade" });
  });

  it("waits when the latest is unknown rather than guessing", () => {
    // A null latest is the ABSENCE of information. Doing anything with it is a
    // guess; the fail-safe is to re-check next tick.
    expect(evaluateSelfUpdatePoll(input({ latestReleaseId: null }))).toEqual({
      action: "unknown-latest",
    });
  });

  it("gives up before consulting an unknown latest", () => {
    // A host that has already failed out should not keep hitting the registry.
    expect(
      evaluateSelfUpdatePoll(
        input({ latestReleaseId: null, consecutiveFailures: 3, maxConsecutiveFailures: 3 }),
      ),
    ).toEqual({ action: "give-up", consecutiveFailures: 3 });
  });

  it("refuses to act on an unparseable installed version", () => {
    expect(
      evaluateSelfUpdatePoll(input({ currentReleaseId: "garbage", latestReleaseId: "0.7.0" })),
    ).toEqual({ action: "unparseable", which: "current" });
  });

  it("refuses to act on an unparseable latest version", () => {
    expect(
      evaluateSelfUpdatePoll(input({ currentReleaseId: "0.6.3", latestReleaseId: "latest" })),
    ).toEqual({ action: "unparseable", which: "latest" });
  });
});

describe("recordSelfUpdateAttempt", () => {
  it("starts a fresh streak on the first failure", () => {
    expect(
      recordSelfUpdateAttempt(INITIAL_SELF_UPDATE_PROGRESS, {
        kind: "failed",
        targetReleaseId: "0.7.0",
      }),
    ).toEqual({ failingTargetReleaseId: "0.7.0", consecutiveFailures: 1 });
  });

  it("increments while the SAME release keeps failing", () => {
    // This is what eventually trips give-up so a release that cannot install
    // stops being retried forever.
    let progress = INITIAL_SELF_UPDATE_PROGRESS;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      progress = recordSelfUpdateAttempt(progress, { kind: "failed", targetReleaseId: "0.7.0" });
      expect(progress.consecutiveFailures).toBe(attempt);
      expect(progress.failingTargetReleaseId).toBe("0.7.0");
    }
  });

  it("resets to one when a DIFFERENT release is attempted", () => {
    // A newly published release is not the one that was failing; it gets its own
    // budget. Without this a single bad release would poison every release after
    // it, and a host that gave up once would never update again.
    const failing = { failingTargetReleaseId: "0.7.0", consecutiveFailures: 3 };
    expect(recordSelfUpdateAttempt(failing, { kind: "failed", targetReleaseId: "0.8.0" })).toEqual({
      failingTargetReleaseId: "0.8.0",
      consecutiveFailures: 1,
    });
  });

  it("clears the streak on success", () => {
    const failing = { failingTargetReleaseId: "0.7.0", consecutiveFailures: 2 };
    expect(recordSelfUpdateAttempt(failing, { kind: "succeeded" })).toEqual(
      INITIAL_SELF_UPDATE_PROGRESS,
    );
  });

  it("composes with the poll so give-up fires for one release but a new one retries", () => {
    // End-to-end of the two functions together: fail 0.7.0 to the threshold →
    // give-up; then 0.8.0 appears → the streak resets and the poll upgrades.
    let progress = INITIAL_SELF_UPDATE_PROGRESS;
    for (let i = 0; i < 3; i += 1) {
      progress = recordSelfUpdateAttempt(progress, { kind: "failed", targetReleaseId: "0.7.0" });
    }
    expect(
      evaluateSelfUpdatePoll({
        currentReleaseId: "0.6.3",
        latestReleaseId: "0.7.0",
        autoUpdateEnabled: true,
        consecutiveFailures: progress.consecutiveFailures,
        maxConsecutiveFailures: 3,
      }),
    ).toEqual({ action: "give-up", consecutiveFailures: 3 });

    // 0.8.0 published: the reducer resets the streak on the next (failed or not)
    // attempt against it, so the poll is free to upgrade again.
    const afterNewRelease = recordSelfUpdateAttempt(progress, {
      kind: "failed",
      targetReleaseId: "0.8.0",
    });
    expect(
      evaluateSelfUpdatePoll({
        currentReleaseId: "0.6.3",
        latestReleaseId: "0.8.0",
        autoUpdateEnabled: true,
        consecutiveFailures: afterNewRelease.consecutiveFailures,
        maxConsecutiveFailures: 3,
      }),
    ).toMatchObject({ action: "upgrade", targetReleaseId: "0.8.0" });
  });
});
