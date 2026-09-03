import type { AgentDefinition } from "./agent-file.ts";

/** Depth of this process. A session that the user started has none. */
export const DEPTH_VAR = "PI_SUBAGENTS_DEPTH";
/** Depth limit of this process. It overrides the settings file. */
export const LIMIT_VAR = "PI_SUBAGENTS_MAX_DEPTH";
/** Tool names this process may grant. No variable means no ceiling. */
export const CEILING_VAR = "PI_SUBAGENTS_TOOL_CEILING";

/** What the current pi process inherited from the process that started it. */
export interface Nesting {
  /** Zero for a session that the user started. Every child adds one. */
  depth: number;
  /** The depth at which a launch is refused. */
  limit: number;
  /** Tool names this process may grant, or undefined for a root process. */
  ceiling: string[] | undefined;
}

/** The nesting of one child, and the variables that carry it to that child. */
export interface ChildNesting {
  depth: number;
  limit: number;
  /** The tool list of the child, after the ceiling of the parent. */
  tools: string[];
  /** Tool names of the agent file that the ceiling removed. */
  removed: string[];
  /** The three values that the child process inherits. */
  env: Record<string, string>;
}

/** A whole number of zero or more, or the fallback when the text is unusable. */
function wholeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function toolNames(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/**
 * Read the nesting of this process. The limit comes from the environment, then
 * from the configuration, which itself falls back to the default of three.
 */
export function inheritedNesting(env: NodeJS.ProcessEnv, configuredLimit: number): Nesting {
  const ceiling = env[CEILING_VAR];
  return {
    depth: wholeNumber(env[DEPTH_VAR], 0),
    limit: wholeNumber(env[LIMIT_VAR], configuredLimit),
    ceiling: ceiling === undefined ? undefined : toolNames(ceiling),
  };
}

/**
 * The nesting of one child. Throws when the depth refuses the launch, before
 * the run leaves anything on disk. The ceiling of the parent narrows the tool
 * list of the agent file and never widens it, and the result is the ceiling of
 * the child. A removed tool does not fail the launch. An agent that names a
 * skill asks for the read tool on top of its list.
 */
export function childNesting(parent: Nesting, agent: AgentDefinition): ChildNesting {
  if (parent.depth >= parent.limit) {
    throw new Error(
      `Subagent depth ${parent.depth} is at or above the limit of ${parent.limit}. ` +
        `Agent "${agent.name}" was not started.`,
    );
  }

  const ceiling = parent.ceiling;
  // A skill is a file that the child opens for itself, so an agent with a skill
  // asks for the read tool, whether or not its file names it. The ceiling below
  // may still take it away, and `removed` stays the answer for the agent file.
  const wanted =
    agent.skills.length === 0 || agent.tools.includes("read")
      ? agent.tools
      : [...agent.tools, "read"];
  const tools = ceiling === undefined ? wanted : wanted.filter((tool) => ceiling.includes(tool));
  // The agent file may only lower the limit of the tree below the child.
  const limit = Math.min(parent.limit, agent.maxDepth ?? parent.limit);
  const depth = parent.depth + 1;

  return {
    depth,
    limit,
    tools,
    removed: agent.tools.filter((tool) => !tools.includes(tool)),
    env: {
      [DEPTH_VAR]: String(depth),
      [LIMIT_VAR]: String(limit),
      [CEILING_VAR]: tools.join(","),
    },
  };
}
