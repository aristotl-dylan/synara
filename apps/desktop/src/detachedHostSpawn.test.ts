import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeHostLogDescriptors,
  detachedHostSpawnOptions,
  detachedHostStdio,
  openHostLogDescriptors,
} from "./detachedHostSpawn";

let workspace: string;

beforeEach(() => {
  workspace = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-detached-"));
});

afterEach(() => {
  FS.rmSync(workspace, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("detachedHostStdio", () => {
  it("ignores stdin and routes both streams to descriptors", () => {
    // stdin must not be inherited: the server would hold a terminal the user can
    // close, and a detached process reading a closed terminal stalls invisibly.
    expect(detachedHostStdio(7, 8)).toEqual(["ignore", 7, 8]);
  });
});

describe("detachedHostSpawnOptions", () => {
  it("sets detached and hides the console window", () => {
    const options = detachedHostSpawnOptions({
      cwd: "/tmp",
      env: { A: "1" },
      stdoutFd: 3,
      stderrFd: 4,
    });
    // detached is what severs the process group, so a signal to the UI's group
    // is not delivered to the host as well.
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);
    expect(options.stdio).toEqual(["ignore", 3, 4]);
    expect(options.cwd).toBe("/tmp");
    expect(options.env).toEqual({ A: "1" });
  });

  it("never uses a pipe for stdout or stderr", () => {
    // A pipe's read end dies with the parent, so the first log line after the UI
    // quits raises EPIPE and kills the host.
    const options = detachedHostSpawnOptions({
      cwd: "/tmp",
      env: {},
      stdoutFd: 3,
      stderrFd: 4,
    });
    expect(options.stdio).not.toContain("pipe");
    expect(options.stdio).not.toContain("inherit");
  });
});

describe("openHostLogDescriptors", () => {
  it("creates the directory and opens two usable descriptors", () => {
    const logDir = Path.join(workspace, "logs");
    const descriptors = openHostLogDescriptors(logDir, "host.log");
    try {
      expect(FS.existsSync(descriptors.path)).toBe(true);
      expect(descriptors.stdoutFd).not.toBe(descriptors.stderrFd);
      FS.writeSync(descriptors.stdoutFd, "out\n");
      FS.writeSync(descriptors.stderrFd, "err\n");
    } finally {
      closeHostLogDescriptors(descriptors);
    }
    // One file, both streams: interleaving preserves the ordering between a
    // message and the error it caused.
    expect(FS.readFileSync(descriptors.path, "utf8")).toContain("out");
    expect(FS.readFileSync(descriptors.path, "utf8")).toContain("err");
  });

  it("appends rather than truncating on a restart", () => {
    const logDir = Path.join(workspace, "logs");
    const first = openHostLogDescriptors(logDir, "host.log");
    FS.writeSync(first.stdoutFd, "first host\n");
    closeHostLogDescriptors(first);

    const second = openHostLogDescriptors(logDir, "host.log");
    FS.writeSync(second.stdoutFd, "second host\n");
    closeHostLogDescriptors(second);

    // Why the previous host died is the most useful thing in the file at exactly
    // the moment someone opens it. Truncating would delete it.
    const contents = FS.readFileSync(second.path, "utf8");
    expect(contents).toContain("first host");
    expect(contents).toContain("second host");
  });

  it("creates the log private to this user", () => {
    if (process.platform === "win32") return;
    const descriptors = openHostLogDescriptors(Path.join(workspace, "logs"), "host.log");
    closeHostLogDescriptors(descriptors);
    // The log outlives the UI and carries session paths, so it must not be
    // readable by other accounts on a shared machine.
    expect(FS.statSync(descriptors.path).mode & 0o077).toBe(0);
  });
});

describe("closeHostLogDescriptors", () => {
  it("is safe to call twice", () => {
    const descriptors = openHostLogDescriptors(Path.join(workspace, "logs"), "host.log");
    closeHostLogDescriptors(descriptors);
    // A descriptor that cannot be closed is already gone; throwing here would
    // fail a spawn that actually succeeded.
    expect(() => closeHostLogDescriptors(descriptors)).not.toThrow();
  });

  it("releases the parent's copies", () => {
    const descriptors = openHostLogDescriptors(Path.join(workspace, "logs"), "host.log");
    closeHostLogDescriptors(descriptors);
    // Holding them keeps the file open for the UI's whole life, which blocks
    // log rotation on Windows.
    expect(() => FS.writeSync(descriptors.stdoutFd, "x")).toThrow();
  });
});

describe("a detached host outliving its parent", () => {
  it("keeps running and keeps logging after the spawning process exits", async () => {
    if (process.platform === "win32") return;

    const logDir = Path.join(workspace, "logs");
    const marker = Path.join(workspace, "still-alive.txt");
    const logPath = Path.join(logDir, "host.log");

    // A stand-in for the server: logs, waits past its parent's death, then
    // proves it is still running by writing a file.
    const script = [
      "process.stdout.write('host started\\n');",
      "setTimeout(() => {",
      "  process.stdout.write('host still here\\n');",
      `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive');`,
      "}, 700);",
    ].join("");

    // The parent spawns the host detached, then exits immediately — exactly the
    // shape of a UI quitting while the host keeps serving. It opens its OWN
    // descriptors: fd numbers are per-process, so numbers from this test would
    // mean nothing (or something else) over there.
    // The stdio shape here is asserted against the real builder in the
    // detachedHostSpawnOptions tests above; what this script adds is a parent
    // that genuinely exits while the host keeps writing.
    const parentScript = [
      "const CP = require('node:child_process');",
      "const FS = require('node:fs');",
      `FS.mkdirSync(${JSON.stringify(logDir)}, { recursive: true });`,
      `const out = FS.openSync(${JSON.stringify(logPath)}, 'a', 0o600);`,
      `const err = FS.openSync(${JSON.stringify(logPath)}, 'a', 0o600);`,
      `const child = CP.spawn(process.execPath, ['-e', ${JSON.stringify(script)}], {`,
      "  detached: true, stdio: ['ignore', out, err],",
      "});",
      "child.unref();",
      `FS.writeFileSync(${JSON.stringify(Path.join(workspace, "host.pid"))}, String(child.pid));`,
    ].join("\n");

    const spawned = ChildProcess.spawnSync(process.execPath, ["-e", parentScript], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    expect(spawned.stderr).toBe("");
    expect(spawned.status).toBe(0);
    const hostPid = Number(FS.readFileSync(Path.join(workspace, "host.pid"), "utf8").trim());
    expect(Number.isInteger(hostPid)).toBe(true);

    // The parent is gone by construction — spawnSync returned.
    await sleep(1400);

    // The host wrote AFTER its parent exited. If the pipes had been inherited
    // this write would have raised EPIPE and killed it.
    expect(FS.existsSync(marker)).toBe(true);
    const log = FS.readFileSync(logPath, "utf8");
    expect(log).toContain("host started");
    expect(log).toContain("host still here");

    try {
      process.kill(hostPid, "SIGKILL");
    } catch {
      // Already exited after writing its marker.
    }
  }, 20_000);

  it("survives a signal sent to the spawning process group", async () => {
    if (process.platform === "win32") return;

    const logDir = Path.join(workspace, "logs");
    const marker = Path.join(workspace, "survived-group-signal.txt");
    const logPath = Path.join(logDir, "host.log");
    const pidFile = Path.join(workspace, "group-host.pid");

    const script = [
      "setTimeout(() => {",
      `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive');`,
      "}, 800);",
    ].join("");

    // The parent leads its own session (spawned detached below), spawns the host
    // detached, then signals its OWN process group. Without detached on the host
    // it shares that group and dies here; with it, it has a group of its own.
    const parentScript = [
      "const CP = require('node:child_process');",
      "const FS = require('node:fs');",
      `FS.mkdirSync(${JSON.stringify(logDir)}, { recursive: true });`,
      `const out = FS.openSync(${JSON.stringify(logPath)}, 'a', 0o600);`,
      `const err = FS.openSync(${JSON.stringify(logPath)}, 'a', 0o600);`,
      `const child = CP.spawn(process.execPath, ['-e', ${JSON.stringify(script)}], {`,
      "  detached: true, stdio: ['ignore', out, err],",
      "});",
      "child.unref();",
      `FS.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "process.kill(-process.pid, 'SIGTERM');",
    ].join("\n");

    const parent = ChildProcess.spawn(process.execPath, ["-e", parentScript], {
      stdio: "ignore",
      // New session, so the parent's group signal cannot reach the test runner.
      detached: true,
    });
    parent.unref();

    await sleep(1500);

    expect(FS.existsSync(marker)).toBe(true);

    if (FS.existsSync(pidFile)) {
      const hostPid = Number(FS.readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(hostPid)) {
        try {
          process.kill(hostPid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }
  }, 20_000);
});
