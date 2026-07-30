import { WS_METHODS } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  authorizeWsMethod,
  LOCAL_ONLY_WS_METHODS,
  OWNER_ONLY_WS_METHODS,
} from "./wsMethodAuthorization";

const loopback = { host: "127.0.0.1", publicUrl: undefined, allowInsecureRemote: false } as const;
const remote = { host: "0.0.0.0", publicUrl: undefined, allowInsecureRemote: false } as const;
const published = {
  host: "127.0.0.1",
  publicUrl: new URL("https://synara.example.test/"),
  allowInsecureRemote: false,
} as const;

describe("owner-only enforcement", () => {
  it("covers every host-administration method", () => {
    // Pinned so a new host-administration method cannot be added to the RPC
    // group without a deliberate decision about its authorization.
    expect([...OWNER_ONLY_WS_METHODS].toSorted()).toEqual(
      [
        WS_METHODS.serverListExternalMcpIntegrations,
        WS_METHODS.serverCreateExternalMcpIntegration,
        WS_METHODS.serverRevokeExternalMcpIntegration,
        WS_METHODS.serverRefreshExternalMcpPairing,
        WS_METHODS.serverUpdateSettings,
        WS_METHODS.serverUpdateProvider,
        WS_METHODS.serverUpsertKeybinding,
        WS_METHODS.serverStopLocalServer,
      ].toSorted(),
    );
  });

  it.each([...OWNER_ONLY_WS_METHODS])("rejects %s for a non-owner client", (method) => {
    const rejection = authorizeWsMethod({ method, role: "client", config: loopback });
    expect(rejection).not.toBeNull();
    expect(rejection?.message).toContain("Owner authorization");
  });

  it.each([...OWNER_ONLY_WS_METHODS])("admits %s for an owner on a local-only bind", (method) => {
    expect(authorizeWsMethod({ method, role: "owner", config: loopback })).toBeNull();
  });
});

describe("local-only enforcement", () => {
  it.each([...LOCAL_ONLY_WS_METHODS])(
    "rejects %s on a remote-reachable bind even for an owner",
    (method) => {
      for (const config of [remote, published, { ...loopback, allowInsecureRemote: true }]) {
        const rejection = authorizeWsMethod({ method, role: "owner", config });
        expect(rejection).not.toBeNull();
        expect(rejection?.message).toContain("loopback-only");
      }
    },
  );

  it("prefers the local-only refusal over the role refusal for a remote client", () => {
    const rejection = authorizeWsMethod({
      method: WS_METHODS.serverCreateExternalMcpIntegration,
      role: "client",
      config: remote,
    });
    expect(rejection?.message).toContain("loopback-only");
  });
});

it("leaves ordinary thread work authorized for a paired client", () => {
  for (const method of [
    WS_METHODS.gitStatus,
    WS_METHODS.serverGetSettings,
    WS_METHODS.terminalWrite,
  ]) {
    expect(authorizeWsMethod({ method, role: "client", config: remote })).toBeNull();
  }
});
