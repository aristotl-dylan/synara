# SSH Remote Hosts for Synara — Design Spec

**Date:** 2026-07-16
**Status:** Draft for maintainer discussion (RFC issue to follow)
**Author:** Dylan Verbreyt

## 1. Summary

Add the ability to run agent sessions on remote machines (VPS, Mac Studio) while keeping Synara's single-pane web UI. A remote environment is a **full Synara server** running on the remote box; the user's local Synara server acts as an **SSH broker** that bootstraps it, keeps a port forward alive, and exposes it to the browser through a **byte-level proxy** under a single origin. Sessions live on the remote server, so they survive laptop sleep and are reachable directly from a phone over Tailscale with no hosted infrastructure.

This design was validated against the codebase and stress-tested via a multi-agent review pass (6 deep-dives, 3 adversarial critiques, synthesis). Prior art studied: Codex remote connections, OpenCode server mode (+ planned SSH, anomalyco/opencode#7790), T3 Code remote environments, VS Code Remote-SSH, Zed remoting.

## 2. Goals

- Pick where a session runs from the composer ("Start in: Local / worktree / VPS / Mac Studio"), Codex-style.
- Sessions on a remote host keep running when the laptop sleeps or the browser closes.
- Full access from a phone with **zero hosted infrastructure** (Synara has no domain/cloud, unlike T3's app.t3.codes).
- Working copy, git, worktrees, terminals, and provider sessions live entirely on the remote host. **No file sync.**
- Fully self-hosted and fork-friendly.

## 3. Non-goals (v1)

- File sync between local and remote working copies.
- Thread handoff between hosts (Codex-style). `environmentId` is designed to be stable/durable to leave room for this later.
- Cross-server thread aggregation when connecting *directly* to a remote server (phone-direct sees only that host's threads).
- The local server never ingests, mirrors, or re-projects remote orchestration events. Aggregation is client-side only.
- No relay-side event buffering or cursor tracking; the broker stays stateless w.r.t. orchestration data.
- No local persistence of remote read models. Unreachable hosts render from host config with a connectivity badge; their thread lists appear only while connected.
- Contract/wire versioning (version pinning is the v1 mechanism).

## 4. Architecture decision

### Chosen: full remote server + local broker + single-origin byte proxy

Rejected alternatives (validated during the review pass):

| Alternative | Why rejected |
|---|---|
| **A. Codex-style per-session SSH tunneling** (one local server, provider processes spawned remotely) | "Remote-awareness" is not ~15 exec sites; it is a pervasive assumption across 9 heterogeneous provider spawn paths (stdio ACP, Codex JSON-RPC child, OpenCode HTTP child), PTYs, process-tree kills, git/worktrees, filesystem browsing, attachment/image HTTP routes. Permanent 2x testing tax; rebuilds a remote server one RPC at a time. |
| **B. Manual connect-to-URL only** (no broker) | Not a rival — it is Phase 1 of this design. Every line written for it is kept. |
| **C. Remote-primary** (run Synara only on the VPS) | This is point 8 (direct access) — kept as the zero-code baseline the broker must never regress, but insufficient alone for the local + VPS + Mac Studio mix. |
| **D. Dumb TCP forward, multi-origin browser** | Documented fallback if the relay stalls. Multi-origin breaks notifications/storage/deep links and forces N client-side auth state machines. |

Key structural rule (unanimous across review agents): the relay must **not** be a method-aware RPC relay. The WS surface is one flat RpcGroup (~100 methods) with no environment routing key; event sequences are per-server SQLite `AUTOINCREMENT`; `packages/contracts/src/rpc.ts` churns weekly. Protocol-level relaying would break on every release and collide sequences.

## 5. Design

### 5.1 Remote environment = a full Synara server

- One Synara server per remote host `SYNARA_HOME`, owning its own SQLite store, projects, worktrees, terminals, provider sessions.
- **Invariant (tested, not incidental):** the remote server survives broker disconnect and is reattached idempotently.
- The remote serves its own matching web bundle, so direct access is immune to version skew by construction.

### 5.2 Local server as SSH broker

Stores host configs (settings), SSHes via system `ssh`, probes, bootstraps or reuses the remote server, holds the port forward, monitors health.

**Bootstrap (upload-first, VS Code Remote-SSH model — never remote-download by default):**
1. `ssh` probe: `uname -sm` + existing-state check → **structured readiness report** (runtime present + version, pidfile/port state, node-pty buildable, provider CLIs present), modeled as contracts schemas and surfaced in the environment UI. Never a bare "connection failed".
2. Provision a pinned Node (`>=22.19`, needed for `node:sqlite`) into `~/.synara/remote/node/<version>/` if no compatible system Node.
3. **Upload** the server artifact (bundled `dist/index.mjs` + embedded web client) matching the broker's exact version via scp/sftp into `~/.synara/remote/versions/<version>/`. Remote-internet download is opt-in only.
4. `npm install --omit=dev` with the provisioned Node; run the node-pty smoke gate. If node-pty fails to build (musl/exotic arch), start with terminals disabled as a capability flag rather than failing bootstrap.
5. Start via launcher (absolute paths only), writing pidfile + version file + port file under `~/.synara/`, never `/tmp`.

**Artifact source:** publish the server tarball as a GitHub Release asset (flip `SYNARA_PUBLISH_CLI`). Do not depend on the bare npm name `synara` (squatted); `@synara` scope if npm is wanted at all. Per-arch artifacts: darwin-arm64, linux-x64, linux-arm64.

**SSH auth contract:**
- Require ssh-agent or passphrase-less keys; detect and explain when neither is available.
- Host-key fingerprints shown in the add-host UI as an explicit confirm step (`accept-new` only after user confirmation; never blind auto-accept).
- Pipe `ssh` stderr into typed errors. ProxyJump/2FA hosts must be pre-configured in `~/.ssh/config`; provide a "Test connection" button.
- Host/SSH config lives in `settings.json` (never secrets; SSH keys stay in `~/.ssh`/agent). Per-host bearer tokens live in `secretsDir`.

### 5.3 The relay: a sanitizing, auth-injecting, flow-controlled byte proxy

Local server exposes `/env/:envId/ws` (WS-upgrade passthrough) and `/env/:envId/api/*` (HTTP reverse proxy) over the SSH port forward. Frames forwarded byte-for-byte; orchestration payloads never parsed. The browser keeps a single origin but speaks the remote server's exact RPC schema end-to-end.

Not literally "dumb":
- **Header contract:** strip `Cookie`/`Set-Cookie` in both directions across `/env/:envId/*`; the proxy injects the broker's `ws-token` (WS upgrade) / `Authorization` (HTTP) itself. Otherwise the remote's `Set-Cookie` clobbers the local session on the shared origin and the local cookie leaks to the remote. A test must assert no `Set-Cookie` ever crosses the env prefix.
- **Flow control:** terminal output is lossless with renderer ACK accounting. Pause upstream when downstream `bufferedAmount` exceeds a ceiling; never drop or coalesce frames; on ceiling breach close the browser-side connection (normal reattach path). Bounded memory is mandatory — the local server's failure takes down all environments. Requires a load test: fast remote terminal + slow browser consumer.
- **HTTP coverage:** all `/api/*` routes (auth, `local-image`, `attachments`, `thread-export`, `project-favicon`), not just `/ws`. Client URL-builder modules take an environment base-path parameter.

### 5.4 Client: environment-keyed multi-connection + client-side aggregation

- Refactor `wsNativeApi`/`wsTransport` from module singleton to an **environment-keyed registry** exposed via React context; per-environment shell subscription state.
- Cross-environment aggregation (unified sidebar) merges per-environment `ThreadShell`/`ProjectShell` snapshots at render time keyed by `environmentId`, one snapshot + sequence watermark per environment. (Per-server `AUTOINCREMENT` sequences collide otherwise; they must never be mixed.)
- Thread creation carries an `environmentId`, but **no `environmentId` enters the orchestration command schema** — routing is "which per-environment NativeApi instance receives the `thread.create` dispatch".

### 5.5 Composer "Start in" picker

- **Two-stage:** environment → that environment's project list (with the existing `envMode` local/worktree option per project). Never a picker that dead-ends on an empty remote project list.
- **Cold-host onboarding:** first-run "set up this host" flow — a remote Synara terminal pre-filled with `git clone` / `gh auth login` / provider-login commands, plus "create project from repo URL" (clones on the remote).
- **Inline readiness:** per-environment provider availability (from the remote's `ProviderHealth` stream keyed by `environmentId`) and connectivity state shown inline.
- **Per-project default environment**, remembered, so repeat use is one click. `environmentId` is a stable, durable identifier (not an index).

### 5.6 Direct access (phone) — first-class complement

- The remote is a normal Synara server; a phone connects directly via Tailscale using pairing/session auth.
- **Recommended path:** `tailscale serve` (HTTPS on the tailnet, server binds loopback) — restores voice input, Web Notifications, PWA install, Secure cookies. Bootstrap detects `tailscaled` and offers to run/emit the exact command. Fallback: plain HTTP on the tailnet IP with documented degradations.
- **Honest scope:** phone-direct is per-host in v1 — N hosts = N origins = N pairings = N per-origin localStorage prefs. The local UI's "pair a device" flow generates QR codes for all configured hosts in one screen. A static "switchboard" page is v2.

### 5.7 Remote lifecycle: OS supervisor as restart authority

- Bootstrap installs a supervisor: systemd **user** unit + `loginctl enable-linger` (Linux); launchd LaunchAgent with `RunAtLoad`+`KeepAlive` (macOS; headless Mac needs auto-login or a LaunchDaemon; sshd TCC/Full Disk Access caveat documented).
- The broker is only a fallback restarter. Absolute paths and explicit `SYNARA_HOME` on all invocations.
- Remote logs at `~/.synara/logs` with a "view remote logs" affordance in the broker UI.
- **No-auto-exit policy:** the remote never self-exits while threads exist.
- UI copy states plainly that a remote restart interrupts in-flight turns (they reconcile to `interrupted` via `startupTurnReconciliation`; turns never resume across restart — matching local semantics).

### 5.8 Auth (works with zero hosted infra)

Three mandatory fixes, all independently valuable (Phase 0):
1. **Policy-driven enforcement.** Today `wsRpc.ts` serves the socket unauthenticated when no legacy `--auth-token` is set; a remote-reachable server is then wide-open RCE. When the server resolves "remote-reachable" (non-loopback bind) OR broker-managed mode, require session auth on every WS upgrade and HTTP route, with no legacy-token bypass. Launcher refuses to start (and broker refuses to relay to) a server reporting auth disabled. Deprecate `?token=` for remote deployments.
2. **Build the pairing client** (server-complete, client-nonexistent today): (a) `/pair` route reading the credential from `location.hash`, POSTing `/api/auth/bootstrap`, setting the cookie, redirecting; (b) an auth-gate with a short token-entry form as the zero-infra fallback; (c) "Pair a device" in local remote-host settings that mints a pairing token on the remote via the broker relay and renders a locally-generated QR (client-side lib, no hosted infra).
3. **Broker provisioning handshake:** launcher seeds a single-use owner-role bootstrap grant → broker exchanges it at `/api/auth/bootstrap/bearer` over the forward → labeled bearer token stored in local `ServerSecretStore` keyed by host id → `ws-token` per relayed connection → automatic re-pair over SSH on 401.

Plus: `--trusted-origin` (repeatable) / `SYNARA_TRUSTED_ORIGINS` so the `tailscale serve` HTTPS origin passes the trusted-origin check; `; Secure` on the session cookie over HTTPS; route the three unguarded `crypto.randomUUID()` call sites through the existing `randomUUID()` util so plain-HTTP fallback degrades instead of breaking.

Security posture: the local box is the root of trust for all remotes; `/env/*` sits behind the same auth policy as native routes with no bypass; local session auth enabled is a documented prerequisite for adding hosts.

### 5.9 Connectivity state machine + layered liveness

A byte pipe cannot tell "idle" from "dead", and the client only resubscribes when its own stream fails — a dead SSH tunnel behind a healthy browser↔local WS would otherwise produce silent staleness.

- **Layered liveness:** (1) `ServerAliveInterval`/`ServerAliveCountMax` on every tunnel; (2) broker-level WS ping (or cheap descriptor poll) against the remote with a hard deadline — on timeout, tear down ALL proxied connections for that environment; (3) the proxy completes the upstream WS dial **before** accepting the browser's upgrade (503 otherwise) so client backoff accumulates instead of connect-then-fail storming; (4) jitter on client backoff.
- **Fail-fast, no buffering:** on tunnel/remote-WS drop, immediately fail every relayed subscription stream so the client's existing failure-driven resubscribe + snapshot-on-subscribe recovery fires. On re-establishment, the remote re-sends full snapshots.
- **`environment.status` push** (`probing / connecting / bootstrapping / online / degraded / version-mismatch / unreachable`) is the UI's source of truth for connection state, not per-connection errors. Remote lifecycle/`welcome` events are consumed by the broker, not forwarded on the browser's lifecycle channel.
- **Per-host connection policy:** auto-connect / on-demand / manual, defaulting to on-demand; unreachable hosts collapse to a quiet "offline — tap to connect" row.

### 5.10 Version skew: pin-to-broker, never auto-restart a busy remote

- Broker installs and pins the remote to its own exact version (side-by-side `~/.synara/remote/versions/<version>/`; one server per host `SYNARA_HOME`; version is a host-level property with a lockfile around relaunch).
- First RPC after tunnel-up is a descriptor fetch. On `serverVersion` mismatch the proxy hard-rejects and the environment enters a first-class `version-mismatch` state: **read-degraded** (view threads, no new dispatch) with "remote is vX — update required".
- **Relaunch is user-invoked** and blocked (or requires explicit "interrupt N in-flight turns" confirmation) while any thread has an active turn — drain-then-upgrade. Rationale: ~weekly releases × restart-interrupts-turns would routinely destroy the long-running work this feature exists to protect.
- **Newest-version-wins, human-confirmed:** an older broker never downgrades a running newer server; it prompts to update itself. Record which broker/version last upgraded the host.

### 5.11 Deep links & cross-surface routing

- Encode `environmentId` in new deep-link URLs (e.g. `/env/:envId/:threadId`; legacy `/:threadId` defaults to local) and in notification payloads.
- Persist a local `threadId → environmentId` map as a fallback.
- Render the environment's connectivity state ("lives on `vps-1`, reconnecting") as the thread's loading state instead of a 404/blank.
- Automations execute on the server owning the project; the automations UI is environment-scoped in v1.

### 5.12 Approval idempotency (prerequisite fix)

`decider.ts` handles `thread.approval.respond` with no pending-state check; phone-approve + laptop-deny both append contradictory events. With relayed-laptop + direct-phone on one thread this becomes routine. Fix at the decider: consult the pending-approval read model, reject non-pending `requestId` with a typed already-resolved error, first-wins at the event log. Surface the loser as a benign "already answered on another device". Pure local-server fix, valuable independently.

## 6. Phasing

**Phase 0 — independently valuable, no remote hosts required:**
- Policy-driven auth enforcement (5.8.1)
- Pairing client: `/pair` route, auth-gate, local QR (5.8.2)
- `--trusted-origin`, Secure cookies, `crypto.randomUUID()` guards
- Approval idempotency (5.12)
- Publish server tarball as GitHub Release asset

**Phase 1 — connect-to-remote-by-URL (proves the multi-server model, no broker):**
- Environment-keyed `wsNativeApi`/`wsTransport` registry (series of small PRs: registry → per-env shell state → URL builders)
- `ExecutionEnvironmentDescriptor` handshake; version-skew detection + `version-mismatch` UI state
- Client-side aggregation keyed by `environmentId`
- Environment-aware deep links + `threadId → environmentId` map
- Manual "add server by URL + token"

**Phase 2 — SSH broker + bootstrap + supervisor:**
- Host config in settings; SSH probe with structured readiness report + host-key confirm UI
- Upload-first bootstrap; pinned Node; node-pty smoke gate; side-by-side versioned installs
- OS supervisor install; pidfile/version/port files; remote log surfacing
- Broker provisioning handshake; connectivity state machine; per-host connection policy

**Phase 3 — single-origin relay + polish:**
- `/env/:envId/*` sanitizing byte proxy (5.3, 5.9)
- Two-stage "Start in" picker + cold-host onboarding + per-project defaults
- Per-environment provider badges; `tailscale serve` detection; multi-host QR pairing screen
- Load test: fast remote terminal + slow browser consumer

Each phase ships independently. Alternative D (direct-to-forwarded-port) remains an implicit fallback if the Phase 3 relay proves troublesome, since the Phase 2 port forward already exists.

## 7. Open questions for the maintainer

1. **`SYNARA_HOME` sharing model:** one shared `SYNARA_HOME` per remote box (unified thread store, contended version) vs. one per broker identity (no contention, forked thread store). Which is the v1 default?
2. **Version-skew UX when the remote is busy:** is read-degraded until drain acceptable, or should the broker surface the remote's direct URL so a busy out-of-date remote stays fully usable until idle?
3. **v1 scope ownership:** the full amended design is 4–8+ weeks; SSH bootstrap across arbitrary hosts is the highest-support-burden feature class here. Maintainer ownership of the broker tier, gate on Phase 1 proving demand, or external contribution with a support commitment?
4. **macOS headless target:** documented one-time manual setup (auto-login/LaunchDaemon, sshd Full Disk Access) acceptable, or must bootstrap automate it?
5. **npm publishing:** GitHub Releases only (fully self-hosted, fork-friendly) or also `@synara/cli` on npm?
6. **Tailscale positioning:** blessed mobile path (best UX, third-party dep) with SSH port-forward fallback, or purely optional with the degraded HTTP story leading?

## 8. Testing

- Unit: proxy header sanitization (no `Set-Cookie` across env prefix), flow-control ceiling behavior, decider approval idempotency, version-mismatch rejection.
- Integration: bootstrap against a loopback SSH server (docker sshd fixture); broker handshake; reattach-idempotency of a running remote; fail-fast subscription teardown + snapshot recovery on tunnel drop.
- Load: fast remote terminal + slow browser consumer (bounded proxy memory, lossless terminal frames).
- Manual matrix: Linux VPS (systemd user + linger), macOS Studio (launchd), reboot recovery, phone-direct via `tailscale serve`, version-mismatch drain-then-upgrade.

## 9. Prior art (references)

- Codex remote connections: SSH-bootstrapped `codex app-server` + detached daemon, JSON-RPC threads, working copy remote. https://developers.openai.com/codex/remote-connections
- OpenCode server mode + planned SSH: https://opencode.ai/docs/server/ , https://github.com/anomalyco/opencode/issues/7790
- T3 Code remote environments (closest sibling; full remote server, SSH as launch helper + port forward): https://github.com/pingdotgg/t3code (docs/architecture/remote.md)
- VS Code Remote-SSH (upload-first server bootstrap), Zed remoting (custom proxy protocol, deliberately not followed — final hop stays plain HTTP/WS).
