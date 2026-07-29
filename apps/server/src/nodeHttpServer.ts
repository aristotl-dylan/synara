import http from "node:http";
import type { ListenOptions, Socket } from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Scope } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { ServeError } from "effect/unstable/http/HttpServerError";
import { WebSocketServer } from "ws";

export const MAX_WEBSOCKET_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * Node's HTTP parser owns the socket error listener until an upgrade starts.
 * The Effect upgrade handler then runs the route (including authentication)
 * before `ws.handleUpgrade()` installs its own listener. A peer reset during
 * that gap otherwise becomes an unhandled `error` event and terminates the
 * whole backend process.
 *
 * Keep this boundary for the complete lifetime of every accepted connection.
 * Other protocol-specific listeners still receive the event and perform their
 * own cleanup; destroying an already-failed socket here only guarantees that
 * HTTP requests, rejected upgrades, and pending upgrades all release promptly.
 */
function handleClientSocketError(this: Socket): void {
  this.destroy();
}

function protectClientSocket(socket: Socket): void {
  socket.on("error", handleClientSocketError);
}

/**
 * permessage-deflate configuration for the feature WS socket only.
 *
 * The RPC stream is small, highly repetitive JSON (repeated schema keys,
 * UUIDs, event envelopes), which is the best case for DEFLATE with context
 * takeover: the compression window is shared across frames, so each frame is
 * coded against the vocabulary of everything sent before it. Context takeover
 * stays enabled (the negotiated default); a client that offers
 * no-context-takeover still gets standard-compliant compression, just without
 * the shared-window win.
 *
 * No `threshold` is set: `ws` only honors it when context takeover is
 * disabled, and skipping tiny frames would also skip priming the shared
 * window they benefit from.
 *
 * `maxPayload` admission control is unaffected: `ws` enforces it on the
 * decompressed size — accumulated across continuation frames — so a
 * compressed or fragmented message cannot smuggle past the bound.
 *
 * The pre-auth bootstrap socket deliberately never negotiates compression:
 * each actively compressed connection retains zlib window state (~288 KiB at
 * defaults) plus potentially near-`maxPayload` inflated buffers for
 * incomplete fragmented messages, and the bootstrap path is reachable
 * without credentials. Compression is a post-authentication privilege so
 * unauthenticated connections cannot multiply per-connection memory.
 *
 * Measured on a simulated streaming turn (2k push frames x 8 clients,
 * ~430B repetitive JSON frames): 80.7% wire reduction at ~65us CPU per
 * send — dominated by per-invocation zlib overhead, not compression level
 * (levels 1/3/6 within 2% on both axes), so zlib options stay at defaults.
 */
const PER_MESSAGE_DEFLATE_OPTIONS = {
  // Bound zlib concurrency so a burst of streaming pushes across many
  // connections cannot pile up unbounded deflate work on the event loop.
  concurrencyLimit: 10,
} as const;

/** Pre-auth upgrade paths that must never negotiate compression. */
const UNCOMPRESSED_UPGRADE_PATH_PREFIX = "/ws/bootstrap";

export function upgradePathAllowsCompression(requestUrl: string | undefined): boolean {
  const pathname = (requestUrl ?? "").split("?")[0] ?? "";
  return (
    pathname !== UNCOMPRESSED_UPGRADE_PATH_PREFIX &&
    !pathname.startsWith(`${UNCOMPRESSED_UPGRADE_PATH_PREFIX}/`)
  );
}

/**
 * Owns the Node HTTP/WebSocket transport so Synara, rather than the platform
 * adapter's 100 MiB default, controls admission before a message is decoded.
 */
export const makeBoundedNodeHttpServer = Effect.fnUntraced(function* (
  evaluate: () => http.Server,
  options: ListenOptions,
) {
  const scope = yield* Effect.scope;
  const server = evaluate();

  // Install before `listen()`: no accepted connection may exist without a
  // permanent error boundary, including connections reset during startup.
  server.on("connection", protectClientSocket);

  yield* Scope.addFinalizer(
    scope,
    Effect.callback<void>((resume) => {
      server.off("connection", protectClientSocket);
      if (!server.listening) {
        resume(Effect.void);
        return;
      }
      server.close((error) => {
        if (error) resume(Effect.die(error));
        else resume(Effect.void);
      });
    }),
  );

  yield* Effect.callback<void, ServeError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new ServeError({ cause })));
    server.on("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
  });

  const address = server.address()!;
  const makeBoundedWebSocketServer = (perMessageDeflate: boolean) =>
    Effect.acquireRelease(
      Effect.sync(
        () =>
          new WebSocketServer({
            noServer: true,
            maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
            perMessageDeflate: perMessageDeflate ? PER_MESSAGE_DEFLATE_OPTIONS : false,
          }),
      ),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resume(Effect.void));
        }),
    ).pipe(Scope.provide(scope));
  // Two ws servers sharing one HTTP listener: compression is negotiated only
  // on authenticated feature-socket paths (see PER_MESSAGE_DEFLATE_OPTIONS).
  const featureWebSocketServer = yield* makeBoundedWebSocketServer(true);
  const bootstrapWebSocketServer = yield* makeBoundedWebSocketServer(false);

  return HttpServer.make({
    address:
      typeof address === "string"
        ? { _tag: "UnixAddress", path: address }
        : {
            _tag: "TcpAddress",
            hostname: address.address === "::" ? "0.0.0.0" : address.address,
            port: address.port,
          },
    serve: Effect.fnUntraced(function* (httpApp, middleware) {
      const serveScope = yield* Effect.scope;
      const handler = yield* NodeHttpServer.makeHandler(httpApp, {
        middleware: middleware as any,
        scope: serveScope,
      }) as Effect.Effect<
        (nodeRequest: http.IncomingMessage, nodeResponse: http.ServerResponse) => void
      >;
      const featureUpgradeHandler = yield* NodeHttpServer.makeUpgradeHandler(
        Effect.succeed(featureWebSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );
      const bootstrapUpgradeHandler = yield* NodeHttpServer.makeUpgradeHandler(
        Effect.succeed(bootstrapWebSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );
      const upgradeHandler = (
        nodeRequest: http.IncomingMessage,
        socket: Parameters<typeof featureUpgradeHandler>[1],
        head: Parameters<typeof featureUpgradeHandler>[2],
      ) => {
        const dispatch = upgradePathAllowsCompression(nodeRequest.url)
          ? featureUpgradeHandler
          : bootstrapUpgradeHandler;
        dispatch(nodeRequest, socket, head);
      };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.off("request", handler);
          server.off("upgrade", upgradeHandler);
        }),
      );
      server.on("request", handler);
      server.on("upgrade", upgradeHandler);
    }),
  });
});
