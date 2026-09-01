import { fileURLToPath } from "node:url";

/** The extension file of this package. It provides the two subagent tools. */
const SELF = fileURLToPath(new URL("../index.ts", import.meta.url));

/** The tool names that pi provides itself. They need no extension file. */
const BUILT_IN = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
// pi provides the shell tool of the platform. A Linux agent file that names
// powershell would otherwise pass with a tool that the child never gets.
if (process.platform === "win32") BUILT_IN.add("powershell");

/**
 * The tool names that an extension file provides, with the file of each one. A
 * name outside this map and outside BUILT_IN fails the launch, so a typo never
 * gives the child a smaller tool set in silence.
 */
const EXTENSIONS = new Map<string, string>([
  ["subagent", SELF],
  ["subagent_stop", SELF],
]);

/**
 * The tool arguments of one child command. The list carries every name, so the
 * child receives the exact allowlist. Each extension file is named once, even
 * when two tool names come from it. Throws when a name is unknown.
 */
export function toolArguments(tools: string[], agentName: string): string[] {
  if (tools.length === 0) return ["--no-tools"];

  const files = new Set<string>();
  for (const tool of tools) {
    const file = EXTENSIONS.get(tool);
    if (file !== undefined) files.add(file);
    else if (!BUILT_IN.has(tool)) {
      throw new Error(`Unknown tool "${tool}" in agent "${agentName}"`);
    }
  }

  const args = ["--tools", tools.join(",")];
  for (const file of files) args.push("--extension", file);
  return args;
}
