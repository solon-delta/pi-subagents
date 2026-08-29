import type { AgentDefinition } from "./agent-file.ts";

/**
 * The path of the pi executable. The environment variable is the single test
 * seam: a test points it at a fake pi script.
 */
export function piExecutable(env: NodeJS.ProcessEnv): string {
  return env.PI_SUBAGENTS_PI_BIN ?? "pi";
}

/** The command line of one child run. The task text is always the last argument. */
export function childArguments(agent: AgentDefinition, task: string): string[] {
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
  ];

  if (agent.tools.length === 0) args.push("--no-tools");
  else args.push("--tools", agent.tools.join(","));

  if (agent.model !== undefined) args.push("--model", agent.model);

  if (agent.systemPrompt !== "") {
    const flag = agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt";
    args.push(flag, agent.systemPrompt);
  }

  // `--` stops option parsing, so a task that starts with a dash stays a task.
  args.push("--", task);
  return args;
}
