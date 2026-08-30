import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
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

const FILE_NAME = "pi-subagents.json";

/**
 * The settings files, in rising order of precedence: the user file, then the
 * project file. The project file is read only when the user trusts the project,
 * because a repository must not raise a limit without consent.
 */
export function settingsFiles(agentDir: string, cwd: string, projectTrusted: boolean): string[] {
  const user = join(agentDir, FILE_NAME);
  if (!projectTrusted) return [user];
  return [user, join(cwd, CONFIG_DIR_NAME, FILE_NAME)];
}

type FileValues = Static<typeof SettingsFile>;

interface ReadFile {
  values: FileValues;
  warning: string | undefined;
}

/** Read one file. A missing file and an unusable file both give no values. */
function readFile(file: string): ReadFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { values: {}, warning: undefined };
  }

  const ignore = (reason: string): ReadFile => ({
    values: {},
    warning: `Ignored ${file}: ${reason}.`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ignore("the file is not valid JSON");
  }

  if (!Value.Check(SettingsFile, parsed)) {
    return ignore(Value.Errors(SettingsFile, parsed)[0]?.message ?? "a key has a wrong value");
  }
  return { values: parsed, warning: undefined };
}

/**
 * Read the settings files. A later file overrides an earlier one, key by key. A
 * missing file gives the defaults in silence. A file that pi cannot use gives a
 * warning and drops out, so a typo never blocks a session.
 */
export function loadSettings(files: string[]): LoadedSettings {
  const warnings: string[] = [];
  let values: FileValues = {};

  for (const file of files) {
    const read = readFile(file);
    if (read.warning !== undefined) warnings.push(read.warning);
    values = { ...values, ...read.values };
  }

  return {
    settings: {
      maxDepth: values.maxDepth ?? DEFAULTS.maxDepth,
      maxConcurrency: values.maxConcurrency ?? DEFAULTS.maxConcurrency,
      timeoutMinutes: values.timeoutMinutes ?? DEFAULTS.timeoutMinutes,
      defaultModel: values.defaultModel ?? DEFAULTS.defaultModel,
      agentDirs: (values.agentDirs ?? DEFAULTS.agentDirs).map(expandHome),
    },
    warning: warnings.length === 0 ? undefined : warnings.join(" "),
  };
}

/** The agent with the configured model, when its own file names none. */
export function withDefaultModel(
  agent: AgentDefinition,
  defaultModel: string | undefined,
): AgentDefinition {
  return { ...agent, model: agent.model ?? defaultModel };
}
