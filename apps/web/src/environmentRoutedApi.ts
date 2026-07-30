// FILE: environmentRoutedApi.ts
// Purpose: One choke point that sends every thread-scoped orchestration call to
//          the environment that owns the thread.
// Layer: Web transport routing
// Exports: createEnvironmentRoutedApi, THREAD_ROUTED_ORCHESTRATION_METHODS

import type { NativeApi, ThreadId } from "@synara/contracts";

import { environmentNativeApi, EnvironmentUnavailableError } from "./environmentRouting";
import { resolveThreadEnvironmentId } from "./environmentRouting";

type Orchestration = NativeApi["orchestration"];

/**
 * The orchestration methods whose first argument names a thread, and which are
 * therefore routed to that thread's own server.
 *
 * This is a routing decision, not a wire change: `environmentId` never enters
 * the orchestration command schema. It only decides which per-environment
 * NativeApi receives the dispatch.
 *
 * Every other orchestration method is server-wide (`getSnapshot`,
 * `getShellSnapshot`, `repairState`, `replayEvents`, the shell subscriptions).
 * Those are already aggregated per environment by the registry, so routing them
 * by thread would be meaningless.
 */
export const THREAD_ROUTED_ORCHESTRATION_METHODS = [
  "dispatchCommand",
  "getThreadDetailSnapshot",
  "importThread",
  "getTurnDiff",
  "getFullThreadDiff",
  "subscribeThread",
  "unsubscribeThread",
] as const satisfies ReadonlyArray<keyof Orchestration>;

type ThreadRoutedMethod = (typeof THREAD_ROUTED_ORCHESTRATION_METHODS)[number];

/** Every routed method takes a single object argument carrying `threadId`. */
function readThreadId(argument: unknown): ThreadId | null {
  if (typeof argument !== "object" || argument === null) return null;
  const candidate = (argument as { readonly threadId?: unknown }).threadId;
  return typeof candidate === "string" ? (candidate as ThreadId) : null;
}

/**
 * Wraps `localApi` so a thread-scoped orchestration call is dispatched against
 * the server that owns the thread.
 *
 * The wrapper is applied to the LOCAL client, which is what every existing
 * caller already holds. That is deliberate: routing that must be opted into at
 * each of hundreds of call sites is routing that will be forgotten at one of
 * them, and the failure mode — a remote thread's turn running on the user's
 * laptop — is silent. Here a caller cannot bypass it without reaching into the
 * registry directly.
 *
 * A thread whose owning environment is not connected produces an explicit
 * `EnvironmentUnavailableError`; it never falls back to local.
 */
export function createEnvironmentRoutedApi(localApi: NativeApi): NativeApi {
  const routedOrchestration = { ...localApi.orchestration } as Record<string, unknown>;

  for (const method of THREAD_ROUTED_ORCHESTRATION_METHODS) {
    const localImplementation = localApi.orchestration[method] as (
      ...args: readonly unknown[]
    ) => unknown;
    routedOrchestration[method] = (...args: readonly unknown[]) => {
      const threadId = readThreadId(args[0]);
      if (threadId === null) return localImplementation(...args);
      const environmentId = resolveThreadEnvironmentId(threadId);
      const owner = environmentNativeApi(environmentId);
      if (!owner) return Promise.reject(new EnvironmentUnavailableError(environmentId));
      const ownerImplementation = owner.orchestration[method as ThreadRoutedMethod] as (
        ...ownerArgs: readonly unknown[]
      ) => unknown;
      return ownerImplementation(...args);
    };
  }

  return {
    ...localApi,
    orchestration: routedOrchestration as unknown as Orchestration,
  };
}
