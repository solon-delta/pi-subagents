import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAgentFile } from "../src/agent-file.ts";

const file = "/agents/reviewer.md";

test("frontmatter supplies name, description, tools, model and mode", () => {
  const agent = parseAgentFile(
    file,
    `---
name: reviewer
description: Reviews a diff
tools: [read, grep]
model: anthropic/claude-sonnet-5
systemPromptMode: append
---
You review code.
`,
  );

  assert.equal(agent.name, "reviewer");
  assert.equal(agent.description, "Reviews a diff");
  assert.deepEqual(agent.tools, ["read", "grep"]);
  assert.equal(agent.model, "anthropic/claude-sonnet-5");
  assert.equal(agent.systemPromptMode, "append");
  assert.equal(agent.systemPrompt, "You review code.");
  assert.equal(agent.file, file);
});

test("a block list is read like an inline list", () => {
  const agent = parseAgentFile(
    file,
    `---
description: Reads files
tools:
  - read
  - bash
---
Body.
`,
  );

  assert.deepEqual(agent.tools, ["read", "bash"]);
});

test("a block list without indentation is read too", () => {
  const agent = parseAgentFile(file, "---\ndescription: d\ntools:\n- read\n- bash\n---\nBody.\n");

  assert.deepEqual(agent.tools, ["read", "bash"]);
});

test("the name falls back to the file stem", () => {
  const agent = parseAgentFile(
    "/agents/scout.md",
    `---
description: Finds things
tools: []
---
Body.
`,
  );

  assert.equal(agent.name, "scout");
  assert.deepEqual(agent.tools, []);
});

test("the default system prompt mode is replace", () => {
  const agent = parseAgentFile(file, "---\ndescription: d\ntools: [read]\n---\nBody.\n");

  assert.equal(agent.systemPromptMode, "replace");
  assert.equal(agent.model, undefined);
});

test("a missing tools key fails and names the file", () => {
  assert.throws(
    () => parseAgentFile(file, "---\ndescription: d\n---\nBody.\n"),
    /tools.*\/agents\/reviewer\.md/s,
  );
});

test("a missing frontmatter block fails and names the file", () => {
  assert.throws(() => parseAgentFile(file, "Body only.\n"), /\/agents\/reviewer\.md/);
});

test("an unknown system prompt mode fails and names the file", () => {
  assert.throws(
    () =>
      parseAgentFile(file, "---\ndescription: d\ntools: [read]\nsystemPromptMode: mix\n---\nB\n"),
    /systemPromptMode.*\/agents\/reviewer\.md/s,
  );
});
