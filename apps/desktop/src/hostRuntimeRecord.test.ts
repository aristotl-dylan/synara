import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { decideHostAdoption } from "@synara/shared/hostAdoption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  gatherHostAdoptionFacts,
  hostRuntimeRecordPathFor,
  isProcessAlive,
  readHostRuntimeRecord,
} from "./hostRuntimeRecord";

let stateDir: string;

beforeEach(() => {
  stateDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-host-record-"));
});

afterEach(() => {
  FS.rmSync(stateDir, { recursive: true, force: true });
});

function writeRecord(value: unknown): string {
  const path = hostRuntimeRecordPathFor(stateDir);
  FS.writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

const validRecord = {
  version: 1,
  pid: 4242,
  port: 8765,
  origin: "http://127.0.0.1:8765",
  startedAt: "2026-08-03T12:00:00.000Z",
};

describe("readHostRuntimeRecord", () => {
  it("reads a well-formed record", () => {
    expect(readHostRuntimeRecord(writeRecord(validRecord))).toEqual(validRecord);
  });

  it("ignores extra fields a newer writer may add", () => {
    expect(readHostRuntimeRecord(writeRecord({ ...validRecord, externalMcpRuntimeSecret: "x" }))).toEqual(
      validRecord,
    );
  });

  it("returns undefined when the file is absent", () => {
    expect(readHostRuntimeRecord(Path.join(stateDir, "nothing.json"))).toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["truncated json", '{"version":1,"pid":'],
    ["not an object", "42"],
    ["null", "null"],
    ["array", "[]"],
  ])("returns undefined for %s", (_label, contents) => {
    expect(readHostRuntimeRecord(writeRecord(contents))).toBeUndefined();
  });

  it.each([
    ["missing pid", { ...validRecord, pid: undefined }],
    ["string pid", { ...validRecord, pid: "4242" }],
    ["zero pid", { ...validRecord, pid: 0 }],
    ["negative pid", { ...validRecord, pid: -1 }],
    ["fractional pid", { ...validRecord, pid: 42.5 }],
    ["missing origin", { ...validRecord, origin: undefined }],
    ["numeric origin", { ...validRecord, origin: 8765 }],
    ["missing version", { ...validRecord, version: undefined }],
    ["missing startedAt", { ...validRecord, startedAt: undefined }],
  ])("returns undefined for %s", (_label, value) => {
    expect(readHostRuntimeRecord(writeRecord(value))).toBeUndefined();
  });

  it("returns undefined for a directory at the record path", () => {
    FS.mkdirSync(hostRuntimeRecordPathFor(stateDir));
    expect(readHostRuntimeRecord(hostRuntimeRecordPathFor(stateDir))).toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  it("sees this process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("does not see an unused pid", () => {
    // Above the default pid_max on Linux and macOS, so it cannot be in use.
    expect(isProcessAlive(0x7fffffff)).toBe(false);
  });

  it("treats pid 1 as alive", () => {
    // Owned by root, so process.kill raises EPERM rather than succeeding. EPERM
    // means the process EXISTS — reporting it dead would let a second server
    // start over a host owned by another user.
    expect(isProcessAlive(1)).toBe(true);
  });
});

describe("gatherHostAdoptionFacts", () => {
  it("reports no record when the state directory is empty", () => {
    const facts = gatherHostAdoptionFacts({ stateDir });
    expect(facts.record).toBeUndefined();
    expect(facts.processAlive).toBe(false);
    expect(decideHostAdoption(facts)).toEqual({ kind: "spawn", reason: "no-record" });
  });

  it("reports a dead process for a stale record", () => {
    writeRecord({ ...validRecord, pid: 0x7fffffff });
    const facts = gatherHostAdoptionFacts({ stateDir });
    expect(facts.processAlive).toBe(false);
    expect(decideHostAdoption(facts)).toEqual({ kind: "spawn", reason: "dead-process" });
  });

  it("adopts a live loopback host owned by someone else", () => {
    // pid 1 is alive and is not us, which is exactly the adoptable shape.
    writeRecord({ ...validRecord, pid: 1 });
    const facts = gatherHostAdoptionFacts({ stateDir, currentPid: 99999 });
    expect(decideHostAdoption(facts)).toEqual({
      kind: "adopt",
      origin: "http://127.0.0.1:8765",
      pid: 1,
    });
  });

  it("refuses to adopt itself", () => {
    writeRecord({ ...validRecord, pid: process.pid });
    expect(decideHostAdoption(gatherHostAdoptionFacts({ stateDir }))).toEqual({
      kind: "spawn",
      reason: "self",
    });
  });

  it("refuses a live host bound to a routable address", () => {
    writeRecord({ ...validRecord, pid: 1, origin: "http://192.168.1.50:8765" });
    expect(
      decideHostAdoption(gatherHostAdoptionFacts({ stateDir, currentPid: 99999 })),
    ).toEqual({ kind: "spawn", reason: "non-loopback-origin" });
  });

  it("does not probe liveness when there is no record", () => {
    // Guards the short-circuit: without it, a missing record would ask about
    // pid undefined and throw rather than reporting "no-record".
    expect(() => gatherHostAdoptionFacts({ stateDir })).not.toThrow();
  });
});
