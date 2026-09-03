import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { discoverSkills, skillCatalogue } from "../src/skills.ts";

/** One directory per skill, each with the `SKILL.md` that pi looks for. */
function writeSkills(dir: string, names: string[]): string {
  for (const name of names) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\nBody.\n`,
    );
  }
  return dir;
}

const PROJECT_ROOT = join(CONFIG_DIR_NAME, "skills");
const USER_ROOT = join(CONFIG_DIR_NAME, "agent", "skills");

/** A project tree or a home tree that carries its skills at `root`. */
function tree(root: string, ...names: string[]): string {
  const base = mkdtempSync(join(tmpdir(), "tree-"));
  writeSkills(join(base, root), names);
  return base;
}

/** A directory that does not exist, for a test that wants no skills from it. */
const NOWHERE = join(tmpdir(), "no-such-skill-tree");

test("the project root shadows the user root", () => {
  const project = tree(PROJECT_ROOT, "review");
  const home = tree(USER_ROOT, "review", "search");

  const block = skillCatalogue(project, home).promptBlock(["review", "search"], "reviewer");

  assert.ok(block.includes(join(project, PROJECT_ROOT, "review", "SKILL.md")));
  assert.ok(!block.includes(join(home, USER_ROOT, "review", "SKILL.md")));
  assert.ok(block.includes(join(home, USER_ROOT, "search", "SKILL.md")));
});

test("a missing root is skipped", () => {
  const home = tree(USER_ROOT, "review");

  const skills = discoverSkills([NOWHERE, join(home, USER_ROOT)]);

  assert.deepEqual([...skills.keys()], ["review"]);
});

test("the block names the skill, its description and its file", () => {
  const project = tree(PROJECT_ROOT, "review");

  const block = skillCatalogue(project, NOWHERE).promptBlock(["review"], "reviewer");

  assert.ok(block.includes("<name>review</name>"));
  assert.ok(block.includes("<description>The review skill.</description>"));
  assert.ok(
    block.includes(`<location>${join(project, PROJECT_ROOT, "review", "SKILL.md")}</location>`),
  );
});

test("only the named skills reach the block", () => {
  const project = tree(PROJECT_ROOT, "review", "search");

  const block = skillCatalogue(project, NOWHERE).promptBlock(["review"], "reviewer");

  assert.ok(block.includes("<name>review</name>"));
  assert.ok(!block.includes("<name>search</name>"));
});

test("an agent that names no skill gets no block", () => {
  const project = tree(PROJECT_ROOT, "review");

  assert.equal(skillCatalogue(project, NOWHERE).promptBlock([], "reviewer"), "");
});

test("an unknown skill name fails with the skill, the agent and the available names", () => {
  const catalogue = skillCatalogue(tree(PROJECT_ROOT, "review", "search"), NOWHERE);

  assert.throws(
    () => catalogue.promptBlock(["typo"], "reviewer"),
    /typo.*reviewer.*review, search/s,
  );
});

test("a skill that hides itself from the prompt still reaches the agent that names it", () => {
  const project = tree(PROJECT_ROOT);
  const dir = join(project, PROJECT_ROOT, "review");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: review\ndescription: The review skill.\ndisable-model-invocation: true\n---\nBody.\n",
  );

  const block = skillCatalogue(project, NOWHERE).promptBlock(["review"], "reviewer");

  assert.ok(block.includes("<name>review</name>"));
});
