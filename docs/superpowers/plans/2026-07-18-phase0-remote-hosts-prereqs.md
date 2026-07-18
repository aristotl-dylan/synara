# Phase 0: Remote Hosts Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four standalone Phase 0 fixes from the remote hosts RFC (Emanuele-web04/synara#366) as four narrowly scoped, independent PRs: policy-driven WS auth enforcement, pairing client (/pair + QR), approval idempotency, and a server tarball release asset.

**Architecture:** Each fix is a separate branch cut from `upstream/main`, containing ONLY that fix. Nothing else rides along: no spec, no plan doc, no dashboard, no refactors. The plan doc itself lives only on the `remote-hosts-rfc` branch.

**Tech Stack:** Effect-TS server (bun, vitest via `bun run test`), React 19 + TanStack Router web app, Effect Schema contracts.

## Global Constraints

- Branches cut from `upstream/main` (`git@github.com:Emanuele-web04/synara.git`), pushed to `origin` (aristotl-dylan fork), PRs opened against upstream main.
- NO Claude/AI attribution in any commit or PR body. No em-dashes in PR titles or bodies. Plain human language.
- Each PR body links `Emanuele-web04/synara#366` and explains the change in a few short paragraphs.
- Do NOT include `docs/superpowers/**` files in any PR branch.
- Final verification per branch: `bun fmt`, `bun lint`, `bun typecheck`, plus targeted `bun run test` in the affected workspace. NEVER `bun test`.
- Server tests: `bun run --cwd apps/server test` (vitest, maxWorkers=1).
- Existing behavior on loopback binds must not change (local dev users must not suddenly hit auth walls).

---

### Task 1: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Sync upstream main**

```bash
cd /Users/dylan/dev/synara-contrib
git fetch upstream
```

- [ ] **Step 2: Create the four branches from upstream/main**

```bash
git branch fix/ws-auth-enforcement upstream/main
git branch feat/pairing-client upstream/main
git branch fix/approval-idempotency upstream/main
git branch feat/server-tarball-release upstream/main
```

Work each PR on its own branch; switch with `git checkout <branch>`.

---

## PR 1: Policy-driven WS auth enforcement (`fix/ws-auth-enforcement`)

**Problem:** `apps/server/src/wsRpc.ts:1250-1268` serves the `/ws` socket unauthenticated whenever `config.authToken` is unset (the default), and a matching legacy `?token=` also bypasses session auth entirely. On a remote-reachable bind this is an open RPC surface (~100 methods including process spawn).

**Fix:** Consult the existing `ServerAuthPolicy` (`remote-reachable` is already computed at `apps/server/src/auth/Layers/ServerAuthPolicy.ts:11`). When policy is `remote-reachable`, an unauthenticated connection is never allowed: either the legacy token matches (explicitly configured shared secret, keeps REMOTE.md flow working) or session auth must pass. Loopback policies keep today's behavior.

### Task 2: Extract and test the upgrade decision

**Files:**
- Create: `apps/server/src/wsUpgradeAuth.ts`
- Test: `apps/server/src/wsUpgradeAuth.test.ts`
- Modify: `apps/server/src/wsRpc.ts:1244-1275`

**Interfaces:**
- Produces: `decideWebSocketUpgradeAuth(input): WsUpgradeAuthDecision` (pure function, unit-testable without layers)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/src/wsUpgradeAuth.test.ts
import { describe, expect, it } from "vitest";
import { decideWebSocketUpgradeAuth } from "./wsUpgradeAuth.ts";

describe("decideWebSocketUpgradeAuth", () => {
  it("allows unauthenticated upgrade on loopback policy without a configured token", () => {
    expect(
      decideWebSocketUpgradeAuth({ policy: "loopback-browser", authToken: undefined, legacyToken: null }),
    ).toBe("allow-unauthenticated");
  });

  it("requires session auth on remote-reachable policy when no token is configured", () => {
    expect(
      decideWebSocketUpgradeAuth({ policy: "remote-reachable", authToken: undefined, legacyToken: null }),
    ).toBe("require-session-auth");
  });

  it("accepts a matching legacy token on remote-reachable policy", () => {
    expect(
      decideWebSocketUpgradeAuth({ policy: "remote-reachable", authToken: "s3cret", legacyToken: "s3cret" }),
    ).toBe("allow-legacy-token");
  });

  it("falls through to session auth on remote-reachable policy when the legacy token mismatches", () => {
    expect(
      decideWebSocketUpgradeAuth({ policy: "remote-reachable", authToken: "s3cret", legacyToken: "wrong" }),
    ).toBe("require-session-auth");
  });

  it("keeps legacy behavior on loopback: matching token allows, mismatch requires session auth", () => {
    expect(
      decideWebSocketUpgradeAuth({ policy: "desktop-managed-local", authToken: "s3cret", legacyToken: "s3cret" }),
    ).toBe("allow-legacy-token");
    expect(
      decideWebSocketUpgradeAuth({ policy: "desktop-managed-local", authToken: "s3cret", legacyToken: null }),
    ).toBe("require-session-auth");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run --cwd apps/server test -- wsUpgradeAuth`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/wsUpgradeAuth.ts
import type { ServerAuthPolicy } from "@synara/contracts";

export type WsUpgradeAuthDecision =
  | "allow-unauthenticated"
  | "allow-legacy-token"
  | "require-session-auth";

export function decideWebSocketUpgradeAuth(input: {
  readonly policy: ServerAuthPolicy;
  readonly authToken: string | undefined;
  readonly legacyToken: string | null;
}): WsUpgradeAuthDecision {
  if (input.authToken && input.legacyToken === input.authToken) {
    return "allow-legacy-token";
  }
  if (input.policy === "remote-reachable") {
    return "require-session-auth";
  }
  return input.authToken ? "require-session-auth" : "allow-unauthenticated";
}
```

Note: use a timing-safe comparison for the token if `timingSafeEqualBase64Url` from `apps/server/src/auth/utils.ts` fits; otherwise compare via `crypto.timingSafeEqual` on utf8 buffers of equal length (guard length first). Adjust the pure function to accept a `tokenMatches: boolean` instead of raw strings if that is cleaner; keep the decision table identical.

- [ ] **Step 4: Run tests**

Run: `bun run --cwd apps/server test -- wsUpgradeAuth`
Expected: PASS

- [ ] **Step 5: Wire into wsRpc.ts**

Replace `apps/server/src/wsRpc.ts:1260-1264`:

```ts
const legacyToken = url.searchParams.get("token");
const policy = (yield* serverAuth.getDescriptor()).policy;
const decision = decideWebSocketUpgradeAuth({
  policy,
  authToken: config.authToken,
  legacyToken,
});
const authenticatedSession =
  decision === "require-session-auth"
    ? yield* serverAuth.authenticateWebSocketUpgrade(makeEffectAuthRequest(request))
    : null;
```

The existing `if (!authenticatedSession) { return yield* rpcWebSocketHttpEffect; }` and `acquireUseRelease` block stay unchanged; `authenticateWebSocketUpgrade` already fails with `AuthError` (caught at line 1275 → 401).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/wsUpgradeAuth.ts apps/server/src/wsUpgradeAuth.test.ts apps/server/src/wsRpc.ts
git commit -m "fix: enforce session auth on websocket upgrade for remote-reachable binds"
```

### Task 3: Verify and open PR 1

- [ ] **Step 1: Full verification pass**

Run: `bun fmt && bun lint && bun typecheck && bun run --cwd apps/server test`
Expected: all pass.

- [ ] **Step 2: Confirm the diff contains only this fix**

Run: `git diff upstream/main --stat`
Expected: exactly the three files from Task 2. No docs/superpowers files.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin fix/ws-auth-enforcement
gh pr create --repo Emanuele-web04/synara --head aristotl-dylan:fix/ws-auth-enforcement \
  --title "fix: enforce session auth on the websocket upgrade for remote-reachable binds" \
  --body-file /tmp/pr1-body.md
```

PR body (write to /tmp/pr1-body.md, adapt as needed, no em-dashes):

> Part of #366 (first of the small standalone fixes mentioned there).
>
> Today the `/ws` upgrade only enforces session auth when `--auth-token` is set and the `?token=` query param does not match it. When no token is configured, which is the default, the socket is served without any authentication. On a loopback bind that is fine, but with `--host 0.0.0.0` or a LAN/Tailnet IP (the REMOTE.md flow) it exposes the full RPC surface to the network.
>
> This change consults the existing `ServerAuthPolicy`. When the policy is `remote-reachable`, a connection must either present the configured legacy `?token=` or pass session auth. Loopback policies behave exactly as before, so local dev is unaffected, and the documented `--auth-token` flow keeps working unchanged.
>
> The decision logic is extracted into a small pure function with unit tests covering the policy and token matrix.

---

## PR 2: Pairing client (`feat/pairing-client`)

**Problem:** The server has a complete pairing/token system (`/api/auth/*` routes, `issuePairingCredential`, `issueStartupPairingUrl`) but the web client has no `/pair` route, no auth gate, and no way to pair a device. `issueStartupPairingUrl` (builds `/pair#token=...` URLs) has zero callers. The client API bindings already exist in `apps/web/src/wsNativeApi.ts:604-636` (`bootstrapAuth`, `createAuthPairingToken`, `getAuthSession`) but are unused except `getAuthSession`.

**Fix (narrow):** three pieces, all client-side plus one dependency:
1. `/pair` route: reads the credential from `location.hash`, calls `POST /api/auth/bootstrap` (sets the session cookie), redirects to `/`. Shows a manual token form on failure or when opened without a hash.
2. Auth gate: if `getAuthSession` reports `authenticated: false` and the policy is not a loopback policy, render the token form instead of the app shell.
3. Settings "Pair a device" section: mints a credential via `createAuthPairingToken`, renders the `/pair#token=...` URL as a locally generated QR code plus copyable link.

Dependency: add `qrcode.react` (client-side QR rendering, zero network).

### Task 4: /pair route

**Files:**
- Create: `apps/web/src/routes/_chat.pair.tsx` (or `pair.tsx` outside `_chat` if the chat layout requires auth; inspect `__root.tsx` and place the route so it renders without an authenticated session)
- Test: `apps/web/src/routes/-pairRoute.logic.test.ts`
- Create: `apps/web/src/routes/-pairRoute.logic.ts` (pure helpers: parse `#token=...`, decide next step)

**Interfaces:**
- Consumes: `api.server.bootstrapAuth({ credential })` and `api.server.getAuthSession()` from `apps/web/src/wsNativeApi.ts`
- Produces: `parsePairingTokenFromHash(hash: string): string | null`

- [ ] **Step 1: Write failing test for hash parsing**

```ts
// apps/web/src/routes/-pairRoute.logic.test.ts
import { describe, expect, it } from "vitest";
import { parsePairingTokenFromHash } from "./-pairRoute.logic.ts";

describe("parsePairingTokenFromHash", () => {
  it("extracts the token from a #token= hash", () => {
    expect(parsePairingTokenFromHash("#token=abc123")).toBe("abc123");
  });
  it("returns null for an empty or malformed hash", () => {
    expect(parsePairingTokenFromHash("")).toBeNull();
    expect(parsePairingTokenFromHash("#")).toBeNull();
    expect(parsePairingTokenFromHash("#foo=bar")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** (`bun run --cwd apps/web test -- pairRoute`)

- [ ] **Step 3: Implement the helper**

```ts
// apps/web/src/routes/-pairRoute.logic.ts
export function parsePairingTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const token = new URLSearchParams(raw).get("token");
  return token && token.length > 0 ? token : null;
}
```

- [ ] **Step 4: Run tests, expect PASS**

- [ ] **Step 5: Implement the route component**

Route behavior (match the surrounding component idioms in `apps/web/src/routes/` and reuse existing UI primitives from `apps/web/src/components/ui/`):
- On mount: token from `parsePairingTokenFromHash(window.location.hash)`. If present, immediately `history.replaceState` to strip the hash (do not leave the credential in the address bar), then call `bootstrapAuth`.
- On success: `router.navigate({ to: "/" })`.
- On failure or no token: render a small centered card with a single-line token input and a "Pair" button that calls `bootstrapAuth` with the pasted credential; show the error message from the failed attempt.
- Copy: "Pair this device", "Paste the pairing code from your other device". No em-dashes.

- [ ] **Step 6: Manually verify** — `bun run --cwd apps/web dev` plus server, mint a credential via `curl -X POST localhost:3773/api/auth/pairing-token` with an owner cookie, open `/pair#token=...`, confirm cookie set and redirect.

- [ ] **Step 7: Commit** — `git commit -m "feat: add /pair route that exchanges a pairing credential for a session"`

### Task 5: Auth gate

**Files:**
- Create: `apps/web/src/components/AuthGate.tsx`
- Modify: the shell component that wraps the app (start from `apps/web/src/routes/__root.tsx`; place the gate so `/pair` stays reachable)

**Interfaces:**
- Consumes: the existing `getAuthSession` query in `apps/web/src/lib/serverReactQuery.ts:54` (`AuthSessionState` from contracts: `{ authenticated, auth: { policy, ... }, role? }`)

- [ ] **Step 1: Implement gate logic**

Gate rule (mirror server policy semantics): block only when `state.authenticated === false` AND `state.auth.policy === "remote-reachable"`. Loopback policies (`desktop-managed-local`, `loopback-browser`) never gate. While the session query is loading, render nothing (avoid a flash). When blocked, render the same token form as `/pair` (extract the form into a shared component `apps/web/src/components/PairingTokenForm.tsx` used by both, per the repo's no-duplicate-logic rule).

- [ ] **Step 2: Verify locally** — with `--host 0.0.0.0 --auth-token` unset (policy remote-reachable after PR 1) the app shows the pairing form; on loopback it renders normally.

- [ ] **Step 3: Commit** — `git commit -m "feat: gate the app behind pairing when the server is remote reachable"`

### Task 6: Settings "Pair a device" with QR

**Files:**
- Modify: `apps/web/src/routes/_chat.settings.tsx` (find the section list; add a "Devices" or extend an existing access/network section)
- Create: `apps/web/src/components/PairDeviceCard.tsx`
- Modify: `apps/web/package.json` (add `qrcode.react`)

**Interfaces:**
- Consumes: `api.server.createAuthPairingToken({ label? })` returning `AuthPairingCredentialResult { id, credential, expiresAt }` (already bound in wsNativeApi.ts)

- [ ] **Step 1: Add dependency** — `bun add --cwd apps/web qrcode.react`

- [ ] **Step 2: Implement PairDeviceCard**

- "Pair a device" button. On click: `createAuthPairingToken({ label: "paired-device" })`, build the URL as `new URL("/pair", window.location.origin)` with `url.hash = "token=" + credential` (same shape as `issueStartupPairingUrl` at `apps/server/src/auth/Layers/ServerAuth.ts:370-379`).
- Render `<QRCodeSVG value={url} size={192} />` plus the URL as a copy button, and the expiry.
- Note under the QR: "Anyone with this link can access this server until it expires."
- Owner-only: `createAuthPairingToken` 403s for client sessions; hide the card unless `session.role === "owner"` (from `getAuthSession`).

- [ ] **Step 3: Verify locally** — mint from settings, scan/open URL from a second browser profile, confirm the paired session appears (via `GET /api/auth/clients`).

- [ ] **Step 4: Commit** — `git commit -m "feat: add pair a device flow with QR code in settings"`

### Task 7: Verify and open PR 2

- [ ] **Step 1:** `bun fmt && bun lint && bun typecheck && bun run --cwd apps/web test`
- [ ] **Step 2:** `git diff upstream/main --stat` — only the files above; no docs/superpowers files.
- [ ] **Step 3:** Push, open PR with body (adapt):

> Part of #366.
>
> The server already has a full pairing credential system under `/api/auth/*`, including `issueStartupPairingUrl` which builds `/pair#token=...` URLs, but the web client has no `/pair` route, no auth gate, and no UI to mint a pairing link. Pairing a phone today means hand-crafting requests.
>
> This adds the missing client side: a `/pair` route that exchanges the credential from the URL hash for a session cookie (with a manual paste fallback), an auth gate that only engages when the server policy is `remote-reachable`, and a "Pair a device" card in settings that mints a credential and renders it as a locally generated QR code. The credential is stripped from the address bar immediately after reading. Loopback setups see no change.

Note: mention it composes with the WS auth enforcement PR but does not depend on it.

---

## PR 3: Approval idempotency (`fix/approval-idempotency`)

**Problem:** `apps/server/src/orchestration/decider.ts:1280-1304` handles `thread.approval.respond` with only a `requireThread` guard. Two devices answering the same approval each append a `thread.approval-response-requested` event; the second surfaces downstream as an "unknown pending approval request" provider failure activity (`ProviderCommandReactor.ts:1962-1970`) instead of being rejected at the source. First-wins should be enforced at the event log.

**Design:** The decider's `readModel` (`OrchestrationReadModel`) has no per-request approval state, but the projector folds all events. Add a fold for `thread.approval-response-requested` in `apps/server/src/orchestration/projector.ts` that records responded request ids per thread, and a decider guard that rejects a second response for the same `requestId` with the standard `OrchestrationCommandInvariantError`.

### Task 8: Contract field

**Files:**
- Modify: `packages/contracts/src/orchestration.ts:619-683` (the `OrchestrationThread` struct; also the snapshot variant at ~line 732 if it mirrors thread fields)

**Interfaces:**
- Produces: `respondedApprovalRequestIds: Schema.optional(Schema.Array(ApprovalRequestId))` on `OrchestrationThread`

- [ ] **Step 1: Add the optional field**

```ts
respondedApprovalRequestIds: Schema.optional(Schema.Array(ApprovalRequestId)),
```

Optional keeps every persisted snapshot decodable (same pattern as `hasPendingApprovals` at line 665). Add next to `hasPendingApprovals` in both structs that carry it.

- [ ] **Step 2:** `bun run --cwd packages/contracts build && bun typecheck` — expect clean.
- [ ] **Step 3: Commit** — `git commit -m "fix: track responded approval request ids on orchestration threads"` (fold into the next commit if preferred; one commit for the whole PR is fine).

### Task 9: Projector fold + decider guard

**Files:**
- Modify: `apps/server/src/orchestration/projector.ts` (add a `case "thread.approval-response-requested":` to the event switch that currently falls to `default` at ~line 1095)
- Modify: `apps/server/src/orchestration/commandInvariants.ts` (new guard)
- Modify: `apps/server/src/orchestration/decider.ts:1280-1304`
- Test: `apps/server/src/orchestration/decider.approvalIdempotency.test.ts`

**Interfaces:**
- Produces: `requireApprovalNotResponded({ readModel, command, threadId, requestId }): Effect<void, OrchestrationCommandInvariantError>`

- [ ] **Step 1: Write the failing test** (match `decider.projectScripts.test.ts` conventions: fold events via `projectEvent` from `createEmptyReadModel`, then decide)

```ts
// apps/server/src/orchestration/decider.approvalIdempotency.test.ts
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
// build helpers: create project + thread events, then a
// thread.approval-response-requested event for requestId "req-1",
// folding each through projectEvent (copy the event construction
// idioms from decider.projectScripts.test.ts / projector tests).

describe("decider approval idempotency", () => {
  it("accepts the first response for a pending approval", async () => {
    // fold: project.created, thread.created
    // decide: thread.approval.respond requestId req-1 decision accept
    // expect event.type === "thread.approval-response-requested"
  });

  it("rejects a second response for the same requestId", async () => {
    // fold: project.created, thread.created, thread.approval-response-requested (req-1, accept)
    // decide: thread.approval.respond requestId req-1 decision decline
    // expect Effect failure: OrchestrationCommandInvariantError with detail mentioning req-1
    const failure = await Effect.runPromise(
      Effect.flip(decideOrchestrationCommand({ command, readModel })),
    );
    expect(failure._tag).toBe("OrchestrationCommandInvariantError");
    expect(failure.detail).toContain("req-1");
  });

  it("still accepts responses for different requestIds on the same thread", async () => {
    // fold response for req-1, respond to req-2, expect success
  });
});
```

Fill in the event construction from the real test files; every id via `.makeUnsafe`.

- [ ] **Step 2: Run to verify failure** — `bun run --cwd apps/server test -- approvalIdempotency`. Expected: second test fails (command currently succeeds).

- [ ] **Step 3: Projector fold**

In the event switch in `projector.ts`, before `default:`:

```ts
case "thread.approval-response-requested":
  return decodeForEvent(
    ThreadApprovalResponseRequestedPayload,
    event.payload,
    event.type,
    "payload",
  ).pipe(
    Effect.map((payload) => {
      const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
      if (!thread) return nextBase;
      const responded = thread.respondedApprovalRequestIds ?? [];
      if (responded.includes(payload.requestId)) return nextBase;
      return {
        ...nextBase,
        threads: updateThread(nextBase.threads, payload.threadId, {
          respondedApprovalRequestIds: [...responded, payload.requestId],
          updatedAt: event.occurredAt,
        }),
      };
    }),
  );
```

Import `ThreadApprovalResponseRequestedPayload` from `@synara/contracts` (exported at `packages/contracts/src/orchestration.ts:1639`).

- [ ] **Step 4: Guard in commandInvariants.ts**

```ts
export function requireApprovalNotResponded(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  const responded = thread?.respondedApprovalRequestIds ?? [];
  if (!responded.includes(input.requestId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Approval request '${input.requestId}' on thread '${input.threadId}' was already answered.`,
    ),
  );
}
```

- [ ] **Step 5: Decider wiring** — in the `thread.approval.respond` case, after `requireThread`:

```ts
yield* requireApprovalNotResponded({
  readModel,
  command,
  threadId: command.threadId,
  requestId: command.requestId,
});
```

- [ ] **Step 6: Run tests** — `bun run --cwd apps/server test -- approvalIdempotency` PASS, then the full orchestration suite: `bun run --cwd apps/server test -- orchestration` for regressions.

- [ ] **Step 7: Check the loser's UX path.** Trace how `OrchestrationCommandInvariantError` propagates to the client (search where `decideOrchestrationCommand` failures are handled, likely the command dispatch in providerManager/wsRpc). Confirm the error reaches the caller as a typed RPC failure rather than crashing the pipeline. If the dispatch layer logs-and-drops, that is acceptable for this PR; note it in the PR body.

- [ ] **Step 8: Commit** — `git commit -m "fix: reject duplicate approval responses at the decider"`

### Task 10: Verify and open PR 3

- [ ] **Step 1:** `bun fmt && bun lint && bun typecheck && bun run --cwd apps/server test`
- [ ] **Step 2:** `git diff upstream/main --stat` — contracts + 4 server files only.
- [ ] **Step 3:** Push, open PR:

> Part of #366.
>
> `thread.approval.respond` is not idempotent. The decider only checks that the thread exists, so when two devices answer the same approval request, both responses append a `thread.approval-response-requested` event. The second one currently surfaces as a stale "unknown pending approval request" provider failure activity instead of being rejected up front.
>
> This makes first-wins explicit at the event log: the projector now folds responded approval request ids onto the thread read model, and the decider rejects a second response for the same request with the standard command invariant error. The read model field is optional so existing snapshots keep decoding.

---

## PR 4: Server tarball release asset (`feat/server-tarball-release`)

**Problem:** Releases publish desktop installers (DMG/AppImage/NSIS) and optionally npm (`@synara/cli`, gated on `vars.SYNARA_PUBLISH_CLI`). There is no plain tarball of the headless server (bundle + embedded web client) attached to GitHub Releases. Self-hosters need one, and the remote hosts bootstrap will later fetch exactly this artifact.

**Existing pieces:** `apps/server/scripts/cli.ts build` produces `apps/server/dist/index.mjs` + `dist/client/` (web SPA embedded); the `publish` subcommand already rewrites package.json for distribution (strips devDeps/scripts, resolves `catalog:` deps) at `cli.ts:213-242`.

### Task 11: `pack` subcommand

**Files:**
- Modify: `apps/server/scripts/cli.ts` (add `pack` next to `build`/`publish`)

**Interfaces:**
- Produces: `node apps/server/scripts/cli.ts pack --out <dir>` writing `synara-server-<version>.tar.gz`

- [ ] **Step 1: Implement `pack`**

Reuse the publish flow's staging logic: assert `dist/index.mjs` and `dist/client/index.html` exist (same assertion as `cli.ts:204`), stage `dist/` plus the rewritten package.json (reuse the exact rewrite used by `publish` so the tarball is `npm install`-able in place), then run `npm pack` in the staging dir or `tar -czf` it. Name: `synara-server-<version>.tar.gz` where version comes from the package.json. Print the absolute output path.

- [ ] **Step 2: Verify locally**

```bash
bun run build --filter=@synara/web --filter=@synara/cli
node apps/server/scripts/cli.ts pack --out /tmp/synara-pack
tar -tzf /tmp/synara-pack/synara-server-*.tar.gz | head
```

Expected listing includes `package.json`, `dist/index.mjs`, `dist/client/index.html`. Smoke: extract to a temp dir and `node dist/index.mjs --help` (or `--version`) exits 0.

- [ ] **Step 3: Commit** — `git commit -m "feat: add pack command producing a server tarball"`

### Task 12: Attach to the release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add a `build_server_tarball` job**

Modeled on `publish_cli` (lines 306-341) but NOT gated on `SYNARA_PUBLISH_CLI`: checkout, setup bun/node from package.json files (same as other jobs), `bun install`, `node scripts/update-release-package-versions.ts "$RELEASE_VERSION"`, `bun run build --filter=@synara/web --filter=@synara/cli`, `node apps/server/scripts/cli.ts pack --out release-server`, upload `release-server/*.tar.gz` as an artifact.

- [ ] **Step 2: Include it in the release job**

In the `release` job (lines 343-521): add the job to `needs`, download the artifact, and add `*.tar.gz` to the `softprops/action-gh-release@v2` `files` list (currently `*.dmg *.zip *.AppImage *.exe *.blockmap *.yml` at lines 453-469). Do not touch the bridge/updater feed mirroring; the tarball is a plain release asset.

- [ ] **Step 3: Validate workflow syntax** — `gh workflow view` is unavailable pre-merge; instead run `actionlint .github/workflows/release.yml` if installed, otherwise a YAML parse (`node -e "require('js-yaml').load(...)"` or `bun x yaml` check) and careful diff review.

- [ ] **Step 4: Commit** — `git commit -m "feat: publish server tarball as a release asset"`

### Task 13: Verify and open PR 4

- [ ] **Step 1:** `bun fmt && bun lint && bun typecheck` (no test suite touches these files; keep it light per repo guidance).
- [ ] **Step 2:** `git diff upstream/main --stat` — `apps/server/scripts/cli.ts` + `.github/workflows/release.yml` only.
- [ ] **Step 3:** Push, open PR:

> Part of #366.
>
> Releases currently ship desktop installers, plus npm publishing when enabled. There is no plain tarball of the headless server (the tsdown bundle with the web client embedded) attached to the GitHub Release, so self-hosting a specific version means building from source.
>
> This adds a `pack` command to the server CLI scripts that stages the same distribution layout npm publishing uses and produces `synara-server-<version>.tar.gz`, and a release job that attaches it to the GitHub Release next to the installers. Extract, `node dist/index.mjs`, done. The updater feeds are untouched.

---

## Self-review notes

- Spec coverage: all four Phase 0 items from the RFC issue are covered (Tasks 2-3, 4-7, 8-10, 11-13). The RFC's `--trusted-origin` / Secure-cookie / randomUUID guards were listed in the spec's Phase 0 but NOT in the issue's Phase 0 list; they are excluded here to keep PRs narrow. Revisit after maintainer feedback.
- PR 2's gate depends semantically on the policy value, which PR 1 does not change (`remote-reachable` already exists in `ServerAuthPolicyLive`); the PRs are independent.
- Type consistency: `respondedApprovalRequestIds` is used with the same name in contracts (Task 8), projector and guard (Task 9). `decideWebSocketUpgradeAuth` name is consistent across Tasks 2 and its wiring.
- Known unknown: the exact export name for the web client API object (`api.server.*` vs direct imports from `wsNativeApi.ts`) must be confirmed when implementing Task 4; `serverReactQuery.ts:54` shows `api.server.getAuthSession()` as the live pattern.
