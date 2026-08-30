import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { AgentDefinition } from "./agent-file.ts";

export interface Settings {
  /** How deep a chain of subagents may go. */
  maxDepth: number;
  /** How many child runs work at the same time. */
  maxConcurrency: number;
  /** Wall clock limit of one run. */
  timeoutMinutes: number;
  /** Model of an agent file that names none, or undefined for the host default. */
  defaultModel: string | undefined;
  /** Agent directories that are searched with the user root. */
  agentDirs: string[];
}

export const DEFAULTS: Settings = {
  maxDepth: 3,
  maxConcurrency: 4,
  timeoutMinutes: 30,
  defaultModel: undefined,
  agentDirs: [],
};

// An unknown key is left alone. It costs the user nothing, and a future key of
// this extension then does not break an older installation.
const SettingsFile = Type.Object({
  maxDepth: Type.Optional(Type.Integer({ minimum: 1 })),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
  timeoutMinutes: Type.Optional(Type.Number({ minimum: 0 })),
  defaultModel: Type.Optional(Type.String()),
  agentDirs: Type.Optional(Type.Array(Type.String())),
});

export interface LoadedSettings {
  settings: Settings;
  /** Text for the user when the file is unusable, or undefined when it is fine. */
  warning: string | undefined;
}

/** A leading "~" is the home directory. Every other path is left alone. */
function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** The one settings file of this extension, inside the pi agent directory. */
export function settingsFile(agentDir: string): string {
  return join(agentDir, "pi-subagents.json");
}

/**
 * Read the settings file. A missing file gives the defaults in silence. A file
 * that pi cannot use gives the defaults and a warning, so a typo never blocks a
 * session.
 */
export function loadSettings(file: string): LoadedSettings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { settings: DEFAULTS, warning: undefined };
  }

  const defaults = (reason: string): LoadedSettings => ({
    settings: DEFAULTS,
    warning: `Ignored ${file}: ${reason}. The defaults are in use.`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return defaults("the file is not valid JSON");
  }

  if (!Value.Check(SettingsFile, parsed)) {
    return defaults(Value.Errors(SettingsFile, parsed)[0]?.message ?? "a key has a wrong value");
  }
  return {
    settings: {
      maxDepth: parsed.maxDepth ?? DEFAULTS.maxDepth,
      maxConcurrency: parsed.maxConcurrency ?? DEFAULTS.maxConcurrency,
      timeoutMinutes: parsed.timeoutMinutes ?? DEFAULTS.timeoutMinutes,
      defaultModel: parsed.defaultModel ?? DEFAULTS.defaultModel,
      agentDirs: (parsed.agentDirs ?? DEFAULTS.agentDirs).map(expandHome),
    },
    warning: undefined,
  };
}

/** The agent with the configured model, when its own file names none. */
export function withDefaultModel(
  agent: AgentDefinition,
  defaultModel: string | undefined,
): AgentDefinition {
  return { ...agent, model: agent.model ?? defaultModel };
}
