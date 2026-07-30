// FILE: environmentRouting.test.ts
// Purpose: Proves a remote thread's mutations and uploads reach the REMOTE host,
//          never the local server, and that an unreachable host refuses loudly.
// Layer: Web transport routing tests

import { EnvironmentId, ORCHESTRATION_WS_METHODS, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");
const REMOTE_WS_URL = "wss://vps.example.com/ws?token=remote-token";
const REMOTE_THREAD_ID = ThreadId.makeUnsafe("thread-remote");
const LOCAL_THREAD_ID = ThreadId.makeUnsafe("thread-local");

/**
 * Orchestration methods the CONTRACT defines with a thread-scoped input.
 *
 * Restated here on purpose so the routing list is checked against an
 * independently-maintained statement of the same fact rather than against
 * itself: deriving both sides from one list would make the assertion vacuous.
 */
const THREAD_SCOPED_BY_CONTRACT = new Set([
  "dispatchCommand",
  "getThreadDetailSnapshot",
  "importThread",
  "getTurnDiff",
  "getFullThreadDiff",
  "subscribeThread",
  "unsubscribeThread",
]);

interface FakeClient {
  readonly environmentId: EnvironmentId;
  readonly wsUrl: string | null;
  readonly api: Record<string, unknown>;
}

const registeredClients = new Map<EnvironmentId, FakeClient>();
const localDispatch = vi.fn(async () => ({ sequence: 1 }));
const remoteDispatch = vi.fn(async () => ({ sequence: 1 }));
const localSubscribeThread = vi.fn(async () => undefined);
const remoteSubscribeThread = vi.fn(async () => undefined);
const localGetSnapshot = vi.fn(async () => ({ threads: [] }));

function makeApi(
  dispatch: typeof localDispatch,
  subscribeThread: typeof localSubscribeThread,
): Record<string, unknown> {
  return {
    orchestration: {
      dispatchCommand: dispatch,
      subscribeThread,
      unsubscribeThread: vi.fn(async () => undefined),
      getThreadDetailSnapshot: vi.fn(async () => ({})),
      importThread: vi.fn(async () => ({})),
      getTurnDiff: vi.fn(async () => ({})),
      getFullThreadDiff: vi.fn(async () => ({})),
      getSnapshot: localGetSnapshot,
      getShellSnapshot: vi.fn(async () => ({})),
      repairState: vi.fn(async () => ({})),
    },
  };
}

const localClient: FakeClient = {
  environmentId: LOCAL_ENVIRONMENT_ID,
  wsUrl: null,
  api: makeApi(localDispatch, localSubscribeThread),
};
const remoteClient: FakeClient = {
  environmentId: REMOTE_ENVIRONMENT_ID,
  wsUrl: REMOTE_WS_URL,
  api: makeApi(remoteDispatch, remoteSubscribeThread),
};

vi.mock("./wsEnvironmentRegistry", () => ({
  localWsEnvironmentClient: () => localClient,
  getWsEnvironmentClient: (environmentId: EnvironmentId) => registeredClients.get(environmentId),
}));

const storeState: { environmentIdByThreadId?: Record<string, string> } = {};
vi.mock("./store", () => ({
  useStore: { getState: () => storeState },
}));

import {
  createEnvironmentRoutedApi,
  THREAD_ROUTED_ORCHESTRATION_METHODS,
} from "./environmentRoutedApi";
import {
  claimThreadEnvironment,
  EnvironmentUnavailableError,
  resetThreadEnvironmentClaims,
  resolveThreadEnvironmentId,
  resolveThreadHttpUrl,
} from "./environmentRouting";

beforeEach(() => {
  registeredClients.clear();
  registeredClients.set(LOCAL_ENVIRONMENT_ID, localClient);
  storeState.environmentIdByThreadId = {};
  resetThreadEnvironmentClaims();
  vi.clearAllMocks();
});

afterEach(() => {
  resetThreadEnvironmentClaims();
});

describe("thread ownership resolution", () => {
  it("defaults to local for a thread no environment has claimed", () => {
    expect(resolveThreadEnvironmentId(LOCAL_THREAD_ID)).toBe(LOCAL_ENVIRONMENT_ID);
  });

  it("resolves the reporting environment for a thread a remote snapshot claimed", () => {
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };
    expect(resolveThreadEnvironmentId(REMOTE_THREAD_ID)).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("uses a composer claim for a thread no snapshot has reported yet", () => {
    // A brand-new remote thread exists nowhere until `thread.create` lands, so
    // without the claim the very first dispatch of the very first remote thread
    // would go to the local server.
    claimThreadEnvironment(REMOTE_THREAD_ID, REMOTE_ENVIRONMENT_ID);
    expect(resolveThreadEnvironmentId(REMOTE_THREAD_ID)).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("lets a server report override a stale claim", () => {
    claimThreadEnvironment(REMOTE_THREAD_ID, REMOTE_ENVIRONMENT_ID);
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: LOCAL_ENVIRONMENT_ID };
    expect(resolveThreadEnvironmentId(REMOTE_THREAD_ID)).toBe(LOCAL_ENVIRONMENT_ID);
  });
});

describe("environment-routed orchestration dispatch", () => {
  it("sends a remote thread's mutation to the remote host, not the local server", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: "command-1",
      threadId: REMOTE_THREAD_ID,
      createdAt: "2026-07-28T00:00:00.000Z",
    } as never);

    expect(remoteDispatch).toHaveBeenCalledTimes(1);
    expect(localDispatch).not.toHaveBeenCalled();
  });

  it("keeps a local thread's mutation on the local server", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: "command-1",
      threadId: LOCAL_THREAD_ID,
      createdAt: "2026-07-28T00:00:00.000Z",
    } as never);

    expect(localDispatch).toHaveBeenCalledTimes(1);
    expect(remoteDispatch).not.toHaveBeenCalled();
  });

  it("routes thread subscribe to the owning host", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };
    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.subscribeThread({ threadId: REMOTE_THREAD_ID } as never);
    expect(remoteSubscribeThread).toHaveBeenCalledTimes(1);
    expect(localSubscribeThread).not.toHaveBeenCalled();
  });

  it("refuses rather than silently falling back when the owning host is disconnected", async () => {
    // No remote client registered: the environment is known but not connected.
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };
    const api = createEnvironmentRoutedApi(localClient.api as never);

    await expect(
      api.orchestration.dispatchCommand({
        type: "thread.session.stop",
        commandId: "command-1",
        threadId: REMOTE_THREAD_ID,
        createdAt: "2026-07-28T00:00:00.000Z",
      } as never),
    ).rejects.toBeInstanceOf(EnvironmentUnavailableError);
    expect(localDispatch).not.toHaveBeenCalled();
  });

  it("leaves server-wide orchestration calls on the local server", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };
    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.getSnapshot();
    expect(localGetSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe("the routed-method list", () => {
  it("covers every orchestration method whose input names a thread", () => {
    // The list's CONTENTS are asserted against the schema, not just its
    // existence: a new thread-scoped method added to the contract without being
    // listed here would silently dispatch a remote thread's work to the local
    // server, which is exactly the failure this PR exists to close.
    const threadScoped = Object.entries(ORCHESTRATION_WS_METHODS)
      .filter(([name]) => THREAD_SCOPED_BY_CONTRACT.has(name))
      .map(([name]) => name);
    expect([...THREAD_ROUTED_ORCHESTRATION_METHODS].toSorted()).toEqual(threadScoped.toSorted());
  });

  it("leaves the server-wide methods unrouted", () => {
    for (const method of ["getSnapshot", "getShellSnapshot", "repairState", "replayEvents"]) {
      expect(THREAD_ROUTED_ORCHESTRATION_METHODS as readonly string[]).not.toContain(method);
    }
  });
});

describe("HTTP-backed route resolution", () => {
  it("resolves a remote thread's upload against the remote host's origin", () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };

    const url = new URL(resolveThreadHttpUrl(REMOTE_THREAD_ID, "/api/attachments/upload"));
    expect(url.origin).toBe("https://vps.example.com");
    expect(url.pathname).toBe("/api/attachments/upload");
    // The remote environment's own credential rides along; the local one's must not.
    expect(url.searchParams.get("token")).toBe("remote-token");
  });

  it("refuses to resolve an upload for a disconnected remote host", () => {
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };
    expect(() => resolveThreadHttpUrl(REMOTE_THREAD_ID, "/api/attachments/upload")).toThrow(
      EnvironmentUnavailableError,
    );
  });
});
