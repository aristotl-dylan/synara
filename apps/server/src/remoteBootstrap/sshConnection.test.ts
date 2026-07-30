import { describe, expect, it } from "vitest";

import type { RemoteExecOptions, RemoteExecResult } from "./remoteConnection";
import { createSshConnection, sshConnectionOptionArgv, type SshTarget } from "./sshConnection";

const target: SshTarget = { host: "build-01.example.test", user: "deploy" };

interface Invocation {
  readonly file: string;
  readonly argv: ReadonlyArray<string>;
  readonly options: RemoteExecOptions | undefined;
}

function recordingRun(result: Partial<RemoteExecResult> = {}): {
  readonly run: (
    file: string,
    argv: ReadonlyArray<string>,
    options: RemoteExecOptions | undefined,
  ) => Promise<RemoteExecResult>;
  readonly invocations: Array<Invocation>;
} {
  const invocations: Array<Invocation> = [];
  return {
    invocations,
    run: (file, argv, options) => {
      invocations.push({ file, argv, options });
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...result });
    },
  };
}

/** Asserts an invocation was recorded at `index` and returns it typed. */
function invocationAt(invocations: ReadonlyArray<Invocation>, index: number): Invocation {
  const invocation = invocations.at(index);
  expect(invocation).toBeDefined();
  if (!invocation) throw new Error("unreachable");
  return invocation;
}

describe("sshConnectionOptionArgv", () => {
  it("verifies host keys strictly by default", () => {
    expect(sshConnectionOptionArgv(target)).toContain("StrictHostKeyChecking=yes");
  });

  // Mutation guard: the single most dangerous change anyone could make to this
  // file. `accept-new` pins an unknown key once; `no` accepts a CHANGED key,
  // which is an active MITM.
  it("uses accept-new for trust-on-first-use, never no", () => {
    const argv = sshConnectionOptionArgv({ ...target, trustOnFirstUse: true });
    expect(argv).toContain("StrictHostKeyChecking=accept-new");
    expect(argv).not.toContain("StrictHostKeyChecking=no");
    expect(argv).not.toContain("StrictHostKeyChecking=off");
  });

  it("always emits StrictHostKeyChecking so ssh_config cannot weaken it", () => {
    const targets: ReadonlyArray<SshTarget> = [
      target,
      { ...target, trustOnFirstUse: true },
      { ...target, trustOnFirstUse: false },
    ];
    for (const candidate of targets) {
      const argv = sshConnectionOptionArgv(candidate);
      expect(argv.filter((token) => token.startsWith("StrictHostKeyChecking="))).toHaveLength(1);
    }
  });

  it("never disables host key checking through any other option", () => {
    const argv = sshConnectionOptionArgv({ ...target, trustOnFirstUse: true }).join(" ");
    expect(argv).not.toMatch(/UserKnownHostsFile=\/dev\/null/);
    expect(argv).not.toMatch(/CheckHostIP=no/);
    expect(argv).not.toMatch(/HostKeyAlgorithms=/);
  });

  it("runs non-interactively so a prompt cannot hang a bootstrap", () => {
    expect(sshConnectionOptionArgv(target)).toContain("BatchMode=yes");
  });

  it("passes an identity file by path with IdentitiesOnly", () => {
    const argv = sshConnectionOptionArgv({ ...target, identityFile: "/home/me/.ssh/id_ed25519" });
    expect(argv).toContain("IdentitiesOnly=yes");
    expect(argv).toContain("/home/me/.ssh/id_ed25519");
  });

  // Mutation guard: key material must never be an argument. Only a path is.
  it("has no field that could carry key material", () => {
    const keys = Object.keys({
      host: "",
      user: "",
      port: 0,
      identityFile: "",
      knownHostsFile: "",
      trustOnFirstUse: false,
    } satisfies Required<SshTarget>);
    for (const key of keys) {
      expect(key).not.toMatch(/privateKey|passphrase|password|secret/i);
    }
  });
});

describe("exec argv encoding", () => {
  it("encodes the argv as a single shell word list", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).exec(["ls", "-la", "/var/log"]);
    expect(invocationAt(invocations, 0).file).toBe("ssh");
    expect(invocationAt(invocations, 0).argv.at(-1)).toBe("ls -la /var/log");
  });

  // Mutation guard: this is the exact injection seam PR #467's shellInit had.
  // Removing the encoding turns a crafted path into remote code execution.
  it.each([
    ["a command separator", "/tmp/x; rm -rf /"],
    ["command substitution", "/tmp/$(id)"],
    ["a backtick", "/tmp/`id`"],
    ["a pipe", "/tmp/a | tee /tmp/b"],
    ["an ampersand", "/tmp/a && curl evil"],
    ["a newline", "/tmp/a\nrm -rf /"],
    ["a glob", "/tmp/*"],
    ["a variable", "/tmp/$HOME"],
    ["a quote", "/tmp/it's"],
  ])("quotes %s into one inert token", async (_label, hostile) => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).exec(["cat", hostile]);
    const encoded = invocationAt(invocations, 0).argv.at(-1) ?? "";
    expect(encoded.startsWith("cat '")).toBe(true);
    // Everything after `cat ` is a single-quoted token, so no metacharacter is
    // left where the remote shell could act on it.
    expect(encoded.slice(4)).toMatch(/^'(?:[^']|'\\'')*'$/);
  });

  it("passes stdin through rather than putting it in argv", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).exec(["cat"], { stdin: "s3cret-token" });
    expect(invocationAt(invocations, 0).options?.stdin).toBe("s3cret-token");
    expect(invocationAt(invocations, 0).argv.join(" ")).not.toContain("s3cret-token");
  });

  it("passes an explicit port to ssh and scp with the right flag", async () => {
    const { run, invocations } = recordingRun();
    const connection = createSshConnection({ ...target, port: 2222 }, run);
    await connection.exec(["true"]);
    expect(invocationAt(invocations, 0).argv).toContain("-p");
    await connection.uploadFile({ localPath: "/tmp/a", remotePath: "/tmp/b" });
    expect(invocationAt(invocations, 1).file).toBe("scp");
    expect(invocationAt(invocations, 1).argv).toContain("-P");
  });
});

describe("uploadFile", () => {
  it("writes to a temp path and renames, so a truncated file never lands", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).uploadFile({
      localPath: "/tmp/local.tar.gz",
      remotePath: "/remote/staging/local.tar.gz",
      mode: 0o700,
    });
    expect(invocationAt(invocations, 0).argv.at(-1)).toBe(
      "deploy@build-01.example.test:/remote/staging/local.tar.gz.partial",
    );
    expect(invocationAt(invocations, -1).argv.at(-1)).toBe(
      "mv -- /remote/staging/local.tar.gz.partial /remote/staging/local.tar.gz",
    );
  });

  it("chmods the temp path before it becomes the real one", async () => {
    const { run, invocations } = recordingRun();
    await createSshConnection(target, run).uploadFile({
      localPath: "/tmp/node",
      remotePath: "/remote/staging/node",
      mode: 0o700,
    });
    const chmod = invocations.find((invocation) => invocation.argv.at(-1)?.startsWith("chmod"));
    expect(chmod?.argv.at(-1)).toBe("chmod 700 -- /remote/staging/node.partial");
  });

  it("throws instead of silently leaving a partial file when scp fails", async () => {
    const { run } = recordingRun({ exitCode: 1, stderr: "Permission denied" });
    await expect(
      createSshConnection(target, run).uploadFile({
        localPath: "/tmp/a",
        remotePath: "/remote/a",
      }),
    ).rejects.toThrow(/Failed to upload/);
  });
});
