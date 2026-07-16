# RFC: Remote hosts, run sessions on other machines (VPS, Mac Studio) over SSH

## What I want

I want to pick where a session runs, right from the composer. Locally, in a worktree, or on one of my other machines (a VPS, a Mac Studio). The session should keep running when my laptop sleeps, and I should be able to open it from my phone later and continue there. Codex has this with their remote connections feature and it's honestly the thing I miss most in Synara.

I've spent a good amount of time studying how others do this and validating a design against the codebase. I'd love your input before I start building anything. Happy to own the implementation.

## How others solved it

I looked at Codex, OpenCode and T3 Code in depth:

- **Codex** SSHes in and bootstraps `codex app-server` on the remote, with a daemon keeping it alive detached. JSON-RPC threads resume on reconnect. Working copy stays fully remote, no file sync. Their biggest pain point is bootstrap fragility (login shell PATH issues are the top community complaint).
- **OpenCode** is "run `opencode serve` on the box yourself and point clients at the URL". First-class SSH is planned (anomalyco/opencode#7790) and it's exactly a port forward plus optional bootstrap, nothing protocol-level.
- **T3 Code** (architecturally the closest to Synara) treats a remote environment as a full T3 server on the remote box. SSH is just a launch helper: probe the host, start or reuse the server, hold a local port forward, connect over plain WS. Sessions live on the server so they survive disconnects and any paired device can reattach.

All three converge on the same thing: a persistent server on the remote box that owns files, git and sessions, with the client as a thin renderer. Nobody syncs files.

## Proposed design

**A remote environment is a full Synara server running on the remote machine.** The local Synara server acts as an SSH broker: it bootstraps the remote server (upload-first, like VS Code Remote-SSH: upload the exact-version server tarball plus a pinned Node over SSH, never curl-from-internet on the box), installs an OS supervisor (systemd user unit with linger on Linux, launchd on macOS) so it survives reboots, holds the port forward, and monitors health.

The browser keeps a single origin. The local server exposes `/env/:envId/*` and forwards WS frames and HTTP **byte-for-byte** to the remote server over the tunnel. Explicitly not a method-aware RPC relay: the WS surface is one flat RpcGroup with no environment routing key, and event sequences are per-server SQLite autoincrement, so protocol-level relaying would break on every release and collide sequences. Any cross-environment aggregation (the unified sidebar) happens client-side, keyed by `environmentId`.

The composer gets a "Start in" picker (environment, then that environment's projects, with the existing local/worktree option per project). Thread creation carries an `environmentId`, but it never enters the orchestration command schema. Routing is just "which per-environment NativeApi instance receives the dispatch".

And because the remote is a normal Synara server serving its own web bundle, **phone access comes for free**: connect directly to it over Tailscale (ideally `tailscale serve` for HTTPS). Laptop asleep is irrelevant, the session lives on the VPS. No hosted infrastructure needed anywhere, which matters since Synara doesn't have a domain like t3.codes and I think staying fully self-hosted is a feature.

The full spec (with the failure-mode analysis: connectivity state machine, version skew policy, flow control on the proxy, cookie handling, deep links) is in `docs/superpowers/specs/2026-07-16-remote-hosts-design.md` on my fork: https://github.com/aristotl-dylan/synara/blob/remote-hosts-rfc/docs/superpowers/specs/2026-07-16-remote-hosts-design.md

## Things I found along the way that are worth fixing regardless

The validation pass surfaced a few real issues in main that matter even without remote hosts:

1. **Auth enforcement is tied to `--auth-token` presence.** When no token is set, the WS socket is served unauthenticated. For anyone binding to a non-loopback interface (the REMOTE.md flow), that's effectively open RCE. Enforcement should be policy-driven: remote-reachable bind means session auth required, no bypass.
2. **The pairing flow has no client.** The server side exists but there's no `/pair` route, no token entry gate, no QR. Pairing a phone today means manually fiddling with tokens.
3. **Approval responses aren't idempotent.** `decider.ts` accepts `thread.approval.respond` without checking pending state, so two devices answering the same approval both append events. First-wins at the event log fixes it.

I'd send these as small standalone PRs first (Phase 0 below).

## Phasing

Each phase ships on its own:

- **Phase 0:** the standalone fixes above, plus publishing the server tarball as a release asset (needed later for bootstrap, useful now for self-hosters).
- **Phase 1:** connect-to-remote-by-URL. Refactor the WS client from module singleton to an environment-keyed registry, client-side aggregation, version handshake, "add server by URL + token" in settings. No SSH, no broker. This alone is useful (it's the OpenCode model) and proves the multi-server client.
- **Phase 2:** the SSH broker: host config, probe with a structured readiness report, upload-first bootstrap, supervisor install, provisioning handshake, connectivity state machine.
- **Phase 3:** the single-origin `/env/:envId/*` proxy, the composer "Start in" picker, QR pairing for all hosts from one screen, `tailscale serve` detection.

## Open questions where I'd really like your take

1. One shared `SYNARA_HOME` per remote box, or one per connecting broker? Shared gives a unified thread store (phone sees everything), but version upgrades become a contended host-level property.
2. When the remote runs an older version and has active turns, I propose read-degraded plus user-invoked drain-then-upgrade, never auto-restart (weekly releases would otherwise routinely kill long-running work). Sound right?
3. Scope: are you comfortable with this landing incrementally from an external contributor? Phase 1 is small and self-contained, and I'd start there. SSH bootstrap across arbitrary hosts is the highest support-burden part, so it makes sense to gate it on Phase 1 proving out.
4. macOS as a remote host needs some one-time manual setup (auto-login or a LaunchDaemon, Full Disk Access for sshd). OK to document rather than automate in v1?
5. Publishing: GitHub Releases only, or also npm? The bare `synara` npm name is taken, so it'd be a scoped package either way.
6. Is recommending Tailscale as the blessed phone path acceptable, with plain SSH port-forward as the always-works fallback?
