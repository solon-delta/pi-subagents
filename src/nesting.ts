import type { AgentDefinition } from "./agent-file.ts";

/** Depth of this process. A session that the user started has none. */
export const DEPTH_VAR = "PI_SUBAGENTS_DEPTH";
/** Depth limit of this process. It overrides the settings file. */
export const LIMIT_VAR = "PI_SUBAGENTS_MAX_DEPTH";

/**
 * One tool of the live tool list of this process, with the file that provides
 * it. pi marks a tool without a file with angle brackets: `<builtin:read>`,
 * `<sdk:name>`, `<inline:name>`.
 */
export interface ToolSource {
  name: string;
  path: string;
}

/** What the current pi process inherited from the process that started it. */
export interface Nesting {
  /** Zero for a session that the user started. Every child adds one. */
  depth: number;
  /** The depth at which a launch is refused. */
  limit: number;
}

/** The nesting of one child, and the variables that carry it to that child. */
export interface ChildNesting {
  depth: number;
  limit: number;
  /** The tool list of the child, after the live list of the parent. */
  tools: string[];
  /** Tool names of the agent file that the live list removed. */
  removed: string[];
  /** The extension file of each granted tool, once per file. */
  extensions: string[];
  /** The two values that the child process inherits. */
  env: Record<string, string>;
}

/** A whole number of zero or more, or the fallback when the text is unusable. */
function wholeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Read the nesting of this process. The limit comes from the environment, then
 * from the configuration, which itself falls back to the default of three.
 */
export function inheritedNesting(env: NodeJS.ProcessEnv, configuredLimit: number): Nesting {
  return {
    depth: wholeNumber(env[DEPTH_VAR], 0),
    limit: wholeNumber(env[LIMIT_VAR], configuredLimit),
  };
}

/**
 * The nesting of one child. Throws when the depth refuses the launch, before
 * the run leaves anything on disk. The live tool list of this process narrows
 * the tool list of the agent file and never widens it, so a child is never
 * stronger than its parent. pi narrows that live list for every child it
 * starts, so the list is the ceiling that the parent of this process granted.
 *
 * A root session names every tool it has, so a typo there fails the launch. A
 * child of a subagent may lose a tool that its parent lacks, and that name goes
 * to `removed` instead. An agent that names a skill asks for the read tool on
 * top of its list, and a list without that read tool refuses the launch.
 */
export function childNesting(
  parent: Nesting,
  agent: AgentDefinition,
  available: ToolSource[],
): ChildNesting {
  if (parent.depth >= parent.limit) {
    throw new Error(
      `Subagent depth ${parent.depth} is at or above the limit of ${parent.limit}. ` +
        `Agent "${agent.name}" was not started.`,
    );
  }

  // A skill is a file that the child opens for itself, so an agent with a skill
  // asks for the read tool, whether or not its file names it. The list below
  // may still take it away, and `removed` stays the answer for the agent file.
  const wanted =
    agent.skills.length === 0 || agent.tools.includes("read")
      ? agent.tools
      : [...agent.tools, "read"];

  const tools: string[] = [];
  const removed: string[] = [];
  const files = new Set<string>();
  for (const name of wanted) {
    const source = available.find((tool) => tool.name === name);
    if (source === undefined) {
      // A root session sees every tool of the user, so a name that its file
      // names and this session lacks is a typo. Deeper down the same name may
      // be one the parent lost, and dropping it is what this module is for.
      // The read tool of a skill is not a name of the file, so it drops here
      // and takes the message of the skill check below.
      if (parent.depth === 0 && agent.tools.includes(name)) {
        throw new Error(
          `Unknown tool "${name}" in agent "${agent.name}". No tool of this session has that name.`,
        );
      }
      removed.push(name);
      continue;
    }

    // pi writes an angle bracket path for a tool that no file provides. Only a
    // built-in one still reaches the child, because the child is the same pi.
    const synthetic = source.path.startsWith("<");
    if (synthetic && !source.path.startsWith("<builtin:")) {
      // The child is a new pi process. It reloads an extension from its file,
      // and a tool without a file cannot travel that way.
      throw new Error(
        `Tool "${name}" in agent "${agent.name}" comes from ${source.path} and has no extension ` +
          "file, so a child process cannot load it. The agent was not started.",
      );
    }

    tools.push(name);
    if (!synthetic) files.add(source.path);
  }

  // The child opens a skill file for itself. A parent that lost the read tool
  // would leave it a block it cannot use, so the launch fails instead of
  // starting an agent without the instructions it needs.
  if (agent.skills.length > 0 && !tools.includes("read")) {
    throw new Error(
      `Agent "${agent.name}" names skills, but this process may not grant the read tool, ` +
        "so the child could not open them. The agent was not started.",
    );
  }

  // The agent file may only lower the limit of the tree below the child.
  const limit = Math.min(parent.limit, agent.maxDepth ?? parent.limit);
  const depth = parent.depth + 1;

  return {
    depth,
    limit,
    tools,
    removed: agent.tools.filter((tool) => !tools.includes(tool)),
    extensions: [...files],
    env: {
      [DEPTH_VAR]: String(depth),
      [LIMIT_VAR]: String(limit),
    },
  };
}
