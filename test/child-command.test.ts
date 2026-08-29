import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentDefinition } from "../src/agent-file.ts";
import { childArguments, piExecutable } from "../src/child-command.ts";

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "reviewer",
    description: "Reviews a diff",
    tools: ["read", "grep"],
    model: undefined,
    systemPromptMode: "replace",
    systemPrompt: "You review code.",
    file: "/agents/reviewer.md",
    ...overrides,
  };
}

test("the command carries JSON mode, print mode and the denials", () => {
  const args = childArguments(agent());

  assert.deepEqual(args, [
    "--mode",
    "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--tools",
    "read,grep",
    "--system-prompt",
    "You review code.",
  ]);
});

test("no argument carries the task", () => {
  const args = childArguments(agent());

  assert.ok(!args.includes("--"));
});

test("the append mode selects the append flag", () => {
  const args = childArguments(agent({ systemPromptMode: "append" }));

  assert.ok(args.includes("--append-system-prompt"));
  assert.ok(!args.includes("--system-prompt"));
});

test("the replace mode selects the replace flag", () => {
  const args = childArguments(agent({ systemPromptMode: "replace" }));

  assert.ok(!args.includes("--append-system-prompt"));
  assert.ok(args.includes("--system-prompt"));
});

test("an empty tool list disables all tools", () => {
  const args = childArguments(agent({ tools: [] }));

  assert.ok(args.includes("--no-tools"));
  assert.ok(!args.includes("--tools"));
});

test("a model is passed to the child", () => {
  const args = childArguments(agent({ model: "anthropic/claude-sonnet-5" }));

  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
    "--model",
    "anthropic/claude-sonnet-5",
  ]);
});

test("an empty body still sends the system prompt flag", () => {
  const args = childArguments(agent({ systemPrompt: "" }));

  assert.deepEqual(args.slice(-2), ["--system-prompt", ""]);
});

test("the executable comes from the environment variable first", () => {
  assert.equal(piExecutable({ PI_SUBAGENTS_PI_BIN: "/fake/pi" }), "/fake/pi");
  assert.equal(piExecutable({}), "pi");
});
