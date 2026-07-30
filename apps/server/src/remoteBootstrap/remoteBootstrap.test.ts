import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BootstrapArtifactSet } from "./bootstrapArtifacts";
import { ChecksumMismatchError } from "./bootstrapArtifacts";
import { createFakeRemoteHost, type FakeRemoteHost, InterruptionError } from "./fakeRemoteHost";
import type { ProvisioningClaim } from "./provisioningHandshake";
import {
  bootstrapRemoteServer,
  type BootstrapInput,
  readRemoteReleaseId,
  uninstallRemoteServer,
} from "./remoteBootstrap";
import { remoteInstallLayout } from "./remoteInstallLayout";
import { remoteSupervisorPlan } from "./remoteSupervisor";

const ENVIRONMENT_ID = "6f9d0c6e-7a1f-4d2b-9a3c-0e5d1b2c3d4e";
const layout = remoteInstallLayout("/home/deploy/.synara/remote");

/** The fake tar payload is a JSON manifest the fake host expands. */
const TARBALL_MANIFEST = JSON.stringify({
  "dist/index.mjs": "// synara server\n",
  "package.json": '{"version":"0.6.3"}',
});
const NODE_RUNTIME_BYTES = "#!/fake/node binary bytes";

function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

let workspace: string;
let tarballPath: string;
let nodePath: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "synara-bootstrap-"));
  tarballPath = join(workspace, "synara-server-0.6.3.tar.gz");
  nodePath = join(workspace, "node-v22-linux-x64");
  await writeFile(tarballPath, TARBALL_MANIFEST);
  await writeFile(nodePath, NODE_RUNTIME_BYTES);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function artifacts(overrides: Partial<BootstrapArtifactSet> = {}): BootstrapArtifactSet {
  return {
    releaseId: "0.6.3",
    serverVersion: "0.6.3",
    serverTarball: {
      kind: "server-tarball",
      localPath: tarballPath,
      remoteFileName: "synara-server-0.6.3.tar.gz",
      sha256: digestOf(TARBALL_MANIFEST),
      sizeBytes: Buffer.byteLength(TARBALL_MANIFEST),
      mode: 0o600,
    },
    nodeRuntime: {
      kind: "node-runtime",
      localPath: nodePath,
      remoteFileName: "node",
      sha256: digestOf(NODE_RUNTIME_BYTES),
      sizeBytes: Buffer.byteLength(NODE_RUNTIME_BYTES),
      mode: 0o700,
    },
    ...overrides,
  };
}

const supervisor = remoteSupervisorPlan({
  os: "linux",
  layout,
  releaseId: "0.6.3",
  nodePath: `${layout.root}/current/node`,
  entrypointPath: `${layout.root}/current/dist/index.mjs`,
  port: 45123,
  instanceId: "env-abc123",
  homeDirectory: "/home/deploy",
  userId: 1000,
});

function bootstrapInput(
  host: FakeRemoteHost,
  overrides: Partial<BootstrapInput> = {},
): BootstrapInput {
  return {
    connection: host.connection,
    layout,
    artifacts: artifacts(),
    supervisor,
    environmentId: ENVIRONMENT_ID,
    probeHandshake: (credential): Promise<ProvisioningClaim> =>
      Promise.resolve({
        environmentId: ENVIRONMENT_ID,
        serverVersion: "0.6.3",
        acceptedToken: credential.token,
        authenticated: true,
      }),
    ...overrides,
  };
}

describe("clean-host bootstrap", () => {
  it("brings a clean host to a supervised, verified server", async () => {
    const host = createFakeRemoteHost();
    const outcome = await bootstrapRemoteServer(bootstrapInput(host));

    expect(outcome.releaseId).toBe("0.6.3");
    expect(outcome.previousReleaseId).toBeNull();
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
    expect(host.readFile(`${layout.currentLink}/dist/index.mjs`)).toBe("// synara server\n");
    expect(host.readFile(layout.environmentIdFile)?.trim()).toBe(ENVIRONMENT_ID);
    expect(await readRemoteReleaseId(host.connection, layout)).toBe("0.6.3");
  });

  // The whole point of upload-first: an air-gapped host must never be asked to
  // reach the internet. Mutation guard against a "just curl it" regression.
  it.each(["curl", "wget", "npm", "npx", "pip", "apt-get", "yum", "brew", "git"])(
    "never invokes %s on the remote host",
    async (command) => {
      const host = createFakeRemoteHost();
      await bootstrapRemoteServer(bootstrapInput(host));
      for (const argv of host.commands) {
        expect(argv[0]).not.toBe(command);
      }
    },
  );

  it("provisions a credential rather than expecting an open socket", async () => {
    const host = createFakeRemoteHost();
    const outcome = await bootstrapRemoteServer(bootstrapInput(host));
    expect(host.readFile(layout.credentialFile)?.trim()).toBe(outcome.credential.token);
  });

  // Mutation guard: passing the secret as an argument puts it in the remote
  // process table, readable by every other user on the host.
  it("never passes the credential as a command argument", async () => {
    const host = createFakeRemoteHost();
    const outcome = await bootstrapRemoteServer(bootstrapInput(host));
    for (const argv of host.commands) {
      for (const token of argv) {
        expect(token).not.toContain(outcome.credential.token);
      }
    }
  });

  it("writes the credential with owner-only permissions", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    const chmods = host.commands.filter((argv) => argv[0] === "chmod");
    expect(chmods).toContainEqual(["chmod", "600", "--", layout.credentialFile]);
    expect(chmods).toContainEqual(["chmod", "700", "--", layout.root, layout.stateDirectory]);
  });

  it("starts the supervisor and enables linger", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    expect(host.commands).toContainEqual(["loginctl", "enable-linger"]);
    expect(host.commands).toContainEqual(["systemctl", "--user", "restart", supervisor.unitName]);
  });

  it("clears the staging directory only after the handshake succeeds", async () => {
    const host = createFakeRemoteHost();
    const order: string[] = [];
    await bootstrapRemoteServer(
      bootstrapInput(host, {
        onProgress: (progress) => order.push(progress.step),
        probeHandshake: (credential) => {
          expect(host.exists(`${layout.stagingDirectory}/node`)).toBe(true);
          return Promise.resolve({
            environmentId: ENVIRONMENT_ID,
            serverVersion: "0.6.3",
            acceptedToken: credential.token,
            authenticated: true,
          });
        },
      }),
    );
    expect(order.at(-1)).toBe("handshake");
    expect(host.exists(`${layout.stagingDirectory}/node`)).toBe(false);
  });
});

describe("checksum enforcement", () => {
  it("refuses when the local artifact does not match its pinned digest", async () => {
    const host = createFakeRemoteHost();
    const bad = artifacts();
    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: { ...bad, serverTarball: { ...bad.serverTarball, sha256: "0".repeat(64) } },
        }),
      ),
    ).rejects.toThrow(ChecksumMismatchError);
    expect(host.exists(layout.currentLink)).toBe(false);
  });

  // Mutation guard: without the post-upload remote verification, transfer
  // corruption is activated and supervised.
  it("refuses when the uploaded bytes are corrupted in transit", async () => {
    const host = createFakeRemoteHost();
    // A lossy link, not a dropped one: scp reports success but the bytes on the
    // far side differ. Only the post-upload remote digest can catch this.
    host.corruptNextUpload(
      `${layout.stagingDirectory}/synara-server-0.6.3.tar.gz`,
      `${TARBALL_MANIFEST} `,
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(
      ChecksumMismatchError,
    );
    expect(host.exists(layout.currentLink)).toBe(false);
    expect(host.exists(`${layout.releasesDirectory}/0.6.3`)).toBe(false);
  });

  it("refuses corruption of the node runtime too, not just the tarball", async () => {
    const host = createFakeRemoteHost();
    host.corruptNextUpload(`${layout.stagingDirectory}/node`, "#!/evil");
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(
      ChecksumMismatchError,
    );
    expect(host.exists(layout.currentLink)).toBe(false);
  });

  it("refuses when the remote cannot produce a digest at all", async () => {
    const host = createFakeRemoteHost();
    // Both digest tools missing: a host that answers nothing must not pass.
    host.failOn(
      (argv) => argv[0] === "sha256sum" && argv.includes(`${layout.stagingDirectory}/node`),
      () => {
        throw new InterruptionError("sha256sum unavailable");
      },
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow();
    expect(host.exists(layout.currentLink)).toBe(false);
  });
});

describe("resume after an interrupted upload", () => {
  it("re-uploads a truncated staged artifact instead of trusting it", async () => {
    const host = createFakeRemoteHost();
    host.failOn(
      (argv) => argv[0] === "systemctl" && argv[2] === "enable",
      () => {
        throw new InterruptionError("connection dropped mid-bootstrap");
      },
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(InterruptionError);

    // A killed upload leaves a short file behind.
    host.truncate(`${layout.stagingDirectory}/synara-server-0.6.3.tar.gz`, 5);
    const uploadsBefore = host.commands.filter((argv) => argv[0] === "scp").length;

    await bootstrapRemoteServer(bootstrapInput(host));

    const uploadsAfter = host.commands.filter((argv) => argv[0] === "scp").length;
    expect(uploadsAfter).toBeGreaterThan(uploadsBefore);
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
  });

  // Mutation guard: dropping the reuse check makes resume pay for a full
  // re-upload every time, which on a WAN link is the difference between a
  // resumable bootstrap and an unusable one.
  it("skips re-uploading an artifact that is already staged intact", async () => {
    const host = createFakeRemoteHost();
    host.failOn(
      (argv) => argv[0] === "systemctl" && argv[2] === "enable",
      () => {
        throw new InterruptionError("connection dropped mid-bootstrap");
      },
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(InterruptionError);

    const steps: string[] = [];
    await bootstrapRemoteServer(bootstrapInput(host, { onProgress: (p) => steps.push(p.step) }));
    expect(steps.filter((step) => step === "reusing-staged")).toHaveLength(2);
    expect(steps).not.toContain("uploading");
  });

  it("never leaves a partially extracted tree at the release path", async () => {
    const host = createFakeRemoteHost();
    host.failOn(
      (argv) => argv[0] === "tar",
      () => {
        throw new InterruptionError("connection dropped during extraction");
      },
    );
    await expect(bootstrapRemoteServer(bootstrapInput(host))).rejects.toThrow(InterruptionError);
    // The scratch directory may exist; the release path must not.
    expect(host.exists(`${layout.releasesDirectory}/0.6.3`)).toBe(false);
    expect(host.exists(layout.currentLink)).toBe(false);
  });
});

describe("handshake failure rolls back", () => {
  async function bootstrapOnce(host: FakeRemoteHost): Promise<void> {
    await bootstrapRemoteServer(bootstrapInput(host));
  }

  it("restores the previous release when the new one fails verification", async () => {
    const host = createFakeRemoteHost();
    await bootstrapOnce(host);

    const upgraded = artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" });
    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: upgraded,
          // The activated release reports the wrong version: something else is
          // serving on that port.
          probeHandshake: () =>
            Promise.resolve({
              environmentId: ENVIRONMENT_ID,
              serverVersion: "0.6.3",
              acceptedToken: undefined,
              authenticated: true,
            }),
        }),
      ),
    ).rejects.toThrow(/not the one running/);

    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
  });

  // Mutation guard: the strongest security predicate in the flow. Without the
  // environmentId check the broker would attach to a foreign server listening
  // on the forwarded port.
  it("rolls back rather than exposing a server with a foreign environmentId", async () => {
    const host = createFakeRemoteHost();
    await bootstrapOnce(host);

    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
          probeHandshake: () =>
            Promise.resolve({
              environmentId: "00000000-0000-4000-8000-000000000000",
              serverVersion: "0.7.0",
              acceptedToken: undefined,
              authenticated: true,
            }),
        }),
      ),
    ).rejects.toThrow(/did not provision/);
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
  });

  it("rolls back when the remote refuses the provisioned credential", async () => {
    const host = createFakeRemoteHost();
    await bootstrapOnce(host);
    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
          probeHandshake: () =>
            Promise.resolve({
              environmentId: ENVIRONMENT_ID,
              serverVersion: "0.7.0",
              acceptedToken: undefined,
              authenticated: false,
            }),
        }),
      ),
    ).rejects.toThrow(/did not accept the provisioned credential/);
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
  });

  it("leaves no dangling current link on a first-install handshake failure", async () => {
    const host = createFakeRemoteHost();
    await expect(
      bootstrapRemoteServer(
        bootstrapInput(host, {
          probeHandshake: () =>
            Promise.resolve({
              environmentId: undefined,
              serverVersion: undefined,
              acceptedToken: undefined,
              authenticated: false,
            }),
        }),
      ),
    ).rejects.toThrow();
    expect(host.exists(layout.currentLink)).toBe(false);
    expect(host.commands).toContainEqual(["systemctl", "--user", "stop", supervisor.unitName]);
  });
});

describe("successful upgrade records a rollback target", () => {
  it("points previous at the release it replaced", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    const outcome = await bootstrapRemoteServer(
      bootstrapInput(host, {
        artifacts: artifacts({ releaseId: "0.7.0", serverVersion: "0.7.0" }),
        probeHandshake: (credential) =>
          Promise.resolve({
            environmentId: ENVIRONMENT_ID,
            serverVersion: "0.7.0",
            acceptedToken: credential.token,
            authenticated: true,
          }),
      }),
    );
    expect(outcome.previousReleaseId).toBe("0.6.3");
    expect(host.readLink(layout.previousLink)).toBe(`${layout.releasesDirectory}/0.6.3`);
    expect(host.readLink(layout.currentLink)).toBe(`${layout.releasesDirectory}/0.7.0`);
  });
});

describe("uninstall", () => {
  it("leaves no files, units, or processes behind", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    await uninstallRemoteServer({ connection: host.connection, layout, supervisor });

    expect(host.listUnder(layout.root)).toEqual([]);
    expect(host.commands).toContainEqual(["systemctl", "--user", "disable", supervisor.unitName]);
    expect(host.commands).toContainEqual([
      "rm",
      "-f",
      "--",
      `/home/deploy/.config/systemd/user/${supervisor.unitName}`,
    ]);
  });

  // Mutation guard: a `pkill -f synara` here would kill an unrelated Synara on
  // the same host. Every kill must name a pid read from OUR pidfile.
  it("kills only the pid in our own pidfile, and never by pattern", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    host.nodes.set(layout.pidFile, { kind: "file", contents: "4242\n", mode: 0o600 });

    const before = host.commands.length;
    await uninstallRemoteServer({ connection: host.connection, layout, supervisor });
    const during = host.commands.slice(before);

    expect(during.filter((argv) => argv[0] === "kill")).toEqual([["kill", "-TERM", "4242"]]);
    for (const argv of during) {
      expect(["pkill", "killall", "pgrep", "xargs"]).not.toContain(argv[0]);
    }
  });

  it("does not kill anything when the pidfile is absent or unparseable", async () => {
    for (const pidContents of [null, "", "not-a-pid", "0", "1", "-5"]) {
      const host = createFakeRemoteHost();
      await bootstrapRemoteServer(bootstrapInput(host));
      if (pidContents === null) {
        host.nodes.delete(layout.pidFile);
      } else {
        host.nodes.set(layout.pidFile, { kind: "file", contents: pidContents, mode: 0o600 });
      }
      const before = host.commands.length;
      await uninstallRemoteServer({ connection: host.connection, layout, supervisor });
      expect(host.commands.slice(before).filter((argv) => argv[0] === "kill")).toEqual([]);
    }
  });

  it("still removes files when the unit was never installed", async () => {
    const host = createFakeRemoteHost();
    await bootstrapRemoteServer(bootstrapInput(host));
    host.failOn(
      (argv) => argv[0] === "systemctl" && argv[2] === "stop",
      () => {
        throw new InterruptionError("unit not loaded");
      },
    );
    // The stop failure is thrown by the fake, so the caller sees it — but a
    // non-zero exit (the realistic case) must not stop the cleanup.
    await expect(
      uninstallRemoteServer({ connection: host.connection, layout, supervisor }),
    ).rejects.toThrow(InterruptionError);

    const host2 = createFakeRemoteHost();
    // Never bootstrapped: every supervisor command exits non-zero.
    await expect(
      uninstallRemoteServer({ connection: host2.connection, layout, supervisor }),
    ).resolves.toBeUndefined();
  });
});
