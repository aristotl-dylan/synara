// End-to-end tests for the single-origin `/env/:envId/*` proxy, against REAL
// sockets and a REAL `ws` server standing in for the remote Synara server.
//
// Nothing here mocks the transport. The properties under test — permessage-
// deflate negotiating end to end, a Pong overtaking a multi-MB snapshot, a slow
// consumer producing an explicit resync instead of memory growth — are all
// properties of bytes on a socket, and a fake would assert only that the fake
// behaves as written.

import http, { type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import {
  EnvironmentId,
  WS_CLOSE_PROXY_RESYNC_REQUIRED,
  WS_CLOSE_PROXY_TUNNEL_LOST,
} from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  makeEnvironmentProxyDispatch,
  MAX_WEBSOCKET_MESSAGE_BYTES_FOR_PROXY,
  proxyEnvironmentWebSocket,
} from "./environmentProxy";
import { makeEnvironmentProxyRegistry } from "./environmentProxyTargets";
import { MAX_WEBSOCKET_MESSAGE_BYTES } from "./nodeHttpServer";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function portOf(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(portOf(server)));
  });
}

/**
 * Tracks a server for teardown, destroying every socket it ever accepted.
 *
 * A proxied WebSocket keeps a live upgraded socket on BOTH servers, and
 * `close()` alone waits on them indefinitely, so sockets are collected
 * explicitly rather than relying on the server to know about them.
 */
function track(server: http.Server): void {
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  );
}

/** A stand-in for the remote Synara server: real HTTP + real ws, on loopback. */
async function startFakeRemote(
  options: {
    readonly perMessageDeflate?: boolean;
    readonly onRequest?: (request: http.IncomingMessage, response: http.ServerResponse) => void;
    readonly onConnection?: (socket: WebSocket, request: http.IncomingMessage) => void;
  } = {},
) {
  const seenAuthorization: Array<string | undefined> = [];
  const seenTargets: string[] = [];
  const server = http.createServer((request, response) => {
    seenTargets.push(request.url ?? "");
    seenAuthorization.push(request.headers.authorization);
    if (options.onRequest) {
      options.onRequest(request, response);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "synara_session=remote-token; Path=/; HttpOnly",
    });
    response.end(JSON.stringify({ target: request.url }));
  });
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: options.perMessageDeflate ?? true,
  });
  wss.on("connection", (socket, request) => {
    seenTargets.push(request.url ?? "");
    seenAuthorization.push(request.headers.authorization);
    options.onConnection?.(socket, request);
  });
  const port = await listen(server);
  track(server);
  return { server, wss, port, seenTargets, seenAuthorization };
}

/** The local server: nothing but the proxy dispatch wired the way production wires it. */
async function startLocalProxy(input: {
  readonly registry: ReturnType<typeof makeEnvironmentProxyRegistry>;
  readonly queueOptions?: { maxBytes?: number; maxFrames?: number };
  readonly localResponseBody?: string;
}) {
  const proxyErrors: string[] = [];
  const dispatch = makeEnvironmentProxyDispatch({
    registry: input.registry,
    ...(input.queueOptions ? { queueOptions: input.queueOptions } : {}),
    onError: (message) => proxyErrors.push(message),
  });
  const localRequests: string[] = [];
  const server = http.createServer(
    dispatch.wrapRequestHandler((request, response) => {
      localRequests.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(input.localResponseBody ?? "local-server");
    }),
  );
  const localUpgrades: string[] = [];
  server.on(
    "upgrade",
    dispatch.wrapUpgradeHandler((request, socket) => {
      localUpgrades.push(request.url ?? "");
      socket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
    }),
  );
  const port = await listen(server);
  track(server);
  return { server, port, localRequests, localUpgrades, dispatch, proxyErrors };
}

function registryWith(id: string, port: number) {
  const registry = makeEnvironmentProxyRegistry();
  registry.register({
    environmentId: EnvironmentId.makeUnsafe(id),
    host: "127.0.0.1",
    port,
    credential: `provisioned-${id}`,
  });
  return registry;
}

function fetchText(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path, headers }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      });
      request.on("error", reject);
      request.end();
    },
  );
}

function openProxiedSocket(port: number, path: string, options: Record<string, unknown> = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, options);
  cleanups.push(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  });
  return socket;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("close", (code) => reject(new Error(`closed before open: ${code}`)));
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe("environment proxy — routing and isolation", () => {
  it("forwards a proxied path upstream and leaves every other path to the local server", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });

    const proxied = await fetchText(local.port, "/env/host-a/api/threads");
    expect(proxied.status).toBe(200);
    expect(JSON.parse(proxied.body).target).toBe("/api/threads");
    // The local router must never have seen it. If it had, its SPA fallback
    // would happily serve index.html for a remote deep link and race the
    // proxy's response onto the same socket.
    expect(local.localRequests).not.toContain("/env/host-a/api/threads");

    // A path only the local server serves, distinct from anything the proxied
    // request above would strip down to.
    const localOnly = await fetchText(local.port, "/local-only/settings");
    expect(localOnly.body).toBe("local-server");
    expect(local.localRequests).toContain("/local-only/settings");
    expect(remote.seenTargets).not.toContain("/local-only/settings");
  });

  it("resolves a deep link to the same path on the remote server", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const response = await fetchText(
      local.port,
      "/env/host-a/threads/9f2c-4a/messages?after=17&limit=50",
    );
    expect(JSON.parse(response.body).target).toBe("/threads/9f2c-4a/messages?after=17&limit=50");
  });

  it("404s an unregistered environment without reaching any upstream", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const response = await fetchText(local.port, "/env/host-b/api/threads");
    expect(response.status).toBe(404);
    expect(remote.seenTargets).toHaveLength(0);
    // And it did not silently fall through to the local server either.
    expect(local.localRequests).toHaveLength(0);
  });

  it("cannot be steered to a second environment through a traversal spelling", async () => {
    // Both environments are registered, so a traversal that "worked" would
    // reach a real, unintended upstream rather than merely 404.
    const authorized = await startFakeRemote();
    const forbidden = await startFakeRemote();
    const registry = registryWith("allowed", authorized.port);
    registry.register({
      environmentId: EnvironmentId.makeUnsafe("secret"),
      host: "127.0.0.1",
      port: forbidden.port,
      credential: "provisioned-secret",
    });
    const local = await startLocalProxy({ registry });

    for (const path of [
      "/env/../secret/api",
      "/env/allowed/../../secret/api",
      "/env/allowed/..%2f..%2fsecret",
      "/env/%2e%2e/secret/api",
    ]) {
      const response = await fetchText(local.port, path);
      expect(response.status, path).not.toBe(200);
    }
    expect(forbidden.seenTargets).toHaveLength(0);
  });

  it("presents the environment's provisioned credential and never the client's", async () => {
    // A browser must not be able to choose which credential the local server
    // presents to a remote host.
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    await fetchText(local.port, "/env/host-a/api/threads", {
      authorization: "Bearer attacker-chosen-token",
    });
    expect(remote.seenAuthorization).toEqual(["Bearer provisioned-host-a"]);
  });

  it("scopes an upstream Set-Cookie to the environment's path", async () => {
    // One origin serves every environment, so an unscoped cookie from A would
    // be sent by the browser to B.
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const response = await fetchText(local.port, "/env/host-a/api/auth/bootstrap");
    const cookies = response.headers["set-cookie"] ?? [];
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("Path=/env/host-a");
    expect(cookies[0]).not.toMatch(/Path=\/;/);
    expect(cookies[0]).toContain("HttpOnly");
  });

  it("answers 502 rather than hanging when the tunnel is down", async () => {
    const remote = await startFakeRemote();
    const registry = registryWith("host-a", remote.port);
    const local = await startLocalProxy({ registry });
    await new Promise<void>((resolve) => remote.server.close(() => resolve()));
    const response = await fetchText(local.port, "/env/host-a/api/threads");
    expect(response.status).toBe(502);
  });
});

describe("environment proxy — WebSocket transparency", () => {
  it("carries a full request/response exchange through to the remote server", async () => {
    const remote = await startFakeRemote({
      onConnection: (socket) => {
        socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
      },
    });
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/host-a/ws?token=x");
    await waitForOpen(client);

    const received = new Promise<string>((resolve) =>
      client.once("message", (data) => resolve(data.toString())),
    );
    client.send("hello remote");
    expect(await received).toBe("echo:hello remote");
    // The upstream saw the target with the prefix stripped and the query intact.
    expect(remote.seenTargets).toContain("/ws?token=x");
  });

  it("negotiates permessage-deflate END TO END through the proxy", async () => {
    // A byte-for-byte proxy gets this for free because the extension handshake
    // passes through untouched — but "for free" is exactly the kind of claim
    // that silently stops being true, so it is pinned here.
    const remote = await startFakeRemote({
      perMessageDeflate: true,
      onConnection: (socket) => {
        socket.on("message", (data) => socket.send(data.toString().toUpperCase()));
      },
    });
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/host-a/ws", {
      perMessageDeflate: true,
    });
    await waitForOpen(client);

    // The extension is active on the CLIENT's socket, meaning the browser and
    // the remote server negotiated it with each other across the proxy.
    expect(client.extensions).toContain("permessage-deflate");

    // And a compressed round trip actually works: RSV1-flagged payloads crossed
    // the proxy as opaque bytes and only the endpoints inflated them.
    const highlyCompressible = "synara".repeat(20_000);
    const echoed = new Promise<string>((resolve) =>
      client.once("message", (data) => resolve(data.toString())),
    );
    client.send(highlyCompressible);
    expect(await echoed).toBe(highlyCompressible.toUpperCase());
  });

  it("does not fabricate compression when the client did not offer it", async () => {
    // The proxy has no opinion about the extension. If it did, it could enable
    // compression a client cannot decode.
    const remote = await startFakeRemote({ perMessageDeflate: true });
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/host-a/ws", {
      perMessageDeflate: false,
    });
    await waitForOpen(client);
    expect(client.extensions).toBe("");
  });

  it("closes with 404 for an unregistered environment instead of upgrading", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/nope/ws");
    await expect(waitForOpen(client)).rejects.toThrow();
    expect(remote.seenTargets).toHaveLength(0);
  });

  it("leaves a non-proxied upgrade to the local handler", async () => {
    const remote = await startFakeRemote();
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/ws");
    await expect(waitForOpen(client)).rejects.toThrow();
    expect(local.localUpgrades).toContain("/ws");
  });
});

describe("environment proxy — flow control and head-of-line blocking", () => {
  // Flow control cannot be exercised through a loopback TCP pair: the kernel
  // socket buffers absorb megabytes, so `write()` never returns false and the
  // proxy's queue never fills. These tests therefore drive the relay through
  // its `connect` seam with a duplex whose writable side we control exactly —
  // the SAME production code path, with the one variable that matters (when the
  // consumer accepts bytes) made deterministic instead of left to the kernel.

  /**
   * A socket stand-in that records every byte written to it and can be told to
   * report backpressure — `write()` returning false — the way a saturated
   * kernel socket buffer does.
   *
   * Recording is unconditional so the test can see what the proxy TRIED to
   * send, including the Close frame it writes while tearing down. Backpressure
   * is modelled by the return value alone, which is exactly the signal the
   * relay's flow control keys on.
   */
  function makeControllableUpstream() {
    const written: Buffer[] = [];
    let stalled = false;
    const socket = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        written.push(Buffer.from(chunk));
        callback();
      },
    });
    const realWrite = socket.write.bind(socket);
    (socket as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      realWrite(chunk as Buffer);
      // A stalled consumer accepts the byte into its buffer but tells the
      // writer to stop — precisely what a full socket does.
      return !stalled;
    };
    return {
      socket,
      written,
      /** Stop accepting writes: the consumer has stalled. */
      stall() {
        stalled = true;
      },
      release() {
        stalled = false;
        socket.emit("drain");
      },
      /** Feed bytes as if they arrived from the far end. */
      deliver(bytes: Buffer) {
        socket.push(bytes);
      },
      writtenBytes() {
        return written.reduce((total, chunk) => total + chunk.byteLength, 0);
      },
    };
  }

  /** Frames the way a server sends them: unmasked, FIN set. */
  function serverFrame(opcode: number, payload: Buffer): Buffer {
    if (payload.byteLength < 126) {
      return Buffer.concat([Buffer.from([0x80 | opcode, payload.byteLength]), payload]);
    }
    if (payload.byteLength <= 0xffff) {
      const header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.byteLength, 2);
      return Buffer.concat([header, payload]);
    }
    const header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
    return Buffer.concat([header, payload]);
  }

  const HANDSHAKE_101 = Buffer.from(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n",
  );

  /**
   * Drives `proxyEnvironmentWebSocket` directly with two controllable duplexes,
   * standing in for the browser socket and the tunnel socket.
   */
  function makeControlledProxy(queueOptions?: { maxBytes?: number; maxFrames?: number }) {
    const registry = makeEnvironmentProxyRegistry();
    registry.register({
      environmentId: EnvironmentId.makeUnsafe("host-a"),
      host: "127.0.0.1",
      port: 41_000,
      credential: "cred",
    });
    const upstream = makeControllableUpstream();
    const client = makeControllableUpstream();
    const proxyErrors: string[] = [];
    const request = { url: "/env/host-a/ws", method: "GET", headers: {} } as IncomingMessage;
    proxyEnvironmentWebSocket(
      {
        registry,
        connect: () => upstream.socket,
        ...(queueOptions ? { queueOptions } : {}),
        onError: (message) => proxyErrors.push(message),
      },
      request,
      client.socket,
      Buffer.alloc(0),
    );
    // Complete the handshake so the upstream direction starts framing.
    upstream.deliver(HANDSHAKE_101);
    return { upstream, client, proxyErrors };
  }

  it("delivers a Pong ahead of a queued multi-megabyte snapshot", async () => {
    // The symptom this prevents: a 15-byte Pong queued behind a multi-MB
    // snapshot arrives after the peer's heartbeat deadline, and a healthy
    // connection churns through a reconnect.
    const { upstream, client } = makeControlledProxy({ maxBytes: 32 * 1024 * 1024 });
    await delay(5);
    client.written.length = 0;

    // The browser stops accepting writes, so everything the remote sends queues
    // inside the proxy — the exact condition where ordering decides the outcome.
    client.stall();
    // Just under the per-frame ceiling, so this is queueing pressure rather
    // than an oversized-frame rejection.
    upstream.deliver(serverFrame(0x2, Buffer.alloc(1_500_000, 1)));
    upstream.deliver(serverFrame(0x2, Buffer.alloc(1_500_000, 2)));
    upstream.deliver(serverFrame(0xa, Buffer.from("pong-payload"))); // Pong
    await delay(5);

    client.release();
    await delay(20);

    const opcodes = client.written.map((chunk) => chunk[0]! & 0x0f);
    const pongIndex = opcodes.indexOf(0xa);
    const dataIndexes = opcodes.flatMap((opcode, index) => (opcode === 0x2 ? [index] : []));
    expect(pongIndex, "the Pong must be delivered").toBeGreaterThanOrEqual(0);
    // The first write always goes out before backpressure can be observed, so
    // the property under test is that the Pong overtakes everything still
    // QUEUED — here, the second 1.5 MB snapshot that arrived before it.
    expect(dataIndexes).toHaveLength(2);
    expect(pongIndex).toBeLessThan(dataIndexes[1]!);
    expect(client.written[pongIndex]!.subarray(2).toString()).toBe("pong-payload");
    // ...and the snapshots still arrive, in their original order: a proxy that
    // reordered data would corrupt every ordered stream on the socket.
    expect(client.written[dataIndexes[0]!]!.at(-1)).toBe(1);
    expect(client.written[dataIndexes[1]!]!.at(-1)).toBe(2);
  });

  it("signals an explicit resync when a slow consumer overflows the bound", async () => {
    // The requirement, stated exactly: never silent drops, never unbounded
    // queueing. A client that stops reading must be told its stream is no
    // longer complete, with a code it can act on.
    const { upstream, client, proxyErrors } = makeControlledProxy({ maxBytes: 256 * 1024 });
    await delay(5);
    client.written.length = 0;
    client.stall();

    // A slow cellular consumer: the producer keeps streaming while nothing is
    // read.
    for (let index = 0; index < 40; index += 1) {
      upstream.deliver(serverFrame(0x2, Buffer.alloc(64_000, index)));
      await delay(1);
    }
    await delay(20);

    expect(
      proxyErrors.some((message) => message.includes("queue overflow")),
      "the bounded queue must overflow rather than grow without limit",
    ).toBe(true);

    // The last thing written to the browser is a Close frame carrying the
    // resync code — not a bare disconnect the client would retry as if nothing
    // were wrong.
    // Release the stalled writes so Node flushes everything queued behind them,
    // including the Close frame the proxy wrote during teardown.
    client.release();
    await delay(50);
    const closeFrame = client.written.find((chunk) => (chunk[0]! & 0x0f) === 0x8);
    expect(
      closeFrame,
      `a Close frame must be sent; saw opcodes ${client.written.map((c) => c[0]! & 0x0f).join(",")}`,
    ).toBeDefined();
    expect(closeFrame!.readUInt16BE(2)).toBe(WS_CLOSE_PROXY_RESYNC_REQUIRED);
  });

  it("stops retaining bytes once it overflows, rather than growing without limit", async () => {
    // The failure being prevented is a memory leak, so the retained-byte count
    // is asserted directly: after overflow the proxy holds nothing, no matter
    // how much more the producer sends.
    const MAX_QUEUE_BYTES = 256 * 1024;
    const { upstream, client, proxyErrors } = makeControlledProxy({
      maxBytes: MAX_QUEUE_BYTES,
    });
    await delay(5);
    client.stall();
    const writtenBeforeFlood = client.writtenBytes();

    for (let index = 0; index < 200; index += 1) {
      upstream.deliver(serverFrame(0x2, Buffer.alloc(64_000, 7)));
    }
    await delay(20);

    expect(proxyErrors.some((message) => message.includes("queue overflow"))).toBe(true);
    // 200 * 64 KB = ~12.8 MB offered. What actually reached the browser socket
    // is bounded by the ceiling plus the Close frame — nothing near the volume
    // offered, and nothing still queued.
    const forwarded = client.writtenBytes() - writtenBeforeFlood;
    expect(forwarded).toBeLessThan(MAX_QUEUE_BYTES * 4);
  });

  it("does not leak the backlog into the destination's own unbounded buffer", async () => {
    // Regression guard. Without latching the saturated state, each incoming
    // chunk called drain() again and pushed exactly one more frame past a
    // `write()` that had already returned false. The backlog then migrated
    // frame by frame out of the BOUNDED queue and into Node's writable buffer,
    // which has no ceiling: the queue never overflowed, no resync was ever
    // signalled, and the memory leak was back with the guard still in place.
    const { upstream, client, proxyErrors } = makeControlledProxy({ maxBytes: 256 * 1024 });
    await delay(5);
    const beforeStall = client.writtenBytes();
    client.stall();

    // Deliver in separate chunks, which is what re-triggered the leak: one
    // `data` event per frame.
    for (let index = 0; index < 60; index += 1) {
      upstream.deliver(serverFrame(0x2, Buffer.alloc(64_000, index & 0xff)));
      await delay(0);
    }
    await delay(20);

    // ~3.8 MB offered to a stalled consumer with a 256 KB ceiling. Only the one
    // write that discovered the backpressure may have gone through; everything
    // after it must have been refused, not handed to Node to buffer.
    const forwardedWhileStalled = client.writtenBytes() - beforeStall;
    expect(forwardedWhileStalled).toBeLessThan(512 * 1024);
    expect(proxyErrors.some((message) => message.includes("queue overflow"))).toBe(true);
  });

  it("does not overflow on a healthy connection that keeps draining", async () => {
    // The guard must be a real ceiling, not a hair trigger: a consumer that
    // reads normally can carry far more than the ceiling over its lifetime.
    const { upstream, client, proxyErrors } = makeControlledProxy({ maxBytes: 256 * 1024 });
    await delay(5);
    for (let index = 0; index < 200; index += 1) {
      upstream.deliver(serverFrame(0x2, Buffer.alloc(64_000, 3)));
      await delay(0);
    }
    await delay(20);
    expect(proxyErrors).toEqual([]);
    expect(client.writtenBytes()).toBeGreaterThan(200 * 64_000);
  });

  it("uses a code in the application-private range so no intermediary reinterprets it", () => {
    // 4000-4999 is reserved for the application (RFC 6455 §7.4.2). A code
    // outside it could be assigned meaning by a library or a proxy in between.
    for (const code of [WS_CLOSE_PROXY_RESYNC_REQUIRED, WS_CLOSE_PROXY_TUNNEL_LOST]) {
      expect(code).toBeGreaterThanOrEqual(4_000);
      expect(code).toBeLessThanOrEqual(4_999);
    }
    expect(WS_CLOSE_PROXY_RESYNC_REQUIRED).not.toBe(WS_CLOSE_PROXY_TUNNEL_LOST);
  });

  it("pins the proxy frame ceiling to the WS server's own message bound", () => {
    // If the proxy's ceiling drifted above the server's `maxPayload`, it would
    // buffer frames the server will refuse anyway; below it, it would sever
    // connections carrying legitimate messages.
    expect(MAX_WEBSOCKET_MESSAGE_BYTES_FOR_PROXY).toBe(MAX_WEBSOCKET_MESSAGE_BYTES);
  });
});
describe("environment proxy — tunnel teardown and reattach", () => {
  it("tells the client the tunnel was lost, distinguishably from a resync", async () => {
    // A resync means "you are missing frames". A tunnel loss means "nothing was
    // dropped, the remote session is intact, reattach and resume". Conflating
    // them makes a client either re-snapshot needlessly or skip a resync it
    // needed.
    const sockets: WebSocket[] = [];
    const remote = await startFakeRemote({
      onConnection: (socket) => sockets.push(socket),
    });
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });
    const client = openProxiedSocket(local.port, "/env/host-a/ws");
    await waitForOpen(client);

    const closed = waitForClose(client);
    // The tunnel dies, not the remote server.
    sockets[0]?.terminate();
    const { code } = await closed;
    expect(code).toBe(WS_CLOSE_PROXY_TUNNEL_LOST);
  });

  it("leaves the remote session untouched and allows a clean reattach", async () => {
    // The durability that is the entire reason for this architecture: the turn
    // runs on the remote server, so tearing the proxy connection down and
    // reattaching must not disturb it.
    let counter = 0;
    const liveSockets: WebSocket[] = [];
    const remote = await startFakeRemote({
      onConnection: (socket) => {
        liveSockets.push(socket);
        socket.on("message", (data) => {
          if (data.toString() === "advance") counter += 1;
          if (data.toString() === "read") socket.send(String(counter));
        });
      },
    });
    const local = await startLocalProxy({ registry: registryWith("host-a", remote.port) });

    const first = openProxiedSocket(local.port, "/env/host-a/ws");
    await waitForOpen(first);
    first.send("advance");
    first.send("advance");
    // Read back through the same socket rather than sleeping: this only
    // resolves once the remote has processed both preceding messages, so the
    // teardown below cannot race ahead of them under CI contention.
    const advanced = new Promise<string>((resolve) =>
      first.once("message", (data) => resolve(data.toString())),
    );
    first.send("read");
    expect(await advanced).toBe("2");

    const firstClosed = waitForClose(first);
    first.terminate();
    await firstClosed;

    // Reattach on a brand-new proxy connection.
    const second = openProxiedSocket(local.port, "/env/host-a/ws");
    await waitForOpen(second);
    const value = new Promise<string>((resolve) =>
      second.once("message", (data) => resolve(data.toString())),
    );
    second.send("read");
    // State advanced before the teardown is still there: the proxy never
    // touched the remote session.
    expect(await value).toBe("2");
    expect(liveSockets).toHaveLength(2);
  });

  it("does not disturb a second environment when one tunnel dies", async () => {
    const remoteA = await startFakeRemote();
    const remoteB = await startFakeRemote({
      onConnection: (socket) => socket.send("b-alive"),
    });
    const registry = registryWith("a", remoteA.port);
    registry.register({
      environmentId: EnvironmentId.makeUnsafe("b"),
      host: "127.0.0.1",
      port: remoteB.port,
      credential: "provisioned-b",
    });
    const local = await startLocalProxy({ registry });

    const clientB = openProxiedSocket(local.port, "/env/b/ws");
    await waitForOpen(clientB);
    const heard = new Promise<string>((resolve) =>
      clientB.once("message", (data) => resolve(data.toString())),
    );
    expect(await heard).toBe("b-alive");

    await new Promise<void>((resolve) => remoteA.server.close(() => resolve()));
    // B is still serving after A's tunnel is gone.
    const stillWorks = await fetchText(local.port, "/env/b/health");
    expect(stillWorks.status).toBe(200);
  });
});

describe("environment proxy — WAN-like latency", () => {
  it("completes a full session lifecycle over a delay-injecting tunnel", async () => {
    // No tc/netem in this environment, so latency is injected by a TCP relay
    // that holds every chunk for a fixed delay in BOTH directions. That is the
    // property that matters: a round trip costs 2x the delay, so anything with
    // a hidden per-message round trip shows up as a timeout rather than as
    // "slightly slower".
    const ONE_WAY_DELAY_MS = 40;
    const remote = await startFakeRemote({
      onConnection: (socket) => {
        socket.on("message", (data) => socket.send(`ack:${data.toString()}`));
      },
    });

    const net = await import("node:net");
    const relay = net.createServer((clientSide) => {
      const upstreamSide = net.connect({ host: "127.0.0.1", port: remote.port });
      const forward = (from: NodeJS.ReadableStream, to: NodeJS.WritableStream) =>
        from.on("data", (chunk: Buffer) => {
          setTimeout(() => to.write(chunk), ONE_WAY_DELAY_MS);
        });
      forward(clientSide, upstreamSide);
      forward(upstreamSide, clientSide);
      clientSide.on("error", () => upstreamSide.destroy());
      upstreamSide.on("error", () => clientSide.destroy());
      clientSide.on("close", () => upstreamSide.destroy());
    });
    const relayPort = await new Promise<number>((resolve) =>
      relay.listen(0, "127.0.0.1", () => resolve((relay.address() as AddressInfo).port)),
    );
    cleanups.push(() => new Promise<void>((resolve) => relay.close(() => resolve())));

    const local = await startLocalProxy({ registry: registryWith("wan", relayPort) });

    const started = Date.now();
    const client = openProxiedSocket(local.port, "/env/wan/ws");
    await waitForOpen(client);

    const replies: string[] = [];
    client.on("message", (data) => replies.push(data.toString()));
    for (let index = 0; index < 5; index += 1) client.send(`turn-${index}`);
    // 5 messages pipelined: with a working proxy this costs ~1 round trip, not 5.
    await delay(ONE_WAY_DELAY_MS * 6);
    expect(replies).toEqual(["ack:turn-0", "ack:turn-1", "ack:turn-2", "ack:turn-3", "ack:turn-4"]);
    // A per-message round trip would cost at least 5 * 2 * 40ms = 400ms; the
    // pipelined path is comfortably under that.
    expect(Date.now() - started).toBeLessThan(ONE_WAY_DELAY_MS * 10);

    const httpAtLatency = await fetchText(local.port, "/env/wan/api/threads");
    expect(httpAtLatency.status).toBe(200);
    expect(JSON.parse(httpAtLatency.body).target).toBe("/api/threads");
  });
});
