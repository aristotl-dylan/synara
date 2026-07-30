// FILE: startInPickerModel.ts
// Purpose: Pure selection model for the composer's "Start in" picker:
//          environment → that environment's projects → per-project workspace mode.
// Layer: Chat composer logic
// Exports: option building, filtering, and the resolved start target.

import type { EnvironmentId, ProjectId } from "@synara/contracts";

import type { EnvironmentDirectoryEntry } from "../../environmentDirectory";
import { LOCAL_ENVIRONMENT_ID } from "../../environmentIdentity";

export interface StartInProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly cwd: string;
}

export interface StartInEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isLocal: boolean;
  readonly reachability: EnvironmentDirectoryEntry["reachability"];
  /**
   * Projects this environment reported. Empty is a real state for a freshly
   * added host, and reads differently from "unreachable" — the picker says so.
   */
  readonly projects: readonly StartInProject[];
  /**
   * Whether a thread may be started here right now. An unreachable host is
   * shown but not selectable: hiding it would look like the host was forgotten,
   * and enabling it would queue a dispatch that cannot land.
   */
  readonly selectable: boolean;
  /** Why it is not selectable, for the row's secondary line. */
  readonly disabledReason: string | null;
}

/**
 * Which environment a project belongs to. Absent means local, matching the
 * store's "absent means local" ownership rule — so a single-server install has
 * an empty map and every project under "This computer".
 */
export type ProjectOwnershipMap = Readonly<Record<string, string>>;

export function projectEnvironmentId(
  projectId: ProjectId,
  ownership: ProjectOwnershipMap | undefined,
): EnvironmentId {
  return (ownership?.[projectId] as EnvironmentId | undefined) ?? LOCAL_ENVIRONMENT_ID;
}

/**
 * Builds one option per connected environment, each carrying only ITS OWN
 * projects.
 *
 * A project must never appear under an environment that did not report it: the
 * user would pick a directory the chosen host does not have, and the thread
 * would be created against a path that does not exist there.
 */
export function buildStartInEnvironmentOptions(input: {
  readonly environments: readonly EnvironmentDirectoryEntry[];
  readonly projects: readonly StartInProject[];
  readonly projectOwnership: ProjectOwnershipMap | undefined;
}): readonly StartInEnvironmentOption[] {
  return input.environments.map((environment) => {
    const projects = input.projects.filter(
      (project) =>
        projectEnvironmentId(project.id, input.projectOwnership) === environment.environmentId,
    );
    const unreachable = environment.reachability === "unreachable";
    const checking = environment.reachability === "checking";
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      isLocal: environment.isLocal,
      reachability: environment.reachability,
      projects,
      selectable: !unreachable && !checking,
      disabledReason: unreachable
        ? "Not reachable — reconnect it in Settings → Remote hosts"
        : checking
          ? "Connecting…"
          : null,
    };
  });
}

export interface StartInTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface StartInRefusal {
  readonly title: string;
  readonly description: string;
}

/**
 * Resolves a click into a start target, or an explicit refusal.
 *
 * Returning a refusal rather than silently substituting the local environment
 * is the whole point: a substituted environment starts the user's work on the
 * wrong machine and looks like it succeeded.
 */
export function resolveStartInSelection(input: {
  readonly option: StartInEnvironmentOption;
  readonly projectId: ProjectId;
}): { readonly target: StartInTarget } | { readonly refusal: StartInRefusal } {
  if (!input.option.selectable) {
    return {
      refusal: {
        title: `Cannot start a chat on ${input.option.label}`,
        description:
          input.option.reachability === "checking"
            ? `Synara is still connecting to ${input.option.label}. Wait for it to come online, then start the chat again.`
            : `Synara cannot reach ${input.option.label} right now. Check that the machine is awake and that \`ssh\` to it still works, then reconnect it from Settings → Remote hosts.`,
      },
    };
  }
  if (!input.option.projects.some((project) => project.id === input.projectId)) {
    return {
      refusal: {
        title: "That folder is not on this host",
        description: `${input.option.label} has not reported this project, so a chat started there would point at a path it does not have. Pick one of ${input.option.label}'s own folders, or add the folder on ${input.option.label} first.`,
      },
    };
  }
  return { target: { environmentId: input.option.environmentId, projectId: input.projectId } };
}

/** Case-insensitive filter over environment labels and their project names. */
export function filterStartInOptions(
  options: readonly StartInEnvironmentOption[],
  query: string,
): readonly StartInEnvironmentOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return options;
  return options.flatMap((option) => {
    if (option.label.toLowerCase().includes(needle)) return [option];
    const projects = option.projects.filter(
      (project) =>
        project.name.toLowerCase().includes(needle) || project.cwd.toLowerCase().includes(needle),
    );
    return projects.length > 0 ? [{ ...option, projects }] : [];
  });
}
