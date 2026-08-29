import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type AgentDefinition, parseAgentFile } from "./agent-file.ts";

/** The three roots, in shadowing order: project, user, bundled. */
export function agentRoots(cwd: string, home: string): string[] {
  return [
    join(cwd, ".pi", "agents"),
    join(home, ".pi", "agent", "agents"),
    fileURLToPath(new URL("../agents", import.meta.url)),
  ];
}

/** Map an agent name to its file. An earlier root shadows a later one. */
export function discoverAgents(roots: string[]): Map<string, string> {
  const agents = new Map<string, string>();

  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -".md".length);
      if (!agents.has(name)) agents.set(name, join(root, entry.name));
    }
  }

  return agents;
}

export function loadAgent(name: string, agents: Map<string, string>): AgentDefinition {
  const file = agents.get(name);
  if (file === undefined) {
    const available = [...agents.keys()].sort().join(", ");
    throw new Error(`Unknown agent "${name}". Available agents: ${available}`);
  }
  return parseAgentFile(file, readFileSync(file, "utf8"));
}
