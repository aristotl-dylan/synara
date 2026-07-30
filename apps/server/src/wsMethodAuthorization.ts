// FILE: wsMethodAuthorization.ts
// Purpose: Declarative authorization table for WebSocket RPC methods, enforced
//          centrally by the admission middleware instead of per handler.
// Layer: Server transport security
// Exports: OWNER_ONLY_WS_METHODS, LOCAL_ONLY_WS_METHODS, authorizeWsMethod

import { WS_METHODS, WsRpcError } from "@synara/contracts";

import { isLocalOnlyDeployment, type RemoteAccessDeployment } from "./remoteAccessPolicy";
import type { WsSessionRole } from "./wsConnectionSessions";

/**
 * Methods that administer the machine the server runs on rather than the work
 * happening inside a thread. A paired non-owner client may run turns and read
 * state, but may not reconfigure the host.
 *
 * Enforcement lives in the admission middleware, so a new handler is covered by
 * adding its method here — it can never silently ship without a check the way
 * an opt-in per-handler guard could.
 */
export const OWNER_ONLY_WS_METHODS: ReadonlySet<string> = new Set<string>([
  WS_METHODS.serverListExternalMcpIntegrations,
  WS_METHODS.serverCreateExternalMcpIntegration,
  WS_METHODS.serverRevokeExternalMcpIntegration,
  WS_METHODS.serverRefreshExternalMcpPairing,
  WS_METHODS.serverUpdateSettings,
  WS_METHODS.serverUpdateProvider,
  WS_METHODS.serverUpsertKeybinding,
  WS_METHODS.serverStopLocalServer,
]);

/**
 * Methods whose blast radius is the operator's own machine and which therefore
 * stay unavailable on any remote-reachable deployment, regardless of role.
 */
export const LOCAL_ONLY_WS_METHODS: ReadonlySet<string> = new Set<string>([
  WS_METHODS.serverListExternalMcpIntegrations,
  WS_METHODS.serverCreateExternalMcpIntegration,
  WS_METHODS.serverRevokeExternalMcpIntegration,
  WS_METHODS.serverRefreshExternalMcpPairing,
]);

/**
 * Returns the rejection for a method/role/deployment combination, or null when
 * the call is authorized. Ordering is deliberate: a remote client learns the
 * capability does not exist here before it learns anything about its own role.
 */
export function authorizeWsMethod(input: {
  readonly method: string;
  readonly role: WsSessionRole;
  readonly config: RemoteAccessDeployment;
}): WsRpcError | null {
  if (LOCAL_ONLY_WS_METHODS.has(input.method) && !isLocalOnlyDeployment(input.config)) {
    return new WsRpcError({
      message: "This operation is available only on a loopback-only Synara instance.",
    });
  }
  if (OWNER_ONLY_WS_METHODS.has(input.method) && input.role !== "owner") {
    return new WsRpcError({
      message: "Owner authorization is required for this operation.",
    });
  }
  return null;
}
