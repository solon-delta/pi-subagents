import { basename } from "node:path";

export type SystemPromptMode = "append" | "replace";

export interface AgentDefinition {
  /** Agent name, from the frontmatter or from the file stem. */
  name: string;
  description: string;
  /** Tool names the child may use. An empty list means no tools. */
  tools: string[];
  /** Skill names the child may use. An empty list means no skills. */
  skills: string[];
  /** Model pattern, or undefined to let the child pick its own default. */
  model: string | undefined;
  /** Depth limit of the tree below this agent, or undefined to inherit it. */
  maxDepth: number | undefined;
  systemPromptMode: SystemPromptMode;
  /** The markdown body. */
  systemPrompt: string;
  file: string;
}

// ponytail: a small YAML subset, scalars and lists. Add a YAML parser when an
// agent file needs nested maps.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const FIELD = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/;
const LIST_ITEM = /^[ \t]*-[ \t]*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(trimmed);
  return quoted === null ? trimmed : (quoted[1] ?? quoted[2]);
}

function parseInlineList(value: string): string[] {
  const items = value.trim().slice(1, -1).split(",");
  return items.map(unquote).filter((item) => item !== "");
}

function parseFields(block: string, file: string): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  let listKey: string | null = null;

  for (const line of block.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const item = LIST_ITEM.exec(line);
    if (item !== null && listKey !== null) {
      const list = fields.get(listKey);
      if (Array.isArray(list)) list.push(unquote(item[1]));
      continue;
    }

    const field = FIELD.exec(line);
    if (field === null) throw new Error(`Bad frontmatter line "${line.trim()}" in ${file}`);

    const [, key, value] = field;
    if (value.trim() === "") {
      fields.set(key, []);
      listKey = key;
      continue;
    }
    listKey = null;
    fields.set(key, value.trim().startsWith("[") ? parseInlineList(value) : unquote(value));
  }

  return fields;
}

function singleValue(
  fields: Map<string, string | string[]>,
  key: string,
  file: string,
): string | undefined {
  const value = fields.get(key);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new Error(`Key "${key}" must be a single value in ${file}`);
  return value;
}

function depthValue(value: string | undefined, file: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  // The settings file takes one or more too. A zero here would refuse every
  // launch below this agent for ever, which the file cannot say by accident.
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Key "maxDepth" must be a whole number of one or more in ${file}`);
  }
  return parsed;
}

function promptMode(value: string | undefined, file: string): SystemPromptMode {
  if (value === undefined || value === "replace") return "replace";
  if (value === "append") return "append";
  throw new Error(`Key "systemPromptMode" must be "replace" or "append" in ${file}`);
}

/** Read one agent markdown file. Throws an error that names the file when it is unusable. */
export function parseAgentFile(file: string, text: string): AgentDefinition {
  const match = FRONTMATTER.exec(text);
  if (match === null) throw new Error(`No frontmatter block in ${file}`);

  const fields = parseFields(match[1], file);
  const tools = fields.get("tools");
  if (tools === undefined) throw new Error(`Key "tools" is required in ${file}`);
  if (!Array.isArray(tools)) throw new Error(`Key "tools" must be a list in ${file}`);

  // A missing skills key names no skill. A missing tools key is an error, but a
  // file that says nothing about skills asks for none, which is the safe side.
  const skills = fields.get("skills") ?? [];
  if (!Array.isArray(skills)) throw new Error(`Key "skills" must be a list in ${file}`);

  return {
    name: singleValue(fields, "name", file) ?? basename(file, ".md"),
    description: singleValue(fields, "description", file) ?? "",
    tools,
    skills,
    model: singleValue(fields, "model", file),
    maxDepth: depthValue(singleValue(fields, "maxDepth", file), file),
    systemPromptMode: promptMode(singleValue(fields, "systemPromptMode", file), file),
    systemPrompt: text.slice(match[0].length).trim(),
    file,
  };
}
