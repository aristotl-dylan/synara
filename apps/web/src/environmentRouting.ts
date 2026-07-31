// FILE: environmentRouting.ts
// Purpose: Resolve the environment that OWNS a thread, so every dispatch and
//          every HTTP-backed request reaches that thread's own server.
// Layer: Web transport routing
// Exports: ownership resolution, per-thread NativeApi/HTTP resolution, and the
//          explicit refusals that replace a silent local fallback.

import type { EnvironmentId, NativeApi, ThreadId } from "@synara/contracts";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { getWsEnvironmentClient, localWsEnvironmentClient } from "./wsEnvironmentRegistry";
import { resolveEnvironmentHttpUrl } from "./lib/wsHttpUrl";
import { useStore } from "./store";

/**
 * Threads a client has decided to create on a remote environment but which no
 * snapshot has reported yet.
 *
 * A brand-new thread exists nowhere until `thread.create` lands, so the store's
 * ownership map cannot answer for it — and defaulting to local is exactly the
 * bug this module exists to prevent. The composer claims the environment when
 * the user picks it, before the first dispatch.
 */
const claimedEnvironmentIdByThreadId = new Map<ThreadId, EnvironmentId>();

export function claimThreadEnvironment(threadId: ThreadId, environmentId: EnvironmentId): void {
  if (environmentId === LOCAL_ENVIRONMENT_ID) {
    claimedEnvironmentIdByThreadId.delete(threadId);
    return;
  }
  claimedEnvironmentIdByThreadId.set(threadId, environmentId);
}

export function releaseThreadEnvironmentClaim(threadId: ThreadId): void {
  claimedEnvironmentIdByThreadId.delete(threadId);
}

/** Test/reset seam; production never clears every claim at once. */
export function resetThreadEnvironmentClaims(): void {
  claimedEnvironmentIdByThreadId.clear();
}

export interface ThreadOwnershipSource {
  /** Server-reported ownership, keyed by thread id. Absent means local. */
  readonly environmentIdByThreadId?: Record<string, string> | undefined;
  /** Server-reported ownership, keyed by project id. Absent means local. */
  readonly environmentIdByProjectId?: Record<string, string> | undefined;
}

function readOwnershipSource(): ThreadOwnershipSource {
  return useStore.getState();
}

/**
 * The environment that owns `threadId`.
 *
 * Snapshot-reported ownership wins over a local claim: a snapshot is the only
 * authority on where a thread actually lives, and a stale claim must never
 * outrank it. Only when no server has reported the thread does the claim apply,
 * which is precisely the pre-create window.
 */
export function resolveThreadEnvironmentId(
  threadId: ThreadId,
  source: ThreadOwnershipSource = readOwnershipSource(),
): EnvironmentId {
  const reported = source.environmentIdByThreadId?.[threadId];
  if (reported) return reported as EnvironmentId;
  return claimedEnvironmentIdByThreadId.get(threadId) ?? LOCAL_ENVIRONMENT_ID;
}

/**
 * Ownership of `threadId` when some server or the composer has actually stated
 * it, and `null` when nobody has.
 *
 * `resolveThreadEnvironmentId` cannot express "nobody knows" — it answers LOCAL
 * for an unknown thread, which is the right default for a thread being read but
 * the wrong one for a thread being CREATED. `thread.create` carries a brand-new
 * `threadId` no snapshot has reported, so a caller that needs to fall back to
 * another key (the owning project) must be able to tell the two apart.
 */
export function findThreadEnvironmentId(
  threadId: ThreadId,
  source: ThreadOwnershipSource = readOwnershipSource(),
): EnvironmentId | null {
  const reported = source.environmentIdByThreadId?.[threadId];
  if (reported) return reported as EnvironmentId;
  return claimedEnvironmentIdByThreadId.get(threadId) ?? null;
}

/**
 * The environment that owns `projectId`.
 *
 * Project-scoped commands (`project.meta.update`, `project.delete`,
 * `space.projects.assign`) carry no thread, so thread ownership cannot answer
 * for them. Without this, pinning or deleting a project that lives on a remote
 * host mutates the LOCAL server's copy instead.
 */
export function resolveProjectEnvironmentId(
  projectId: string,
  source: ThreadOwnershipSource = readOwnershipSource(),
): EnvironmentId {
  const reported = source.environmentIdByProjectId?.[projectId];
  return reported ? (reported as EnvironmentId) : LOCAL_ENVIRONMENT_ID;
}

/**
 * Message shown when a thread's owning environment is not connected.
 *
 * Every caller surfaces this instead of falling back to the local server: a
 * silent fallback would run a remote thread's turn — or upload its attachment
 * bytes — on the wrong machine.
 */
export function unreachableEnvironmentMessage(environmentId: EnvironmentId): string {
  return `This chat runs on remote environment ${environmentId}, which is not connected right now. Reconnect that host from Settings → Remote hosts, then try again.`;
}

export class EnvironmentUnavailableError extends Error {
  readonly environmentId: EnvironmentId;

  constructor(environmentId: EnvironmentId) {
    super(unreachableEnvironmentMessage(environmentId));
    this.name = "EnvironmentUnavailableError";
    this.environmentId = environmentId;
  }
}

/**
 * The NativeApi for one environment, or `undefined` when that environment is
 * not connected. The local environment connects on demand; a remote one is
 * never auto-connected because only its registration knows its URL.
 */
export function environmentNativeApi(environmentId: EnvironmentId): NativeApi | undefined {
  if (environmentId === LOCAL_ENVIRONMENT_ID) return localWsEnvironmentClient().api;
  return getWsEnvironmentClient(environmentId)?.api;
}

/** The NativeApi that owns `threadId`, or `undefined` when it is not connected. */
export function threadNativeApi(threadId: ThreadId): NativeApi | undefined {
  return environmentNativeApi(resolveThreadEnvironmentId(threadId));
}

/** Like `threadNativeApi`, but refuses explicitly rather than returning nothing. */
export function ensureThreadNativeApi(threadId: ThreadId): NativeApi {
  const environmentId = resolveThreadEnvironmentId(threadId);
  const api = environmentNativeApi(environmentId);
  if (!api) throw new EnvironmentUnavailableError(environmentId);
  return api;
}

/**
 * HTTP URL for `rawPath` on the server that owns `threadId`.
 *
 * Throws for an unregistered remote environment rather than resolving through
 * the page's ambient WS URL — an ambient resolution here sends the request body
 * (attachment bytes, an export request) to the local server.
 */
export function resolveThreadHttpUrl(threadId: ThreadId, rawPath: string): string {
  const environmentId = resolveThreadEnvironmentId(threadId);
  if (environmentId === LOCAL_ENVIRONMENT_ID) return resolveEnvironmentHttpUrl(null, rawPath);
  const client = getWsEnvironmentClient(environmentId);
  if (!client) throw new EnvironmentUnavailableError(environmentId);
  return resolveEnvironmentHttpUrl(client.wsUrl, rawPath);
}
