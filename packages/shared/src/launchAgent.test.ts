import { describe, expect, it } from "vitest";

import {
  bootoutArgv,
  bootstrapArgv,
  escapeXmlText,
  kickstartArgv,
  launchAgentPath,
  launchdGuiDomain,
  renderLaunchAgentPlist,
  type LaunchAgentSpec,
} from "./launchAgent";

function spec(overrides: Partial<LaunchAgentSpec> = {}): LaunchAgentSpec {
  return {
    label: "com.emanueledipietro.synara.host",
    argv: ["/usr/local/bin/node", "/opt/synara/server.mjs", "--port", "21987"],
    workingDirectory: "/opt/synara",
    logPath: "/opt/synara/logs/host.log",
    ...overrides,
  };
}

describe("escapeXmlText", () => {
  it("escapes the characters that would break the document", () => {
    expect(escapeXmlText('a & b < c > d "e"')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });

  it("escapes ampersands before the entities it introduces", () => {
    // Naive ordering produces &amp;lt; here.
    expect(escapeXmlText("&<")).toBe("&amp;&lt;");
  });
});

describe("renderLaunchAgentPlist", () => {
  it("renders a loadable agent", () => {
    const plist = renderLaunchAgentPlist(spec());
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>com.emanueledipietro.synara.host</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>--port</string>");
    expect(plist).toContain("<string>21987</string>");
    expect(plist.endsWith("\n")).toBe(true);
  });

  it("restarts only on abnormal exit", () => {
    // A bare <key>KeepAlive</key><true/> restarts even a clean exit, which turns
    // a deliberate stop — an update, say — into a restart loop.
    const plist = renderLaunchAgentPlist(spec());
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("    <false/>");
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("starts at login", () => {
    expect(renderLaunchAgentPlist(spec())).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it("sends stdout and stderr to one file", () => {
    // Interleaving preserves the ordering between a message and the error it
    // caused, which two files cannot express.
    const plist = renderLaunchAgentPlist(spec());
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist.match(/\/opt\/synara\/logs\/host\.log/g)).toHaveLength(2);
  });

  it("escapes a path containing XML metacharacters", () => {
    const plist = renderLaunchAgentPlist(
      spec({ workingDirectory: "/Users/a&b/<test>", logPath: "/Users/a&b/<test>/host.log" }),
    );
    expect(plist).toContain("/Users/a&amp;b/&lt;test&gt;");
    expect(plist).not.toContain("/Users/a&b/<test>");
  });

  it("omits the environment block when there is nothing to set", () => {
    expect(renderLaunchAgentPlist(spec())).not.toContain("EnvironmentVariables");
  });

  it("renders environment entries in a stable order", () => {
    // Same spec must render byte-identically, or anything comparing the file to
    // decide whether to reinstall sees a change that is not one.
    const first = renderLaunchAgentPlist(
      spec({ environment: { SYNARA_HOME: "/home/x", SYNARA_PORT: "1", A_FIRST: "y" } }),
    );
    const second = renderLaunchAgentPlist(
      spec({ environment: { SYNARA_PORT: "1", A_FIRST: "y", SYNARA_HOME: "/home/x" } }),
    );
    expect(first).toBe(second);
    expect(first.indexOf("A_FIRST")).toBeLessThan(first.indexOf("SYNARA_HOME"));
  });

  it.each([
    ["empty", ""],
    ["leading dot", ".example.invalid"],
    ["a space", "example invalid"],
    ["a slash", "example/invalid"],
    ["a newline", "example.invalid\nevil"],
  ])("refuses a label with %s", (_label, value) => {
    expect(() => renderLaunchAgentPlist(spec({ label: value }))).toThrow(/Invalid launchd label/);
  });

  it("refuses an empty program", () => {
    expect(() => renderLaunchAgentPlist(spec({ argv: [] }))).toThrow(/at least a program/);
  });

  it.each([
    ["relative", "opt/synara"],
    ["traversing", "/opt/../etc"],
  ])("refuses a %s working directory", (_label, value) => {
    expect(() => renderLaunchAgentPlist(spec({ workingDirectory: value }))).toThrow(
      /absolute path/,
    );
  });
});

describe("launchAgentPath", () => {
  it("places the agent in the user's LaunchAgents directory", () => {
    expect(launchAgentPath("/Users/dylan", "com.emanueledipietro.synara.host")).toBe(
      "/Users/dylan/Library/LaunchAgents/com.emanueledipietro.synara.host.plist",
    );
  });

  it("refuses a relative home directory", () => {
    expect(() => launchAgentPath("Users/dylan", "com.emanueledipietro.synara.host")).toThrow(
      /absolute path/,
    );
  });
});

describe("launchctl argv", () => {
  it("targets the GUI domain, not the user domain", () => {
    // A job in user/<uid> runs without a login session and cannot reach the
    // window server or the login keychain, which provider CLIs need.
    expect(launchdGuiDomain(501)).toBe("gui/501");
  });

  it("bootstraps with the plist path", () => {
    expect(
      bootstrapArgv(501, "/Users/d/Library/LaunchAgents/com.emanueledipietro.synara.host.plist"),
    ).toEqual([
      "launchctl",
      "bootstrap",
      "gui/501",
      "/Users/d/Library/LaunchAgents/com.emanueledipietro.synara.host.plist",
    ]);
  });

  it("boots out by service target rather than by path", () => {
    // The path form fails once the file is gone, which is the state uninstall
    // is trying to reach — it would make uninstall order-dependent.
    expect(bootoutArgv(501, "com.emanueledipietro.synara.host")).toEqual([
      "launchctl",
      "bootout",
      "gui/501/com.emanueledipietro.synara.host",
    ]);
  });

  it("kickstarts with -k so a running instance is replaced", () => {
    // Without -k this is a no-op on a running job, and an update that swapped
    // the binary would leave the old one serving.
    expect(kickstartArgv(501, "com.emanueledipietro.synara.host")).toEqual([
      "launchctl",
      "kickstart",
      "-k",
      "gui/501/com.emanueledipietro.synara.host",
    ]);
  });

  it("never builds a shell string", () => {
    for (const argv of [
      bootstrapArgv(501, "/Users/d/Library/LaunchAgents/com.emanueledipietro.synara.host.plist"),
      bootoutArgv(501, "com.emanueledipietro.synara.host"),
      kickstartArgv(501, "com.emanueledipietro.synara.host"),
    ]) {
      expect(argv[0]).toBe("launchctl");
      expect(argv.some((token) => token.includes(" ") || token.includes(";"))).toBe(false);
    }
  });

  it.each([-1, 1.5, Number.NaN])("refuses uid %s", (uid) => {
    expect(() => launchdGuiDomain(uid)).toThrow(/Invalid user id/);
  });
});
