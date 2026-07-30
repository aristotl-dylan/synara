// FILE: environmentRouting.test.ts
// Purpose: Proves a remote thread's mutations and uploads reach the REMOTE host,
//          never the local server, and that an unreachable host refuses loudly.
// Layer: Web transport routing tests

import { EnvironmentId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");
const REMOTE_WS_URL = "wss://vps.example.com/ws?token=remote-token";
const REMOTE_THREAD_ID = ThreadId.makeUnsafe("thread-remote");
const LOCAL_THREAD_ID = ThreadId.makeUnsafe("thread-local");

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

/**
 * A fake NativeApi covering every group the router touches.
 *
 * Built from `ROUTED_METHODS` so that a method added to the routing table is
 * automatically present on both fakes; a test for it then compares two real
 * spies rather than silently exercising `undefined`.
 */
function makeApi(
  dispatch: typeof localDispatch,
  subscribeThread: typeof localSubscribeThread,
): Record<string, unknown> {
  const api: Record<string, Record<string, unknown>> = {};
  for (const [group, methods] of Object.entries(ROUTED_METHODS)) {
    const groupApi: Record<string, unknown> = {};
    for (const method of methods as readonly string[]) {
      groupApi[method] = vi.fn(async () => ({}));
    }
    api[group] = groupApi;
  }
  api.orchestration = {
    ...api.orchestration,
    dispatchCommand: dispatch,
    subscribeThread,
    getSnapshot: localGetSnapshot,
    getShellSnapshot: vi.fn(async () => ({})),
    repairState: vi.fn(async () => ({})),
  };
  return api;
}

/** The spy a fake API installed for `group.method`. */
function spyFor(client: FakeClient, group: string, method: string) {
  return (client.api[group] as Record<string, ReturnType<typeof vi.fn>>)[method];
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

const storeState: {
  environmentIdByThreadId?: Record<string, string>;
  environmentIdByProjectId?: Record<string, string>;
} = {};
vi.mock("./store", () => ({
  useStore: { getState: () => storeState },
}));

import {
  createEnvironmentRoutedApi,
  LOCAL_ONLY_THREAD_METHODS,
  ROUTED_METHODS,
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
  storeState.environmentIdByProjectId = {};
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

describe("every routed method reaches the owning host", () => {
  /**
   * Drives EVERY entry in the routing table, not a hand-picked few.
   *
   * Exhaustiveness of the table itself is enforced against the contract at
   * type-check time (`environmentRoutingCoverage.test-d.ts`). This proves the
   * table is also OBEYED: a method listed but wired wrong — the group spread
   * dropping it, say — fails here rather than shipping.
   */
  for (const [group, methods] of Object.entries(ROUTED_METHODS)) {
    for (const method of methods as readonly string[]) {
      it(`routes ${group}.${method} to the remote host`, async () => {
        registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
        storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };

        const api = createEnvironmentRoutedApi(localClient.api as never);
        const routedGroup = (api as unknown as Record<string, Record<string, unknown>>)[group];
        const callable = routedGroup?.[method] as (input: unknown) => Promise<unknown>;
        await callable({ threadId: REMOTE_THREAD_ID });

        expect(spyFor(remoteClient, group, method)).toHaveBeenCalledTimes(1);
        expect(spyFor(localClient, group, method)).not.toHaveBeenCalled();
      });
    }
  }
});

describe("thread-scoped methods outside orchestration", () => {
  it("writes a remote thread's terminal input to the remote host, not the laptop", async () => {
    // Unrouted, a user who opens a terminal in a remote thread and types a
    // deploy command runs it on their own machine.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.terminal.write({ threadId: REMOTE_THREAD_ID, data: "deploy\n" } as never);

    expect(spyFor(remoteClient, "terminal", "write")).toHaveBeenCalledTimes(1);
    expect(spyFor(localClient, "terminal", "write")).not.toHaveBeenCalled();
  });

  it("runs a remote thread's git handoff against the remote checkout", async () => {
    // GitHandoffThreadInput carries both threadId and cwd, and a cwd that
    // exists on both machines makes a misroute a silent success on the wrong
    // working tree rather than an error.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.git.handoffThread({
      threadId: REMOTE_THREAD_ID,
      cwd: "/Users/dylan/dev/foo",
    } as never);

    expect(spyFor(remoteClient, "git", "handoffThread")).toHaveBeenCalledTimes(1);
    expect(spyFor(localClient, "git", "handoffThread")).not.toHaveBeenCalled();
  });

  it("keeps a local thread's terminal input on the local server", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.terminal.write({ threadId: LOCAL_THREAD_ID, data: "ls\n" } as never);

    expect(spyFor(localClient, "terminal", "write")).toHaveBeenCalledTimes(1);
    expect(spyFor(remoteClient, "terminal", "write")).not.toHaveBeenCalled();
  });

  it("refuses a terminal write when the owning host is disconnected", async () => {
    storeState.environmentIdByThreadId = { [REMOTE_THREAD_ID]: REMOTE_ENVIRONMENT_ID };
    const api = createEnvironmentRoutedApi(localClient.api as never);

    await expect(
      api.terminal.write({ threadId: REMOTE_THREAD_ID, data: "deploy\n" } as never),
    ).rejects.toBeInstanceOf(EnvironmentUnavailableError);
    expect(spyFor(localClient, "terminal", "write")).not.toHaveBeenCalled();
  });
});

describe("project-scoped commands", () => {
  it("applies a remote project's mutation on the remote host", async () => {
    // `project.meta.update` carries only projectId. Falling back to local here
    // renames the LOCAL server's copy while the UI badge says the remote host.
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    storeState.environmentIdByProjectId = { "project-remote": REMOTE_ENVIRONMENT_ID };

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: "command-1",
      projectId: "project-remote",
      isPinned: true,
    } as never);

    expect(remoteDispatch).toHaveBeenCalledTimes(1);
    expect(localDispatch).not.toHaveBeenCalled();
  });

  it("routes a space assignment by the projects it moves", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    storeState.environmentIdByProjectId = { "project-remote": REMOTE_ENVIRONMENT_ID };

    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "space.projects.assign",
      commandId: "command-1",
      spaceId: "space-1",
      projectIds: ["project-remote"],
    } as never);

    expect(remoteDispatch).toHaveBeenCalledTimes(1);
    expect(localDispatch).not.toHaveBeenCalled();
  });

  it("keeps a local project's mutation on the local server", async () => {
    registeredClients.set(REMOTE_ENVIRONMENT_ID, remoteClient);
    const api = createEnvironmentRoutedApi(localClient.api as never);
    await api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: "command-1",
      projectId: "project-local",
      isPinned: true,
    } as never);

    expect(localDispatch).toHaveBeenCalledTimes(1);
    expect(remoteDispatch).not.toHaveBeenCalled();
  });
});

describe("the routing decision tables", () => {
  it("leaves the server-wide orchestration methods unrouted", () => {
    for (const method of ["getSnapshot", "getShellSnapshot", "repairState", "replayEvents"]) {
      expect(ROUTED_METHODS.orchestration as readonly string[]).not.toContain(method);
    }
  });

  it("keeps the embedded browser on the user's own machine", () => {
    // The webview is a panel in the user's window, not a resource on the
    // thread's host; a headless VPS has no display to drive.
    expect(Object.keys(ROUTED_METHODS)).not.toContain("browser");
    expect(LOCAL_ONLY_THREAD_METHODS.browser).toContain("navigate");
  });

  it("documents that cwd-keyed calls are NOT routed", () => {
    // Pins the known gap so it stays a STATED limitation rather than a silent
    // one. `git.checkout` and friends identify their target by a bare path,
    // which carries no host identity, so they still run locally even for a
    // remote thread — and because the same path plausibly exists on both
    // machines, the failure is a silent success against the wrong checkout.
    //
    // When cwd routing lands, this expectation flips rather than being
    // deleted: that is the point at which the picker may claim full coverage.
    for (const method of ["checkout", "status", "createWorktree", "stageFiles", "pull"]) {
      expect(ROUTED_METHODS.git as readonly string[]).not.toContain(method);
    }
    // The one cwd-family method fixable today, because it also carries threadId.
    expect(ROUTED_METHODS.git as readonly string[]).toContain("handoffThread");
    expect(Object.keys(ROUTED_METHODS)).not.toContain("projects");
    expect(Object.keys(ROUTED_METHODS)).not.toContain("filesystem");
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
