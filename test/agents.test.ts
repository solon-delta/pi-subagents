import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { agentCatalogue, discoverAgents } from "../src/agents.ts";
import { DEFAULTS, type Settings } from "../src/settings.ts";

function writeAgents(dir: string, files: string[]): string {
  mkdirSync(dir, { recursive: true });
  for (const name of files) {
    writeFileSync(
      join(dir, `${name}.md`),
      `---\ndescription: ${name}\ntools: [read]\n---\n${name}\n`,
    );
  }
  return dir;
}

/** A directory of agent files. It is a root only through the extra directories. */
function agentDir(...files: string[]): string {
  return writeAgents(mkdtempSync(join(tmpdir(), "agents-")), files);
}

const PROJECT_ROOT = join(CONFIG_DIR_NAME, "agents");
const USER_ROOT = join(CONFIG_DIR_NAME, "agent", "agents");

/** A project tree or a home tree that carries its agent files at `root`. */
function tree(root: string, ...files: string[]): string {
  const base = mkdtempSync(join(tmpdir(), "tree-"));
  writeAgents(join(base, root), files);
  return base;
}

/** A directory that does not exist, for a test that wants no agents from it. */
const NOWHERE = join(tmpdir(), "no-such-tree");

function settings(defaultModel: string | undefined, agentDirs: string[] = []): Settings {
  return { ...DEFAULTS, defaultModel, agentDirs };
}

test("the project root shadows the user root", () => {
  const project = tree(PROJECT_ROOT, "reviewer");
  const home = tree(USER_ROOT, "reviewer", "scout");

  const catalogue = agentCatalogue(settings(undefined), project, home);

  assert.equal(catalogue.get("reviewer").file, join(project, PROJECT_ROOT, "reviewer.md"));
  assert.equal(catalogue.get("scout").file, join(home, USER_ROOT, "scout.md"));
});

test("the extra agent directories are searched after the user root", () => {
  const home = tree(USER_ROOT, "scout");
  const extra = agentDir("scout", "surveyor");
  const catalogue = agentCatalogue(settings(undefined, [extra]), NOWHERE, home);

  assert.equal(catalogue.get("scout").file, join(home, USER_ROOT, "scout.md"));
  assert.equal(catalogue.get("surveyor").file, join(extra, "surveyor.md"));
});

test("an agent without a model key takes the default model", () => {
  const home = tree(USER_ROOT, "scout");

  const agent = agentCatalogue(settings("anthropic/claude-haiku-4-5"), NOWHERE, home).get("scout");

  assert.equal(agent.model, "anthropic/claude-haiku-4-5");
});

test("an agent with a model key keeps it", () => {
  const home = tree(USER_ROOT);
  writeFileSync(
    join(home, USER_ROOT, "scout.md"),
    "---\ndescription: d\ntools: [read]\nmodel: openai/gpt-5\n---\nBody.\n",
  );

  const agent = agentCatalogue(settings("anthropic/claude-haiku-4-5"), NOWHERE, home).get("scout");

  assert.equal(agent.model, "openai/gpt-5");
});

test("a project file shadows a user file of the same name", () => {
  const project = agentDir("reviewer");
  const user = agentDir("reviewer", "scout");

  const agents = discoverAgents([project, user]);

  assert.deepEqual([...agents.keys()].sort(), ["reviewer", "scout"]);
});

test("a missing root is skipped", () => {
  const agents = discoverAgents([join(tmpdir(), "no-such-agent-root"), agentDir("scout")]);

  assert.deepEqual([...agents.keys()], ["scout"]);
});

test("an unknown agent name fails with the available names", () => {
  const catalogue = agentCatalogue(
    settings(undefined, [agentDir("reviewer", "scout")]),
    NOWHERE,
    NOWHERE,
  );

  assert.throws(() => catalogue.get("typo"), /typo.*reviewer, scout/s);
});

test("the frontmatter name selects the agent, not the file stem", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(
    join(root, "reviewer.md"),
    "---\nname: strict-reviewer\ndescription: d\ntools: [read]\n---\nBody.\n",
  );

  const agents = discoverAgents([root]);

  assert.deepEqual([...agents.keys()], ["strict-reviewer"]);
  assert.equal(
    agentCatalogue(settings(undefined, [root]), NOWHERE, NOWHERE).get("strict-reviewer").name,
    "strict-reviewer",
  );
});

test("an unusable file is listed under its stem and fails on launch", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(join(root, "broken.md"), "---\ndescription: d\n---\nNo tools key.\n");

  const agents = discoverAgents([root]);

  assert.deepEqual([...agents.keys()], ["broken"]);
  assert.ok(agents.get("broken") instanceof Error);
  assert.throws(
    () => agentCatalogue(settings(undefined, [root]), NOWHERE, NOWHERE).get("broken"),
    /tools.*broken\.md/s,
  );
});

test("the bundled root ships a usable agent", () => {
  const agent = agentCatalogue(settings(undefined), NOWHERE, NOWHERE).get("explorer");

  assert.equal(agent.name, "explorer");
  assert.ok(agent.tools.includes("read"));
  assert.ok(agent.systemPrompt.length > 0);
});

test("a known agent name is parsed from its file", () => {
  const catalogue = agentCatalogue(settings(undefined, [agentDir("scout")]), NOWHERE, NOWHERE);

  assert.equal(catalogue.get("scout").description, "scout");
});
