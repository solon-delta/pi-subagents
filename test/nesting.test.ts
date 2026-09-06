import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentDefinition } from "../src/agent-file.ts";
import {
  childNesting,
  DEPTH_VAR,
  inheritedNesting,
  LIMIT_VAR,
  type ToolSource,
} from "../src/nesting.ts";

const agent: AgentDefinition = {
  name: "splitter",
  description: "Splits a task",
  tools: ["read", "bash", "subagent"],
  skills: [],
  model: undefined,
  maxDepth: undefined,
  systemPromptMode: "replace",
  systemPrompt: "You split a task.",
  file: "/agents/splitter.md",
};

/** A built-in tool of pi, which carries no extension file. */
function builtIn(name: string): ToolSource {
  return { name, path: `<builtin:${name}>` };
}

/** The extension file that backs the two tools of this package. */
const SELF = "/pkg/pi-subagents/index.ts";

/** The live tool list of a session that loaded this extension. */
const SESSION_TOOLS: ToolSource[] = [
  builtIn("read"),
  builtIn("bash"),
  builtIn("write"),
  builtIn("grep"),
  { name: "subagent", path: SELF },
  { name: "subagent_stop", path: SELF },
];

test("a session without the variables is a root at depth zero", () => {
  const parent = inheritedNesting({}, 3);

  assert.deepEqual(parent, { depth: 0, limit: 3 });
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
  const child = childNesting({ depth: 0, limit: 3 }, agent, SESSION_TOOLS);

  assert.deepEqual(child.tools, ["read", "bash", "subagent"]);
  assert.deepEqual(child.removed, []);
  assert.deepEqual(child.extensions, [SELF]);
  assert.equal(child.depth, 1);
});

test("a built-in tool needs no extension file", () => {
  const child = childNesting(
    { depth: 0, limit: 3 },
    { ...agent, tools: ["read", "bash"] },
    SESSION_TOOLS,
  );

  assert.deepEqual(child.extensions, []);
});

test("two tool names of one extension name that file once", () => {
  const both = { ...agent, tools: ["subagent", "subagent_stop"] };

  const child = childNesting({ depth: 0, limit: 3 }, both, SESSION_TOOLS);

  assert.deepEqual(child.extensions, [SELF]);
});

test("a tool of a third-party extension reaches the child with its file", () => {
  const live = [
    ...SESSION_TOOLS,
    { name: "web_search", path: "/home/user/.pi/agent/extensions/web.ts" },
  ];
  const searcher = { ...agent, tools: ["read", "web_search"] };

  const child = childNesting({ depth: 0, limit: 3 }, searcher, live);

  assert.deepEqual(child.tools, ["read", "web_search"]);
  assert.deepEqual(child.extensions, ["/home/user/.pi/agent/extensions/web.ts"]);
});

test("a project extension reaches the child, because this session loaded it", () => {
  const live = [
    ...SESSION_TOOLS,
    { name: "deploy", path: "/work/project/.pi/extensions/deploy.ts" },
  ];

  const child = childNesting({ depth: 0, limit: 3 }, { ...agent, tools: ["deploy"] }, live);

  assert.deepEqual(child.extensions, ["/work/project/.pi/extensions/deploy.ts"]);
});

test("a name that no tool of the session carries fails the launch at depth zero", () => {
  assert.throws(
    () =>
      childNesting(
        { depth: 0, limit: 3 },
        { ...agent, tools: ["read", "webserch"] },
        SESSION_TOOLS,
      ),
    (error: Error) => {
      assert.match(error.message, /webserch/);
      assert.match(error.message, /splitter/);
      return true;
    },
  );
});

test("a missing name below depth zero is dropped and reported as removed", () => {
  const child = childNesting({ depth: 1, limit: 3 }, agent, [builtIn("read"), builtIn("grep")]);

  assert.deepEqual(child.tools, ["read"]);
  assert.deepEqual(child.removed, ["bash", "subagent"]);
});

test("an agent cannot widen the list with a tool that the parent lost", () => {
  const narrow = [builtIn("read")];

  const child = childNesting(
    { depth: 1, limit: 3 },
    { ...agent, tools: ["read", "write"] },
    narrow,
  );

  assert.deepEqual(child.tools, ["read"]);
  assert.deepEqual(child.removed, ["write"]);
});

test("a tool without an extension file fails the launch and names the reason", () => {
  const live = [builtIn("read"), { name: "ask", path: "<sdk:ask>" }];

  assert.throws(
    () => childNesting({ depth: 0, limit: 3 }, { ...agent, tools: ["read", "ask"] }, live),
    (error: Error) => {
      assert.match(error.message, /ask/);
      assert.match(error.message, /splitter/);
      assert.match(error.message, /<sdk:ask>/);
      assert.match(error.message, /no extension file/);
      return true;
    },
  );
});

test("an inline tool fails the launch below depth zero too", () => {
  const live = [builtIn("read"), { name: "ask", path: "<inline:ask>" }];

  assert.throws(
    () => childNesting({ depth: 2, limit: 4 }, { ...agent, tools: ["ask"] }, live),
    /no extension file/,
  );
});

test("an agent with a skill gets the read tool that its file does not name", () => {
  const reader = { ...agent, tools: ["bash"], skills: ["review"] };

  const child = childNesting({ depth: 0, limit: 3 }, reader, SESSION_TOOLS);

  assert.deepEqual(child.tools, ["bash", "read"]);
  assert.deepEqual(child.removed, []);
});

test("an agent with a skill that already names read keeps one read", () => {
  const reader = { ...agent, tools: ["read", "bash"], skills: ["review"] };

  const child = childNesting({ depth: 0, limit: 3 }, reader, SESSION_TOOLS);

  assert.deepEqual(child.tools, ["read", "bash"]);
});

test("a list without read refuses an agent that names a skill", () => {
  const reader = { ...agent, tools: ["bash"], skills: ["review"] };

  assert.throws(
    () => childNesting({ depth: 1, limit: 3 }, reader, [builtIn("bash")]),
    (error: Error) => {
      assert.match(error.message, /read/);
      assert.match(error.message, /splitter/);
      return true;
    },
  );
});

test("a root session without read refuses a skill agent for the skill reason", () => {
  // The read tool of a skill is not a name of the agent file, so the message
  // of the missing name would name a tool that the user never wrote.
  const reader = { ...agent, tools: ["bash"], skills: ["review"] };

  assert.throws(
    () => childNesting({ depth: 0, limit: 3 }, reader, [builtIn("bash")]),
    /names skills/,
  );
});

test("a launch at the limit is refused and the message names the depth and the limit", () => {
  assert.throws(
    () => childNesting({ depth: 3, limit: 3 }, agent, SESSION_TOOLS),
    (error: Error) => {
      assert.match(error.message, /depth 3/);
      assert.match(error.message, /limit of 3/);
      assert.match(error.message, /splitter/);
      return true;
    },
  );
});

test("the depth of the child is one more than the depth of the parent", () => {
  const child = childNesting({ depth: 1, limit: 3 }, agent, SESSION_TOOLS);

  assert.equal(child.depth, 2);
  assert.equal(child.env[DEPTH_VAR], "2");
});

test("an agent lowers the limit for its own subtree", () => {
  const child = childNesting({ depth: 0, limit: 3 }, { ...agent, maxDepth: 1 }, SESSION_TOOLS);

  assert.equal(child.limit, 1);
  assert.equal(child.env[LIMIT_VAR], "1");
});

test("an agent that asks for a larger limit keeps the inherited one", () => {
  const child = childNesting({ depth: 0, limit: 2 }, { ...agent, maxDepth: 9 }, SESSION_TOOLS);

  assert.equal(child.limit, 2);
  assert.equal(child.env[LIMIT_VAR], "2");
});
