// FILE: startInPickerModel.test.ts
// Purpose: Proves the "Start in" picker can never offer one host's folders under
//          another host, and refuses explicitly instead of substituting local.
// Layer: Chat composer logic tests

import { EnvironmentId, ProjectId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { EnvironmentDirectoryEntry } from "../../environmentDirectory";
import { LOCAL_ENVIRONMENT_ID } from "../../environmentIdentity";
import {
  buildStartInEnvironmentOptions,
  filterStartInOptions,
  projectEnvironmentId,
  resolveStartInSelection,
  startInEnvironmentNote,
  type StartInProject,
} from "./startInPickerModel";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");
const LOCAL_PROJECT_ID = ProjectId.makeUnsafe("project-local");
const REMOTE_PROJECT_ID = ProjectId.makeUnsafe("project-remote");

const PROJECTS: readonly StartInProject[] = [
  { id: LOCAL_PROJECT_ID, name: "laptop-app", cwd: "/Users/me/laptop-app" },
  { id: REMOTE_PROJECT_ID, name: "vps-service", cwd: "/srv/vps-service" },
];

function environment(
  overrides: Partial<EnvironmentDirectoryEntry> & Pick<EnvironmentDirectoryEntry, "environmentId">,
): EnvironmentDirectoryEntry {
  return {
    label: overrides.environmentId,
    isLocal: overrides.environmentId === LOCAL_ENVIRONMENT_ID,
    reachability: "reachable",
    wsUrl: null,
    descriptor: null,
    ...overrides,
  };
}

const ENVIRONMENTS: readonly EnvironmentDirectoryEntry[] = [
  environment({ environmentId: LOCAL_ENVIRONMENT_ID, label: "This computer" }),
  environment({
    environmentId: REMOTE_ENVIRONMENT_ID,
    label: "prod-vps",
    wsUrl: "wss://vps.example.com/ws",
  }),
];

const OWNERSHIP = { [REMOTE_PROJECT_ID]: REMOTE_ENVIRONMENT_ID } as const;

describe("project ownership", () => {
  it("treats an unmapped project as local so single-server installs need no migration", () => {
    expect(projectEnvironmentId(LOCAL_PROJECT_ID, {})).toBe(LOCAL_ENVIRONMENT_ID);
    expect(projectEnvironmentId(LOCAL_PROJECT_ID, undefined)).toBe(LOCAL_ENVIRONMENT_ID);
  });
});

describe("building start-in options", () => {
  it("lists each environment with only its OWN projects", () => {
    const options = buildStartInEnvironmentOptions({
      environments: ENVIRONMENTS,
      projects: PROJECTS,
      projectOwnership: OWNERSHIP,
    });

    const local = options.find((option) => option.isLocal);
    const remote = options.find((option) => !option.isLocal);
    expect(local?.projects.map((project) => project.id)).toEqual([LOCAL_PROJECT_ID]);
    expect(remote?.projects.map((project) => project.id)).toEqual([REMOTE_PROJECT_ID]);
  });

  it("shows an unreachable host but refuses to make it selectable", () => {
    const options = buildStartInEnvironmentOptions({
      environments: [
        ENVIRONMENTS[0] as EnvironmentDirectoryEntry,
        environment({ environmentId: REMOTE_ENVIRONMENT_ID, reachability: "unreachable" }),
      ],
      projects: PROJECTS,
      projectOwnership: OWNERSHIP,
    });
    const remote = options.find((option) => !option.isLocal);
    // Hiding it would look like the host was forgotten; enabling it would queue
    // a dispatch that cannot land.
    expect(remote).toBeDefined();
    expect(remote?.selectable).toBe(false);
    expect(remote?.disabledReason).toContain("Settings");
  });

  it("distinguishes 'still connecting' from 'unreachable'", () => {
    const options = buildStartInEnvironmentOptions({
      environments: [
        environment({ environmentId: REMOTE_ENVIRONMENT_ID, reachability: "checking" }),
      ],
      projects: PROJECTS,
      projectOwnership: OWNERSHIP,
    });
    expect(options[0]?.selectable).toBe(false);
    expect(options[0]?.disabledReason).toBe("Connecting…");
  });
});

describe("resolving a selection", () => {
  const options = buildStartInEnvironmentOptions({
    environments: ENVIRONMENTS,
    projects: PROJECTS,
    projectOwnership: OWNERSHIP,
  });
  const remote = options.find((option) => !option.isLocal) as ReturnType<
    typeof buildStartInEnvironmentOptions
  >[number];
  const local = options.find((option) => option.isLocal) as typeof remote;

  it("carries the chosen environment id alongside the project", () => {
    const result = resolveStartInSelection({ option: remote, projectId: REMOTE_PROJECT_ID });
    expect(result).toEqual({
      target: { environmentId: REMOTE_ENVIRONMENT_ID, projectId: REMOTE_PROJECT_ID },
    });
  });

  it("refuses a project that belongs to a different host instead of substituting local", () => {
    // The wrong-machine failure this exists to prevent: picking the laptop's
    // folder under the VPS would create a thread at a path the VPS lacks.
    const result = resolveStartInSelection({ option: remote, projectId: LOCAL_PROJECT_ID });
    expect(result).not.toHaveProperty("target");
    expect(result).toHaveProperty("refusal");
    if ("refusal" in result) {
      expect(result.refusal.description).toContain("prod-vps");
    }
  });

  it("refuses when the host is unreachable, naming the next action", () => {
    const unreachable = buildStartInEnvironmentOptions({
      environments: [
        environment({
          environmentId: REMOTE_ENVIRONMENT_ID,
          label: "prod-vps",
          reachability: "unreachable",
        }),
      ],
      projects: PROJECTS,
      projectOwnership: OWNERSHIP,
    })[0];
    const result = resolveStartInSelection({
      option: unreachable as typeof remote,
      projectId: REMOTE_PROJECT_ID,
    });
    expect(result).toHaveProperty("refusal");
    if ("refusal" in result) {
      // Says what to do, not merely what failed.
      expect(result.refusal.description).toMatch(/ssh|Remote hosts/);
    }
  });

  it("still resolves a plain local selection", () => {
    expect(resolveStartInSelection({ option: local, projectId: LOCAL_PROJECT_ID })).toEqual({
      target: { environmentId: LOCAL_ENVIRONMENT_ID, projectId: LOCAL_PROJECT_ID },
    });
  });
});

describe("the remote-host note", () => {
  const options = buildStartInEnvironmentOptions({
    environments: ENVIRONMENTS,
    projects: PROJECTS,
    projectOwnership: OWNERSHIP,
  });
  const remote = options.find((option) => !option.isLocal) as ReturnType<
    typeof buildStartInEnvironmentOptions
  >[number];
  const local = options.find((option) => option.isLocal) as typeof remote;

  it("tells the user which actions do NOT follow the chat to a remote host", () => {
    // cwd-keyed calls (git, file writes) still run locally — see issue #25. The
    // note is the only thing standing between the user and a file edited on the
    // wrong machine, so it must name the host and both halves of the split.
    const note = startInEnvironmentNote(remote);
    expect(note).toContain(remote.label);
    expect(note).toContain("Chats and terminals run there");
    expect(note).toContain("file and Git actions still run on this computer");
  });

  it("says nothing for This computer", () => {
    // The absence is the load-bearing half: on the local host everything really
    // does run in one place, and a note that is always on is a note nobody
    // reads. If this ever starts returning a string, the note becomes noise and
    // stops being read on the remote host where it matters.
    expect(startInEnvironmentNote(local)).toBeNull();
  });
});

describe("filtering", () => {
  const options = buildStartInEnvironmentOptions({
    environments: ENVIRONMENTS,
    projects: PROJECTS,
    projectOwnership: OWNERSHIP,
  });

  it("keeps a whole environment when its label matches", () => {
    const filtered = filterStartInOptions(options, "prod");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.projects).toHaveLength(1);
  });

  it("narrows to matching projects without leaking them across environments", () => {
    const filtered = filterStartInOptions(options, "vps-service");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.environmentId).toBe(REMOTE_ENVIRONMENT_ID);
  });

  it("drops environments with no match at all", () => {
    expect(filterStartInOptions(options, "nothing-matches-this")).toHaveLength(0);
  });
});
