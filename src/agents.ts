import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { type AgentDefinition, parseAgentFile } from "./agent-file.ts";

/** The three roots, in shadowing order: project, user, bundled. */
export function agentRoots(cwd: string, home: string): string[] {
  return [
    join(cwd, CONFIG_DIR_NAME, "agents"),
    join(home, CONFIG_DIR_NAME, "agent", "agents"),
    fileURLToPath(new URL("../agents", import.meta.url)),
  ];
}

function agentName(file: string): string {
  try {
    return parseAgentFile(file, readFileSync(file, "utf8")).name;
  } catch {
    // An unusable file keeps its file stem, so it stays visible in the list and
    // the launch reports the real error.
    return basename(file, ".md");
  }
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
      const file = join(root, entry.name);
      const name = agentName(file);
      if (!agents.has(name)) agents.set(name, file);
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
