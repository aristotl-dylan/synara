import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mayInstallAfterStop, stopDetachedHost, type StopHostOutcome } from "./hostStop";

let workspace: string;
let recordPath: string;

beforeEach(() => {
  workspace = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-host-stop-"));
  recordPath = Path.join(workspace, "server-runtime.json");
});

afterEach(() => {
  FS.rmSync(workspace, { recursive: true, force: true });
});

function writeRecord(pid: number): void {
  FS.writeFileSync(
    recordPath,
    JSON.stringify({
      version: 1,
      pid,
      port: 21987,
      origin: "http://127.0.0.1:21987",
      startedAt: "2026-08-03T12:00:00.000Z",
    }),
  );
}

const noSleep = async () => undefined;

describe("stopDetachedHost", () => {
  it("reports nothing to stop when no record exists", async () => {
    await expect(stopDetachedHost({ recordPath })).resolves.toEqual({ kind: "not-running" });
  });

  it("reports nothing to stop for a stale record", async () => {
    writeRecord(4242);
    const kill = vi.fn();
    await expect(
      stopDetachedHost({ recordPath, kill, isAlive: () => false, sleep: noSleep }),
    ).resolves.toEqual({ kind: "not-running" });
    // No signal for a pid that is gone: the OS may have recycled it, and
    // signalling it would hit an unrelated process.
    expect(kill).not.toHaveBeenCalled();
  });

  it("stops a live host with SIGTERM", async () => {
    writeRecord(4242);
    const kill = vi.fn();
    let alive = true;
    const outcome = await stopDetachedHost({
      recordPath,
      kill: (pid, signal) => {
        kill(pid, signal);
        alive = false;
      },
      isAlive: () => alive,
      sleep: noSleep,
      currentPid: 1,
    });
    expect(outcome).toEqual({ kind: "stopped", pid: 4242, forced: false });
    // SIGTERM lets the server run its finalizers: flush the journal,
    // terminalize open turns, remove its own record.
    expect(kill).toHaveBeenCalledExactlyOnceWith(4242, "SIGTERM");
  });

  it("escalates to SIGKILL when the host ignores SIGTERM", async () => {
    writeRecord(4242);
    const signals: string[] = [];
    let alive = true;
    const outcome = await stopDetachedHost({
      recordPath,
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") alive = false;
      },
      isAlive: () => alive,
      sleep: noSleep,
      gracefulTimeoutMs: 300,
      currentPid: 1,
    });
    expect(outcome).toEqual({ kind: "stopped", pid: 4242, forced: true });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("gives the host its full graceful window before forcing", async () => {
    // A host mid-turn can legitimately take seconds to drain; killing early
    // turns an orderly update into the crash path.
    writeRecord(4242);
    const signals: string[] = [];
    let polls = 0;
    await stopDetachedHost({
      recordPath,
      kill: (_pid, signal) => signals.push(signal),
      isAlive: () => {
        polls += 1;
        return polls < 5;
      },
      sleep: noSleep,
      gracefulTimeoutMs: 10_000,
      currentPid: 1,
    });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("reports failure when the host survives SIGKILL", async () => {
    writeRecord(4242);
    const outcome = await stopDetachedHost({
      recordPath,
      kill: () => undefined,
      isAlive: () => true,
      sleep: noSleep,
      gracefulTimeoutMs: 200,
      forceTimeoutMs: 200,
      currentPid: 1,
    });
    // Installing over a wedged host is how a home gets two writers, so this is
    // reported rather than assumed away.
    expect(outcome).toEqual({
      kind: "failed",
      pid: 4242,
      reason: "the host did not exit after SIGKILL",
    });
  });

  it("reports failure when the host belongs to another user", async () => {
    writeRecord(4242);
    const outcome = await stopDetachedHost({
      recordPath,
      kill: () => {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
      isAlive: () => true,
      sleep: noSleep,
      currentPid: 1,
    });
    expect(outcome).toEqual({
      kind: "failed",
      pid: 4242,
      reason: "could not signal the host (EPERM)",
    });
  });

  it("treats a host that vanished mid-stop as stopped", async () => {
    writeRecord(4242);
    const outcome = await stopDetachedHost({
      recordPath,
      kill: () => {
        const error = new Error("no such process") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      },
      isAlive: () => true,
      sleep: noSleep,
      currentPid: 1,
    });
    expect(outcome).toEqual({ kind: "not-running" });
  });

  it("never signals itself", async () => {
    writeRecord(process.pid);
    const kill = vi.fn();
    const outcome = await stopDetachedHost({
      recordPath,
      kill,
      isAlive: () => true,
      sleep: noSleep,
    });
    expect(outcome).toEqual({
      kind: "refused",
      reason: "the recorded host is this process",
    });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("mayInstallAfterStop", () => {
  it.each<[StopHostOutcome, boolean]>([
    [{ kind: "stopped", pid: 1, forced: false }, true],
    [{ kind: "stopped", pid: 1, forced: true }, true],
    [{ kind: "not-running" }, true],
    [{ kind: "failed", pid: 1, reason: "wedged" }, false],
    [{ kind: "refused", reason: "self" }, false],
  ])("gates the install on %j", (outcome, expected) => {
    expect(mayInstallAfterStop(outcome)).toBe(expected);
  });
});

describe("stopping a real detached process", () => {
  it("stops it with SIGTERM and confirms it is gone", async () => {
    if (process.platform === "win32") return;

    // A process that ignores nothing and exits on SIGTERM, like the server.
    const child = ChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid;
    expect(pid).toBeDefined();
    writeRecord(pid!);

    const outcome = await stopDetachedHost({
      recordPath,
      currentPid: process.pid,
      gracefulTimeoutMs: 8_000,
    });

    expect(outcome).toEqual({ kind: "stopped", pid, forced: false });
    // Confirmed against the OS, not inferred from the return value.
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 20_000);

  it("force-stops a process that ignores SIGTERM", async () => {
    if (process.platform === "win32") return;

    // Installs a SIGTERM handler that does nothing — the wedged-host shape.
    // It announces readiness on stdout first: signalling before the handler is
    // installed kills it on the default disposition, and the test would then
    // pass through the graceful path while claiming to exercise the forced one.
    const child = ChildProcess.spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');",
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    child.unref();
    const pid = child.pid;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child never reported ready")), 10_000);
      child.stdout?.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    writeRecord(pid!);

    const outcome = await stopDetachedHost({
      recordPath,
      currentPid: process.pid,
      gracefulTimeoutMs: 1_000,
      forceTimeoutMs: 5_000,
    });

    expect(outcome).toEqual({ kind: "stopped", pid, forced: true });
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 20_000);
});
