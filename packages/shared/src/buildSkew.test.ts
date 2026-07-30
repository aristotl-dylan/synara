import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyBuildSkew,
  isReadOnlySafeWsMethod,
  parseBuildVersion,
  READ_ONLY_SAFE_WS_METHODS,
} from "./buildSkew";

describe("parseBuildVersion", () => {
  it.each([
    ["0.6.3", { major: 0, minor: 6 }],
    ["v1.2.3", { major: 1, minor: 2 }],
    ["10.20.0-beta.1", { major: 10, minor: 20 }],
    ["1.2", { major: 1, minor: 2 }],
    ["1.2+build.5", { major: 1, minor: 2 }],
  ])("parses %s", (build, expected) => {
    expect(parseBuildVersion(build)).toEqual(expected);
  });

  it.each([undefined, "", "dev", "1", "x.y.z", ".1.2", "1.x"])(
    "returns null for unparseable build %s",
    (build) => {
      expect(parseBuildVersion(build)).toBeNull();
    },
  );
});

describe("classifyBuildSkew", () => {
  it("treats patch differences within a release line as compatible", () => {
    expect(classifyBuildSkew({ clientBuild: "0.6.3", serverBuild: "0.6.9" })).toBe("compatible");
    expect(classifyBuildSkew({ clientBuild: "0.6.3", serverBuild: "0.6.3" })).toBe("compatible");
  });

  it.each([
    ["a minor skew", "0.6.3", "0.7.0"],
    ["a major skew", "1.0.0", "2.0.0"],
    ["a client ahead of the server", "0.7.0", "0.6.3"],
  ])("degrades to read-only on %s", (_label, clientBuild, serverBuild) => {
    expect(classifyBuildSkew({ clientBuild, serverBuild })).toBe("read-only");
  });

  // Fail safe: a degraded session is recoverable, a wrongly-trusted one is not.
  it.each([
    [undefined, "0.6.3"],
    ["0.6.3", undefined],
    ["dev", "0.6.3"],
    ["0.6.3", "unknown"],
  ])("degrades to read-only for unparseable builds (%s, %s)", (clientBuild, serverBuild) => {
    expect(classifyBuildSkew({ clientBuild, serverBuild })).toBe("read-only");
  });
});

describe("read-only method allowlist", () => {
  it.each([
    ORCHESTRATION_WS_METHODS.getSnapshot,
    ORCHESTRATION_WS_METHODS.subscribeThread,
    WS_METHODS.gitStatus,
    WS_METHODS.serverGetSettings,
    WS_METHODS.providerListModels,
  ])("permits read %s", (method) => {
    expect(isReadOnlySafeWsMethod(method)).toBe(true);
  });

  // Every one of these mutates server-side state, so a skewed client issuing
  // them would be writing cross-version.
  it.each([
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    ORCHESTRATION_WS_METHODS.importThread,
    ORCHESTRATION_WS_METHODS.repairState,
    ORCHESTRATION_WS_METHODS.reconcileProviderDelivery,
    WS_METHODS.projectsWriteFile,
    WS_METHODS.gitCheckout,
    WS_METHODS.gitRunStackedAction,
    WS_METHODS.gitCreateBranch,
    WS_METHODS.serverUpdateSettings,
    WS_METHODS.serverUpdateProvider,
    WS_METHODS.terminalOpen,
    WS_METHODS.terminalWrite,
    WS_METHODS.automationCreate,
    WS_METHODS.automationRunNow,
    WS_METHODS.pullRequestsAction,
  ])("refuses write %s", (method) => {
    expect(isReadOnlySafeWsMethod(method)).toBe(false);
  });

  it("refuses an unknown method by default", () => {
    expect(isReadOnlySafeWsMethod("some.future.method")).toBe(false);
  });

  it("never allowlists a method whose name marks it as a mutation", () => {
    const mutationPrefixes = [
      "create",
      "update",
      "delete",
      "write",
      "run",
      "dispatch",
      "stop",
      "revoke",
      "upsert",
      "import",
      "repair",
    ];
    for (const method of READ_ONLY_SAFE_WS_METHODS) {
      const operation = method.slice(method.indexOf(".") + 1).toLowerCase();
      for (const prefix of mutationPrefixes) {
        expect(operation.startsWith(prefix), `${method} looks like a mutation`).toBe(false);
      }
    }
  });
});
