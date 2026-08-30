import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentRoots, discoverAgents, loadAgent } from "../src/agents.ts";

function agentDir(...files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "agents-"));
  mkdirSync(root, { recursive: true });
  for (const name of files) {
    writeFileSync(
      join(root, `${name}.md`),
      `---\ndescription: ${name}\ntools: [read]\n---\n${name}\n`,
    );
  }
  return root;
}

test("the roots are the project root, the user root and the bundled root", () => {
  const roots = agentRoots("/project", "/home/user");

  assert.equal(roots[0], join("/project", ".pi", "agents"));
  assert.equal(roots[1], join("/home/user", ".pi", "agent", "agents"));
  assert.equal(roots.length, 3);
  assert.match(roots[2], /agents$/);
});

test("a project file shadows a user file of the same name", () => {
  const project = agentDir("reviewer");
  const user = agentDir("reviewer", "scout");

  const agents = discoverAgents([project, user]);

  assert.deepEqual([...agents.keys()].sort(), ["reviewer", "scout"]);
  assert.equal(loadAgent("reviewer", [project, user]).file, join(project, "reviewer.md"));
  assert.equal(loadAgent("scout", [project, user]).file, join(user, "scout.md"));
});

test("a missing root is skipped", () => {
  const agents = discoverAgents([join(tmpdir(), "no-such-agent-root"), agentDir("scout")]);

  assert.deepEqual([...agents.keys()], ["scout"]);
});

test("an unknown agent name fails with the available names", () => {
  const roots = [agentDir("reviewer", "scout")];

  assert.throws(() => loadAgent("typo", roots), /typo.*reviewer, scout/s);
});

test("the frontmatter name selects the agent, not the file stem", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(
    join(root, "reviewer.md"),
    "---\nname: strict-reviewer\ndescription: d\ntools: [read]\n---\nBody.\n",
  );

  const agents = discoverAgents([root]);

  assert.deepEqual([...agents.keys()], ["strict-reviewer"]);
  assert.equal(loadAgent("strict-reviewer", [root]).name, "strict-reviewer");
});

test("an unusable file is listed under its stem and fails on launch", () => {
  const root = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(join(root, "broken.md"), "---\ndescription: d\n---\nNo tools key.\n");

  const agents = discoverAgents([root]);

  assert.deepEqual([...agents.keys()], ["broken"]);
  assert.ok(agents.get("broken") instanceof Error);
  assert.throws(() => loadAgent("broken", [root]), /tools.*broken\.md/s);
});

test("the bundled root ships a usable agent", () => {
  const bundled = agentRoots("/project", "/home/user")[2];

  const agent = loadAgent("explorer", [bundled]);

  assert.equal(agent.name, "explorer");
  assert.ok(agent.tools.includes("read"));
  assert.ok(agent.systemPrompt.length > 0);
});

test("a known agent name is parsed from its file", () => {
  assert.equal(loadAgent("scout", [agentDir("scout")]).description, "scout");
});
