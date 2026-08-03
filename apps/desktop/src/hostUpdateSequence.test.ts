import * as FS from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

// Call-site coverage for the update path in main.ts.
//
// The stop logic itself is tested in hostStop.test.ts. What can still go wrong
// is the WIRING: the install path forgetting to call it, calling it after the
// handoff instead of before, or ignoring the refusal. main.ts cannot be
// imported here — it constructs Electron on load — so these assertions read the
// source. A test that reads source is worth less than one that runs it, but it
// is worth considerably more than typecheck, which passes happily when the call
// is deleted outright.

const MAIN = FS.readFileSync(Path.join(import.meta.dirname, "main.ts"), "utf8");

function lineOf(needle: string): number {
  const index = MAIN.indexOf(needle);
  if (index < 0) throw new Error(`main.ts no longer contains: ${needle}`);
  return MAIN.slice(0, index).split("\n").length;
}

describe("the update install path stops the detached host", () => {
  it("calls the host stop during install preparation", () => {
    expect(MAIN).toContain("await stopDetachedHostForInstall();");
  });

  it("stops the host BEFORE handing off to quitAndInstall", () => {
    // Stopping after the handoff is the same bug as not stopping: the process
    // exits under quitAndInstall, so anything sequenced after it never runs.
    expect(lineOf("await stopDetachedHostForInstall();")).toBeLessThan(
      lineOf("autoUpdater.quitAndInstall();"),
    );
  });

  it("stops the host after the child-process stop, not instead of it", () => {
    // Both must run. Host mode is opt-in, so a UI that spawned a child still
    // needs the original path; a UI attached to a host needs the new one.
    expect(lineOf("await stopBackendAndWaitForExit();")).toBeLessThan(
      lineOf("await stopDetachedHostForInstall();"),
    );
  });

  it("refuses the install when the host could not be stopped", () => {
    // The throw is what turns "we could not stop it" into a failed update
    // rather than an update that proceeds over a live writer.
    const helper = MAIN.slice(MAIN.indexOf("async function stopDetachedHostForInstall"));
    const body = helper.slice(0, helper.indexOf("\n}\n"));
    expect(body).toContain("if (!mayInstallAfterStop(outcome))");
    expect(body).toContain("throw new Error(");
  });

  it("clears the attach flag only after a successful stop", () => {
    const helper = MAIN.slice(MAIN.indexOf("async function stopDetachedHostForInstall"));
    const body = helper.slice(0, helper.indexOf("\n}\n"));
    // Order matters: clearing before the refusal check would let recovery start
    // a second server over a host that is still running.
    expect(body.indexOf("if (!mayInstallAfterStop(outcome))")).toBeLessThan(
      body.indexOf("attachedToExistingHost = false;"),
    );
  });

  it("suppresses a backend start while attached to a host", () => {
    // Reached by the crash watchdog and by update recovery; either one starting
    // a server while a live host owns the home creates a second writer.
    const start = MAIN.slice(MAIN.indexOf("function startBackend("));
    const body = start.slice(0, start.indexOf("\n}\n"));
    expect(body).toContain("if (attachedToExistingHost)");
  });

  it("routes a backend start to the detached host in host mode", () => {
    // Watchdog recovery calls startBackend(). In host mode that has to produce
    // a host, not a child that dies with the window.
    const start = MAIN.slice(MAIN.indexOf("function startBackend("));
    const body = start.slice(0, start.indexOf("\n}\n"));
    expect(body).toContain("if (hostModeEnabled())");
    expect(body).toContain("startDetachedHost(");
  });

  it("decides attachment before reserving a port", () => {
    // A reserved port is wrong when attaching: the host is already bound to the
    // one in its record.
    expect(lineOf("const attachOutcome = hostModeEnabled()")).toBeLessThan(
      lineOf('await reserveBackendEndpoint("bootstrap")'),
    );
  });
});
