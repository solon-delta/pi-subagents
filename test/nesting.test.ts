import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentDefinition } from "../src/agent-file.ts";
import {
  CEILING_VAR,
  childNesting,
  DEPTH_VAR,
  inheritedNesting,
  LIMIT_VAR,
} from "../src/nesting.ts";

const agent: AgentDefinition = {
  name: "splitter",
  description: "Splits a task",
  tools: ["read", "bash", "subagent"],
  model: undefined,
  maxDepth: undefined,
  systemPromptMode: "replace",
  systemPrompt: "You split a task.",
  file: "/agents/splitter.md",
};

test("a session without the variables is a root at depth zero with no ceiling", () => {
  const parent = inheritedNesting({}, 3);

  assert.deepEqual(parent, { depth: 0, limit: 3, ceiling: undefined });
});

test("the environment overrides the configured limit", () => {
  const parent = inheritedNesting({ [DEPTH_VAR]: "1", [LIMIT_VAR]: "2" }, 7);

  assert.equal(parent.depth, 1);
  assert.equal(parent.limit, 2);
});

test("an unusable environment value falls back to the default", () => {
  const parent = inheritedNesting({ [DEPTH_VAR]: "deep", [LIMIT_VAR]: "" }, 3);

  assert.equal(parent.depth, 0);
  assert.equal(parent.limit, 3);
});

test("a root launch grants every tool of the agent file", () => {
  const child = childNesting({ depth: 0, limit: 3, ceiling: undefined }, agent);

  assert.deepEqual(child.tools, ["read", "bash", "subagent"]);
  assert.deepEqual(child.removed, []);
  assert.equal(child.depth, 1);
  assert.equal(child.env[CEILING_VAR], "read,bash,subagent");
});

test("a ceiling narrows the launch and records what it removed", () => {
  const parent = { depth: 1, limit: 3, ceiling: ["read", "subagent"] };

  const child = childNesting(parent, agent);

  assert.deepEqual(child.tools, ["read", "subagent"]);
  assert.deepEqual(child.removed, ["bash"]);
  assert.equal(child.env[CEILING_VAR], "read,subagent");
});

test("an agent cannot widen the ceiling with a tool the parent lacks", () => {
  const parent = { depth: 1, limit: 3, ceiling: ["read"] };

  const child = childNesting(parent, { ...agent, tools: ["read", "write", "bash"] });

  assert.deepEqual(child.tools, ["read"]);
  assert.deepEqual(child.removed, ["write", "bash"]);
});

test("a launch at the limit is refused and the message names the depth and the limit", () => {
  assert.throws(
    () => childNesting({ depth: 3, limit: 3, ceiling: undefined }, agent),
    (error: Error) => {
      assert.match(error.message, /depth 3/);
      assert.match(error.message, /limit of 3/);
      assert.match(error.message, /splitter/);
      return true;
    },
  );
});

test("the depth of the child is one more than the depth of the parent", () => {
  const child = childNesting({ depth: 1, limit: 3, ceiling: undefined }, agent);

  assert.equal(child.depth, 2);
  assert.equal(child.env[DEPTH_VAR], "2");
});

test("an agent lowers the limit for its own subtree", () => {
  const child = childNesting({ depth: 0, limit: 3, ceiling: undefined }, { ...agent, maxDepth: 1 });

  assert.equal(child.limit, 1);
  assert.equal(child.env[LIMIT_VAR], "1");
});

test("an agent that asks for a larger limit keeps the inherited one", () => {
  const child = childNesting({ depth: 0, limit: 2, ceiling: undefined }, { ...agent, maxDepth: 9 });

  assert.equal(child.limit, 2);
  assert.equal(child.env[LIMIT_VAR], "2");
});
