import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { type AgentDefinition, parseAgentFile } from "./agent-file.ts";
import type { Settings } from "./settings.ts";

/**
 * The roots, in shadowing order: project, user, the configured extra roots,
 * bundled.
 */
function agentRoots(cwd: string, home: string, extra: string[]): string[] {
  return [
    join(cwd, CONFIG_DIR_NAME, "agents"),
    join(home, CONFIG_DIR_NAME, "agent", "agents"),
    ...extra,
    fileURLToPath(new URL("../agents", import.meta.url)),
  ];
}

/** One discovered agent file, and the root directory that carries it. */
export interface FoundAgent {
  /** The definition, or the error that the file produced. */
  parsed: AgentDefinition | Error;
  root: string;
}

/**
 * Map an agent name to its file, or to the error that its file produced. An
 * earlier root shadows a later one. An unusable file keeps its file stem, so it
 * stays visible in the list and the launch reports the real error.
 */
export function discoverAgentFiles(roots: string[]): Map<string, FoundAgent> {
  const agents = new Map<string, FoundAgent>();

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
      let name: string;
      let found: AgentDefinition | Error;
      try {
        found = parseAgentFile(file, readFileSync(file, "utf8"));
        name = found.name;
      } catch (error) {
        found = error instanceof Error ? error : new Error(String(error));
        name = basename(file, ".md");
      }
      if (!agents.has(name)) agents.set(name, { parsed: found, root });
    }
  }

  return agents;
}

/** One row of the agent list command. */
export interface AgentEntry {
  name: string;
  /** Tool names of the file, or undefined when the file is unusable. */
  tools: string[] | undefined;
  /** The message of an unusable file, or undefined when the file is fine. */
  error: string | undefined;
  /** The root directory that carries the file. */
  root: string;
}

export interface AgentCatalogue {
  /** The agent of that name. An unknown name and an unusable file throw. */
  get(name: string): AgentDefinition;
  /** Every discovered agent, sorted by name, for the list command. */
  entries(): AgentEntry[];
}

/**
 * Read every root once. The settings give the extra roots and the model of an
 * agent file that names none. An agent file that you write after this call is
 * invisible until the next session.
 */
export function agentCatalogue(settings: Settings, cwd: string, home: string): AgentCatalogue {
  const agents = discoverAgentFiles(agentRoots(cwd, home, settings.agentDirs));

  return {
    get(name) {
      const agent = agents.get(name);
      if (agent === undefined) {
        const available = [...agents.keys()].sort().join(", ");
        throw new Error(`Unknown agent "${name}". Available agents: ${available}`);
      }
      const found = agent.parsed;
      if (found instanceof Error) throw found;
      return { ...found, model: found.model ?? settings.defaultModel };
    },

    entries() {
      const rows = [...agents].map(([name, agent]) => ({
        name,
        tools: agent.parsed instanceof Error ? undefined : agent.parsed.tools,
        error: agent.parsed instanceof Error ? agent.parsed.message : undefined,
        root: agent.root,
      }));
      return rows.sort((one, other) => one.name.localeCompare(other.name));
    },
  };
}
