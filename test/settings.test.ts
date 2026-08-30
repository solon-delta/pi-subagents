import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentDefinition } from "../src/agent-file.ts";
import { agentRoots } from "../src/agents.ts";
import { DEFAULTS, loadSettings, settingsFile, withDefaultModel } from "../src/settings.ts";

function settingsWith(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "settings-")), "pi-subagents.json");
  writeFileSync(file, text);
  return file;
}

function agent(model: string | undefined): AgentDefinition {
  return {
    name: "reviewer",
    description: "Reviews a diff",
    tools: ["read"],
    model,
    systemPromptMode: "replace",
    systemPrompt: "You review code.",
    file: "/agents/reviewer.md",
  };
}

test("the settings file lives in the pi agent directory", () => {
  assert.equal(settingsFile("/home/user/.pi/agent"), "/home/user/.pi/agent/pi-subagents.json");
});

test("an unknown key is ignored and the known keys are kept", () => {
  const loaded = loadSettings(settingsWith(JSON.stringify({ maxdepth: 5, maxConcurrency: 2 })));

  assert.deepEqual(loaded.settings, { ...DEFAULTS, maxConcurrency: 2 });
  assert.equal(loaded.warning, undefined);
});

test("a tilde in an agent directory is expanded", () => {
  const loaded = loadSettings(settingsWith(JSON.stringify({ agentDirs: ["~/work/agents"] })));

  assert.equal(loaded.settings.agentDirs.length, 1);
  assert.doesNotMatch(loaded.settings.agentDirs[0], /^~/);
  assert.match(loaded.settings.agentDirs[0], /work\/agents$/);
});

test("the defaults are depth three, concurrency four and thirty minutes", () => {
  assert.equal(DEFAULTS.maxDepth, 3);
  assert.equal(DEFAULTS.maxConcurrency, 4);
  assert.equal(DEFAULTS.timeoutMinutes, 30);
  assert.equal(DEFAULTS.defaultModel, undefined);
  assert.deepEqual(DEFAULTS.agentDirs, []);
});

test("a missing file gives the defaults and no warning", () => {
  const loaded = loadSettings(join(tmpdir(), "no-such-settings.json"));

  assert.deepEqual(loaded.settings, DEFAULTS);
  assert.equal(loaded.warning, undefined);
});

test("a valid file gives its values", () => {
  const file = settingsWith(
    JSON.stringify({
      maxDepth: 5,
      maxConcurrency: 1,
      timeoutMinutes: 10,
      defaultModel: "anthropic/claude-haiku-4-5",
      agentDirs: ["/extra/agents"],
    }),
  );

  const loaded = loadSettings(file);

  assert.deepEqual(loaded.settings, {
    maxDepth: 5,
    maxConcurrency: 1,
    timeoutMinutes: 10,
    defaultModel: "anthropic/claude-haiku-4-5",
    agentDirs: ["/extra/agents"],
  });
  assert.equal(loaded.warning, undefined);
});

test("an absent key keeps its default", () => {
  const loaded = loadSettings(settingsWith(JSON.stringify({ maxConcurrency: 2 })));

  assert.deepEqual(loaded.settings, { ...DEFAULTS, maxConcurrency: 2 });
  assert.equal(loaded.warning, undefined);
});

test("a file that is not JSON warns and gives the defaults", () => {
  const file = settingsWith("{ maxDepth: 5, }");

  const loaded = loadSettings(file);

  assert.deepEqual(loaded.settings, DEFAULTS);
  assert.match(loaded.warning ?? "", /pi-subagents\.json/);
});

test("a wrong value type warns and gives the defaults", () => {
  const file = settingsWith(JSON.stringify({ maxDepth: "three" }));

  const loaded = loadSettings(file);

  assert.deepEqual(loaded.settings, DEFAULTS);
  assert.match(loaded.warning ?? "", /pi-subagents\.json/);
});

test("the extra agent directories are searched with the user root", () => {
  const roots = agentRoots("/project", "/home/user", ["/extra/agents"]);

  assert.equal(roots[1], join("/home/user", ".pi", "agent", "agents"));
  assert.equal(roots[2], "/extra/agents");
  assert.equal(roots.length, 4);
});

test("an agent without a model key takes the default model", () => {
  assert.equal(
    withDefaultModel(agent(undefined), "anthropic/claude-haiku-4-5").model,
    "anthropic/claude-haiku-4-5",
  );
});

test("an agent with a model key overrides the default model", () => {
  assert.equal(
    withDefaultModel(agent("openai/gpt-5"), "anthropic/claude-haiku-4-5").model,
    "openai/gpt-5",
  );
});
