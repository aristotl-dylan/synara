import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { decideHostAdoption } from "@synara/shared/hostAdoption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveHostEndpoint } from "./hostAttach";
import { gatherHostAdoptionFacts, hostRuntimeRecordPathFor } from "./hostRuntimeRecord";
import { mayInstallAfterStop, stopDetachedHost } from "./hostStop";

// The update sequence as a whole: a running host must be gone before a new
// server binary is installed, and the state left behind must let the next
// launch start a replacement rather than attach to a corpse.

let stateDir: string;
let host: ChildProcess.ChildProcess | undefined;

beforeEach(() => {
  stateDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-update-"));
});

afterEach(() => {
  if (host?.pid) {
    try {
      process.kill(host.pid, "SIGKILL");
    } catch {
      // Already stopped by the test.
    }
  }
  host = undefined;
  FS.rmSync(stateDir, { recursive: true, force: true });
});

/** A host that serves /health and writes its own runtime record, like the server. */
async function startHost(): Promise<{ pid: number; port: number }> {
  const recordPath = hostRuntimeRecordPathFor(stateDir);
  const script = `
    const http = require('node:http');
    const fs = require('node:fs');
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', startupReady: true }));
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
        version: 1, pid: process.pid, port,
        origin: 'http://127.0.0.1:' + port,
        startedAt: new Date().toISOString(),
      }));
      process.stdout.write(String(port) + '\\n');
    });
    // Clears its record on a clean stop, the way the server's finalizer does.
    process.on('SIGTERM', () => {
      try { fs.unlinkSync(${JSON.stringify(recordPath)}); } catch {}
      process.exit(0);
    });
  `;
  host = ChildProcess.spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  host.unref();
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("host never reported a port")), 10_000);
    host?.stdout?.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(Number(chunk.toString().trim()));
    });
  });
  return { pid: host.pid!, port };
}

describe("stopping the host before an update", () => {
  it("stops a live host and leaves nothing to attach to", async () => {
    if (process.platform === "win32") return;

    const { pid } = await startHost();

    // Before: a second UI would attach to it.
    const before = await resolveHostEndpoint({
      facts: gatherHostAdoptionFacts({ stateDir, currentPid: 999_999 }),
    });
    expect(before.kind).toBe("attached");

    const outcome = await stopDetachedHost({
      recordPath: hostRuntimeRecordPathFor(stateDir),
      currentPid: process.pid,
      gracefulTimeoutMs: 8_000,
    });
    // The fake host serves /health without an activeTurns field, so the drain
    // reads null (unknown) and does not block — the stop proceeds either way.
    expect(outcome).toMatchObject({ kind: "stopped", pid, forced: false });
    expect(mayInstallAfterStop(outcome)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();

    // After: the next launch starts its own rather than attaching. This is the
    // property the update depends on — installing a new binary while something
    // could still attach to the old server is the failure being prevented.
    const after = await resolveHostEndpoint({
      facts: gatherHostAdoptionFacts({ stateDir, currentPid: 999_999 }),
    });
    expect(after.kind).toBe("start-host");
  }, 30_000);

  it("permits the install when no host is running", async () => {
    const outcome = await stopDetachedHost({
      recordPath: hostRuntimeRecordPathFor(stateDir),
      currentPid: process.pid,
    });
    expect(outcome).toEqual({ kind: "not-running" });
    expect(mayInstallAfterStop(outcome)).toBe(true);
  });

  it("refuses the install when the host cannot be stopped", async () => {
    FS.writeFileSync(
      hostRuntimeRecordPathFor(stateDir),
      JSON.stringify({
        version: 1,
        pid: 4242,
        port: 21987,
        origin: "http://127.0.0.1:21987",
        startedAt: new Date().toISOString(),
      }),
    );
    const outcome = await stopDetachedHost({
      recordPath: hostRuntimeRecordPathFor(stateDir),
      currentPid: process.pid,
      kill: () => undefined,
      isAlive: () => true,
      sleep: async () => undefined,
      gracefulTimeoutMs: 200,
      forceTimeoutMs: 200,
    });
    // A new server started over a host we could not stop puts two writers on one
    // home. Refusing to update is the recoverable outcome; corrupting state is not.
    expect(mayInstallAfterStop(outcome)).toBe(false);
  });

  it("leaves a stale record when the host is killed rather than stopped", async () => {
    if (process.platform === "win32") return;

    const { pid } = await startHost();
    // SIGKILL skips the SIGTERM handler, so the record survives — the crash
    // shape, distinct from the orderly stop above.
    process.kill(pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 400));

    const facts = gatherHostAdoptionFacts({ stateDir, currentPid: 999_999 });
    expect(facts.record).toBeDefined();
    expect(decideHostAdoption(facts)).toEqual({ kind: "spawn", reason: "dead-process" });

    // And the stop path agrees there is nothing left to stop.
    await expect(
      stopDetachedHost({
        recordPath: hostRuntimeRecordPathFor(stateDir),
        currentPid: process.pid,
      }),
    ).resolves.toEqual({ kind: "not-running" });
  }, 30_000);
});
