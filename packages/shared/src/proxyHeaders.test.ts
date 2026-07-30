import { describe, expect, it } from "vitest";

import {
  environmentCookiePath,
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  HOP_BY_HOP_HEADERS,
  scopeSetCookiePath,
} from "./proxyHeaders";

describe("hop-by-hop stripping", () => {
  it("names every hop-by-hop header RFC 9110 defines", () => {
    // Asserting the CONTENTS, not just that a set exists: a header quietly
    // dropped from this list starts being forwarded, and the upstream then
    // believes something about a connection it does not have.
    expect([...HOP_BY_HOP_HEADERS].sort()).toEqual([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]);
  });

  it("strips them from requests and responses regardless of case", () => {
    const request = forwardableRequestHeaders({
      "Transfer-Encoding": "chunked",
      KEEP_ALIVE: "timeout=5",
      "keep-alive": "timeout=5",
      TE: "trailers",
      accept: "application/json",
    });
    expect(request["transfer-encoding"]).toBeUndefined();
    expect(request["keep-alive"]).toBeUndefined();
    expect(request["te"]).toBeUndefined();
    expect(request["accept"]).toBe("application/json");

    const response = forwardableResponseHeaders(
      { "Transfer-Encoding": "chunked", "content-type": "text/html" },
      "e1",
    );
    expect(response["transfer-encoding"]).toBeUndefined();
    expect(response["content-type"]).toBe("text/html");
  });

  it("honours headers the Connection header nominates as hop-by-hop", () => {
    // RFC 9110 lets a hop nominate its own. A proxy that ignored the list is
    // how `Connection: x-internal-trust` survives a hop it was meant to die at.
    const forwarded = forwardableRequestHeaders({
      connection: "keep-alive, X-Internal-Trust",
      "x-internal-trust": "yes",
      "x-normal": "kept",
    });
    expect(forwarded["x-internal-trust"]).toBeUndefined();
    expect(forwarded["x-normal"]).toBe("kept");
  });

  it("refuses to forward a client-supplied Authorization or forwarded-for header", () => {
    // The proxy replaces Authorization with the environment's own provisioned
    // credential. If the client's survived, a browser could choose which
    // credential the local server presents to a remote host.
    const forwarded = forwardableRequestHeaders({
      authorization: "Bearer attacker-chosen",
      "x-forwarded-for": "10.0.0.1",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      "x-real-ip": "10.0.0.1",
      host: "evil.example",
      cookie: "synara_session=abc",
    });
    expect(forwarded["authorization"]).toBeUndefined();
    expect(forwarded["x-forwarded-for"]).toBeUndefined();
    expect(forwarded["x-forwarded-host"]).toBeUndefined();
    expect(forwarded["x-forwarded-proto"]).toBeUndefined();
    expect(forwarded["x-real-ip"]).toBeUndefined();
    expect(forwarded["host"]).toBeUndefined();
    // The browser's own cookie still goes upstream; that is the session the
    // remote server issued through this same proxy.
    expect(forwarded["cookie"]).toBe("synara_session=abc");
  });

  it("preserves the WebSocket extension handshake headers verbatim", () => {
    // permessage-deflate negotiates end to end only because these cross the
    // proxy untouched. Rewriting or dropping any of them silently disables
    // compression on the link that needs it most.
    const offered = "permessage-deflate; client_max_window_bits";
    const forwarded = forwardableRequestHeaders({
      "sec-websocket-extensions": offered,
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      "sec-websocket-protocol": "synara",
    });
    expect(forwarded["sec-websocket-extensions"]).toBe(offered);
    expect(forwarded["sec-websocket-key"]).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(forwarded["sec-websocket-version"]).toBe("13");
    expect(forwarded["sec-websocket-protocol"]).toBe("synara");
  });
});

describe("per-environment cookie scoping", () => {
  it("confines a cookie to its environment's path", () => {
    // Every environment is served from ONE origin. Without this rewrite the
    // browser sends environment A's session cookie to environment B — an
    // authentication credential delivered to a server that never issued it.
    expect(scopeSetCookiePath("synara_session=abc; Path=/; HttpOnly", "env-1")).toBe(
      "synara_session=abc; HttpOnly; Path=/env/env-1",
    );
    expect(environmentCookiePath("env-1")).toBe("/env/env-1");
  });

  it("replaces the upstream's Path rather than adding to it", () => {
    // The upstream sets Path=/ because it believes it owns the origin. Keeping
    // that value is the leak; there is nothing to preserve.
    const scoped = scopeSetCookiePath("s=1; Path=/; Secure; SameSite=Lax", "e9");
    expect(scoped).not.toMatch(/Path=\/;/);
    expect(scoped.match(/Path=/g)).toHaveLength(1);
    expect(scoped).toContain("Path=/env/e9");
    expect(scoped).toContain("Secure");
    expect(scoped).toContain("SameSite=Lax");
  });

  it("drops a Domain attribute, which would defeat path scoping entirely", () => {
    // A domain-scoped cookie is sent to every subdomain regardless of path, so
    // preserving Domain would reintroduce the cross-environment leak.
    const scoped = scopeSetCookiePath("s=1; Domain=example.com; Path=/", "e2");
    expect(scoped.toLowerCase()).not.toContain("domain=");
    expect(scoped).toContain("Path=/env/e2");
  });

  it("scopes a cookie that declared no Path at all", () => {
    // With no Path the browser defaults to the request's directory — which for
    // a proxied request is already under /env/<id>, but only for THAT request.
    // Making it explicit removes the dependency on where the response came from.
    expect(scopeSetCookiePath("s=1", "e3")).toBe("s=1; Path=/env/e3");
  });

  it("scopes every cookie when the upstream sets several", () => {
    const headers = forwardableResponseHeaders(
      { "set-cookie": ["a=1; Path=/", "b=2; Path=/api; HttpOnly"] },
      "e4",
    );
    expect(headers["set-cookie"]).toEqual(["a=1; Path=/env/e4", "b=2; HttpOnly; Path=/env/e4"]);
  });

  it("is case-insensitive about the attribute names it rewrites", () => {
    // `Set-Cookie` attribute names are case-insensitive; a case-sensitive
    // filter would leave `path=/` in place and the leak with it.
    for (const spelling of ["path=/", "PATH=/", "Path =/", "pAtH=/"]) {
      const scoped = scopeSetCookiePath(`s=1; ${spelling}; HttpOnly`, "e5");
      expect(scoped.match(/path=/gi), spelling).toHaveLength(1);
      expect(scoped, spelling).toContain("Path=/env/e5");
    }
  });
});
