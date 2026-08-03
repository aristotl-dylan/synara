import type { HostAdoptionFacts } from "@synara/shared/hostAdoption";
import { describe, expect, it, vi } from "vitest";

import { probeHostHealth, resolveHostEndpoint } from "./hostAttach";

function facts(overrides: Partial<HostAdoptionFacts> = {}): HostAdoptionFacts {
  return {
    record: {
      version: 1,
      pid: 4242,
      port: 21987,
      origin: "http://127.0.0.1:21987",
      startedAt: "2026-08-03T12:00:00.000Z",
    },
    processAlive: true,
    currentPid: 1,
    ...overrides,
  };
}

describe("probeHostHealth", () => {
  it("accepts a host reporting startupReady", async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ startupReady: true }));
    await expect(
      probeHostHealth({ origin: "http://127.0.0.1:21987", fetchImplementation }),
    ).resolves.toBe(true);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://127.0.0.1:21987/health",
      expect.anything(),
    );
  });

  it("rejects a host that is listening but not started up", async () => {
    // The route answers while subsystems are still coming up. Attaching here
    // produces failures a user reads as Synara being broken.
    const fetchImplementation = vi.fn(async () => Response.json({ startupReady: false }));
    await expect(
      probeHostHealth({ origin: "http://127.0.0.1:21987", fetchImplementation }),
    ).resolves.toBe(false);
  });

  it("rejects a non-200 response even when the body looks healthy", async () => {
    // The body is deliberately valid and startupReady: a proxy or error page can
    // return well-formed JSON, so the status check has to stand on its own
    // rather than being covered incidentally by a parse failure.
    const fetchImplementation = vi.fn(
      async () => new Response(JSON.stringify({ startupReady: true }), { status: 503 }),
    );
    await expect(
      probeHostHealth({ origin: "http://127.0.0.1:21987", fetchImplementation }),
    ).resolves.toBe(false);
  });

  it("rejects a body that is not the health shape", async () => {
    // Something else took the port after a pid recycle.
    const fetchImplementation = vi.fn(async () => new Response("<html>hello</html>"));
    await expect(
      probeHostHealth({ origin: "http://127.0.0.1:21987", fetchImplementation }),
    ).resolves.toBe(false);
  });

  it("rejects rather than throwing when the connection fails", async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      probeHostHealth({ origin: "http://127.0.0.1:21987", fetchImplementation }),
    ).resolves.toBe(false);
  });

  it("gives up rather than hanging on a host that never answers", async () => {
    const fetchImplementation = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    await expect(
      probeHostHealth({ origin: "http://127.0.0.1:21987", timeoutMs: 25, fetchImplementation }),
    ).resolves.toBe(false);
  });
});

describe("resolveHostEndpoint", () => {
  it("attaches to a healthy recorded host", async () => {
    await expect(resolveHostEndpoint({ facts: facts(), probe: async () => true })).resolves.toEqual(
      {
        kind: "attached",
        endpoint: { origin: "http://127.0.0.1:21987", port: 21987 },
        pid: 4242,
      },
    );
  });

  it("starts a host when the record is stale", async () => {
    const probe = vi.fn(async () => true);
    const outcome = await resolveHostEndpoint({
      facts: facts({ processAlive: false }),
      probe,
    });
    expect(outcome.kind).toBe("start-host");
    // The cheap local gate must reject before any round trip is spent.
    expect(probe).not.toHaveBeenCalled();
  });

  it("starts a host when the record survives but nothing answers", async () => {
    // A host wedged on a bad migration leaves a record that looks adoptable.
    const outcome = await resolveHostEndpoint({ facts: facts(), probe: async () => false });
    expect(outcome).toEqual({
      kind: "start-host",
      reason: "the recorded host did not answer a health check",
    });
  });

  it("does not probe a host bound to a routable address", async () => {
    const probe = vi.fn(async () => true);
    const outcome = await resolveHostEndpoint({
      facts: facts({
        record: { ...facts().record!, origin: "http://192.168.1.50:21987" },
      }),
      probe,
    });
    expect(outcome.kind).toBe("start-host");
    expect(probe).not.toHaveBeenCalled();
  });

  it("explains why it is starting a host", async () => {
    const outcome = await resolveHostEndpoint({
      facts: facts({ record: undefined, processAlive: false }),
      probe: async () => true,
    });
    expect(outcome).toEqual({
      kind: "start-host",
      reason: "no running host was recorded",
    });
  });

  it("refuses an origin with no port rather than attaching to a default one", async () => {
    // Attaching here would send traffic to port 80, not to the host.
    const outcome = await resolveHostEndpoint({
      facts: facts({ record: { ...facts().record!, origin: "http://127.0.0.1" } }),
      probe: async () => true,
    });
    expect(outcome).toEqual({
      kind: "start-host",
      reason: "the recorded host origin has no usable port",
    });
  });
});
