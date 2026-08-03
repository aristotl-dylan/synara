import { describe, expect, it } from "vitest";

import {
  decideHostAdoption,
  describeHostAdoptionRefusal,
  type HostAdoptionRefusal,
  type HostRuntimeRecord,
  isLoopbackOrigin,
  SUPPORTED_HOST_RECORD_VERSION,
} from "./hostAdoption";

function record(overrides: Partial<HostRuntimeRecord> = {}): HostRuntimeRecord {
  return {
    version: SUPPORTED_HOST_RECORD_VERSION,
    pid: 4242,
    port: 8765,
    origin: "http://127.0.0.1:8765",
    startedAt: "2026-08-03T12:00:00.000Z",
    ...overrides,
  };
}

describe("isLoopbackOrigin", () => {
  it.each([
    "http://127.0.0.1:8765",
    "http://127.0.0.2:8765",
    // 127.1 is not loopback in dotted-quad form; 127.0.0.1 written long-hand is.
    "http://127.255.255.254:1",
    "https://127.0.0.1:443",
    "http://[::1]:8765",
  ])("accepts %s", (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(true);
  });

  it.each([
    // The case that matters: a host bound to a routable address. Adopting this
    // would attach the UI to another machine's server.
    "http://192.168.1.50:8765",
    "http://10.0.0.4:8765",
    "http://0.0.0.0:8765",
    // Hostnames resolve through /etc/hosts and DNS, neither of which we control.
    "http://localhost:8765",
    "http://example.com:8765",
    // Not http(s) at all.
    "file:///tmp/x",
    "ws://127.0.0.1:8765",
    // Unparseable.
    "not a url",
    "",
    // Looks loopback, is not: 127 must be the FIRST octet.
    "http://10.127.0.1:8765",
    "http://1.2.3.127:8765",
    // Four dot-separated parts that are not a dotted quad. URL accepts this as
    // a hostname, so the digit test is what rejects it.
    "http://127.a.b.c:8765",
  ])("rejects %s", (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(false);
  });
});

describe("decideHostAdoption", () => {
  it("adopts a live loopback host", () => {
    expect(decideHostAdoption({ record: record(), processAlive: true, currentPid: 1 })).toEqual({
      kind: "adopt",
      origin: "http://127.0.0.1:8765",
      pid: 4242,
    });
  });

  it("spawns when no record exists", () => {
    expect(decideHostAdoption({ record: undefined, processAlive: false, currentPid: 1 })).toEqual({
      kind: "spawn",
      reason: "no-record",
    });
  });

  it("spawns when the recorded process is gone", () => {
    // The common real case: SIGKILL or a power cut skipped the finalizer, so a
    // record survives pointing at a pid that no longer exists.
    expect(decideHostAdoption({ record: record(), processAlive: false, currentPid: 1 })).toEqual({
      kind: "spawn",
      reason: "dead-process",
    });
  });

  it("refuses a record written by a newer build", () => {
    expect(
      decideHostAdoption({
        record: record({ version: SUPPORTED_HOST_RECORD_VERSION + 1 }),
        processAlive: true,
        currentPid: 1,
      }),
    ).toEqual({ kind: "spawn", reason: "unsupported-version" });
  });

  it("never adopts itself", () => {
    // Own pid is trivially alive, so without this check a process attaches to
    // the server it is hosting.
    expect(
      decideHostAdoption({ record: record({ pid: 99 }), processAlive: true, currentPid: 99 }),
    ).toEqual({ kind: "spawn", reason: "self" });
  });

  it("refuses a live host bound to a routable address", () => {
    expect(
      decideHostAdoption({
        record: record({ origin: "http://192.168.1.50:8765" }),
        processAlive: true,
        currentPid: 1,
      }),
    ).toEqual({ kind: "spawn", reason: "non-loopback-origin" });
  });

  it("refuses an unparseable origin rather than adopting", () => {
    expect(
      decideHostAdoption({
        record: record({ origin: "http://[unclosed" }),
        processAlive: true,
        currentPid: 1,
      }),
    ).toEqual({ kind: "spawn", reason: "non-loopback-origin" });
  });

  // Ordering is load-bearing, not incidental: each of these records fails more
  // than one check, and the reported reason is what the user acts on.
  it("reports self before liveness", () => {
    expect(
      decideHostAdoption({ record: record({ pid: 7 }), processAlive: false, currentPid: 7 }),
    ).toEqual({ kind: "spawn", reason: "self" });
  });

  it("reports a dead process before a bad origin", () => {
    // A stale record naming a routable address is a stale record, not a network
    // problem — sending the user after the origin would waste their time.
    expect(
      decideHostAdoption({
        record: record({ origin: "http://192.168.1.50:8765" }),
        processAlive: false,
        currentPid: 1,
      }),
    ).toEqual({ kind: "spawn", reason: "dead-process" });
  });

  it("reports an unsupported version before anything else", () => {
    expect(
      decideHostAdoption({
        record: record({ version: 99, pid: 7, origin: "http://192.168.1.50:8765" }),
        processAlive: false,
        currentPid: 7,
      }),
    ).toEqual({ kind: "spawn", reason: "unsupported-version" });
  });
});

describe("describeHostAdoptionRefusal", () => {
  it("describes every refusal", () => {
    const reasons: readonly HostAdoptionRefusal[] = [
      "no-record",
      "unsupported-version",
      "dead-process",
      "self",
      "non-loopback-origin",
      "malformed-origin",
    ];
    for (const reason of reasons) {
      expect(describeHostAdoptionRefusal(reason).length).toBeGreaterThan(0);
    }
  });
});
