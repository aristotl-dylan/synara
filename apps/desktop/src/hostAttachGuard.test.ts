import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { decideHostAdoption } from "@synara/shared/hostAdoption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveHostEndpoint } from "./hostAttach";
import { gatherHostAdoptionFacts } from "./hostRuntimeRecord";

// Exercises the collision rule against a real listening server rather than a
// stub: the point of attach-not-spawn is that a SECOND process reaches the same
// conclusion about a host the first one started, and only a real socket proves
// the health gate agrees with the record gate.

let stateDir: string;
let host: ChildProcess.ChildProcess | undefined;
let port: number;

beforeEach(() => {
  stateDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-attach-"));
});

afterEach(() => {
  host?.kill("SIGKILL");
  host = undefined;
  FS.rmSync(stateDir, { recursive: true, force: true });
});

/** A stand-in host: answers /health the way the real server does. */
async function startFakeHost(body: string, status = 200): Promise<number> {
  const script = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(${status}, { 'content-type': 'application/json' });
        res.end(${JSON.stringify(body)});
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port) + '\\n');
    });
  `;
  host = ChildProcess.spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake host never reported a port")), 10_000);
    host?.stdout?.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(Number(chunk.toString().trim()));
    });
  });
}

function writeRecord(overrides: Record<string, unknown> = {}): void {
  FS.writeFileSync(
    Path.join(stateDir, "server-runtime.json"),
    JSON.stringify({
      version: 1,
      pid: host?.pid ?? process.pid,
      port,
      origin: `http://127.0.0.1:${port}`,
      startedAt: new Date().toISOString(),
      ...overrides,
    }),
  );
}

describe("a second UI meeting a running host", () => {
  it("attaches to it instead of starting another server", async () => {
    port = await startFakeHost(JSON.stringify({ status: "ok", startupReady: true }));
    writeRecord();

    const outcome = await resolveHostEndpoint({
      facts: gatherHostAdoptionFacts({ stateDir, currentPid: process.pid }),
    });

    expect(outcome).toEqual({
      kind: "attached",
      endpoint: { origin: `http://127.0.0.1:${port}`, port },
      pid: host?.pid,
    });
  }, 20_000);

  it("starts its own when the host is listening but not started up", async () => {
    // A host wedged mid-startup answers the route but is not usable. Attaching
    // produces failures a user reads as Synara being broken.
    port = await startFakeHost(JSON.stringify({ status: "ok", startupReady: false }));
    writeRecord();

    const outcome = await resolveHostEndpoint({
      facts: gatherHostAdoptionFacts({ stateDir, currentPid: process.pid }),
    });

    expect(outcome).toEqual({
      kind: "start-host",
      reason: "the recorded host did not answer a health check",
    });
  }, 20_000);

  it("starts its own when the recorded port has nothing on it", async () => {
    // The pid is alive (this test process), so only the health probe can catch
    // a record whose port was never bound or was released.
    port = 1;
    FS.writeFileSync(
      Path.join(stateDir, "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 1,
        origin: "http://127.0.0.1:1",
        startedAt: new Date().toISOString(),
      }),
    );

    const outcome = await resolveHostEndpoint({
      facts: gatherHostAdoptionFacts({ stateDir, currentPid: 999_999 }),
    });

    expect(outcome.kind).toBe("start-host");
  }, 20_000);

  it("stops at the record gate when the host has been killed", async () => {
    port = await startFakeHost(JSON.stringify({ status: "ok", startupReady: true }));
    writeRecord();
    const killedPid = host?.pid;
    host?.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 300));
    host = undefined;

    const facts = gatherHostAdoptionFacts({ stateDir, currentPid: process.pid });
    expect(facts.record?.pid).toBe(killedPid);
    // SIGKILL skips the finalizer, so the record outlives the process — the
    // stale case, decided locally without spending a round trip.
    expect(decideHostAdoption(facts)).toEqual({ kind: "spawn", reason: "dead-process" });
  }, 20_000);
});
