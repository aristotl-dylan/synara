// FILE: proxyHeaders.ts
// Purpose: The one place that decides which headers cross the environment proxy
//          in each direction, and how cookies are scoped per environment.
// Layer: Shared runtime (pure)
// Exports: HOP_BY_HOP_HEADERS, forwardableRequestHeaders,
//          forwardableResponseHeaders, scopeSetCookiePath, environmentCookiePath
//
// Two independent concerns, deliberately in one module so they cannot drift:
//
//  1. HOP-BY-HOP headers (RFC 9110 §7.6.1) describe THIS connection, not the
//     message. Forwarding them makes the upstream believe things about a
//     connection it does not have. They are stripped in both directions.
//
//  2. COOKIE SCOPING. Every environment is served from the SAME origin, so a
//     `Set-Cookie` from environment A without a path would be sent by the
//     browser to environment B — an authentication credential delivered to a
//     server that never issued it. Rewriting the path to `/env/<id>` makes the
//     browser's own scoping rules do the isolation.

import { ENV_PROXY_PATH_PREFIX } from "@synara/contracts";

/**
 * Headers whose meaning is bound to a single hop.
 *
 * `connection` and `upgrade` are here even though the WS path handles the
 * upgrade itself: the HTTP path must never relay them, or a plain request
 * could talk the upstream into switching protocols out from under the proxy.
 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers we never let the CLIENT set on a proxied request, because the proxy
 * itself is the authority on them.
 *
 * `host` is rewritten to the upstream. The `x-forwarded-*` family is dropped so
 * a client cannot forge its own provenance — the proxy sets them, or nobody
 * does. `authorization` is dropped and replaced with the environment's own
 * provisioned credential: a browser must never be able to choose which
 * credential the local server presents to a remote host.
 */
const CLIENT_CONTROLLED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "authorization",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

function isHopByHop(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}

/**
 * Additional per-message hop-by-hop names listed in the `Connection` header.
 * RFC 9110 lets a hop nominate its own; honouring that list is required, and
 * skipping it is how a `Connection: x-internal-trust` header survives a proxy.
 */
function connectionNominatedHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): ReadonlySet<string> {
  const raw = headers["connection"] ?? headers["Connection"];
  const value = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  const nominated = new Set<string>();
  for (const token of value.split(",")) {
    const name = token.trim().toLowerCase();
    if (name.length > 0) nominated.add(name);
  }
  return nominated;
}

/** Request headers to send upstream. Everything not excluded passes verbatim. */
export function forwardableRequestHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | string[]> {
  const nominated = connectionNominatedHeaders(headers);
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (isHopByHop(name) || nominated.has(name)) continue;
    if (CLIENT_CONTROLLED_REQUEST_HEADERS.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/** Response headers to return to the browser, with `Set-Cookie` re-scoped. */
export function forwardableResponseHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  environmentId: string,
): Record<string, string | string[]> {
  const nominated = connectionNominatedHeaders(headers);
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (isHopByHop(name) || nominated.has(name)) continue;
    if (name === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [value];
      out[name] = cookies.map((cookie) => scopeSetCookiePath(cookie, environmentId));
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** The URL path prefix an environment's cookies must be confined to. */
export function environmentCookiePath(environmentId: string): string {
  return `${ENV_PROXY_PATH_PREFIX}/${environmentId}`;
}

/**
 * Confines one `Set-Cookie` to its environment's path.
 *
 * Any existing `Path` attribute is REPLACED, not merged: the upstream sets
 * `Path=/` because it believes it owns the origin, and honouring that would
 * broadcast its session cookie to every other environment on this origin. The
 * upstream's path is not information we can preserve — it is the exact thing
 * that is wrong once the response is proxied.
 */
export function scopeSetCookiePath(setCookie: string, environmentId: string): string {
  const scopedPath = environmentCookiePath(environmentId);
  const parts = setCookie.split(";");
  const kept = parts.filter((part) => {
    const name = part.trim().split("=")[0]?.trim().toLowerCase() ?? "";
    // `Domain` is dropped too: a domain-scoped cookie ignores path scoping for
    // subdomains and would leak across environments the same way.
    return name !== "path" && name !== "domain";
  });
  return [...kept, ` Path=${scopedPath}`].join(";");
}
