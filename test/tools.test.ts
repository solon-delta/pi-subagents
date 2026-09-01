import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { toolArguments } from "../src/tools.ts";

/** The extension file of this package, which backs the subagent tool names. */
const self = fileURLToPath(new URL("../index.ts", import.meta.url));

test("a list of built-in names adds no extension argument", () => {
  const args = toolArguments(["read", "grep", "ls"], "explorer");

  assert.deepEqual(args, ["--tools", "read,grep,ls"]);
});

test("an empty list disables every tool", () => {
  assert.deepEqual(toolArguments([], "writer"), ["--no-tools"]);
});

test("a mapped name adds the extension file and keeps the name in the list", () => {
  const args = toolArguments(["read", "subagent"], "planner");

  assert.deepEqual(args, ["--tools", "read,subagent", "--extension", self]);
});

test("two mapped names from the same file add the extension file once", () => {
  const args = toolArguments(["subagent", "subagent_stop"], "planner");

  assert.deepEqual(args, ["--tools", "subagent,subagent_stop", "--extension", self]);
});

test("a name that is neither built in nor mapped fails and names the tool and the agent", () => {
  assert.throws(
    () => toolArguments(["read", "webserch"], "explorer"),
    (error: Error) => {
      assert.match(error.message, /webserch/);
      assert.match(error.message, /explorer/);
      return true;
    },
  );
});
