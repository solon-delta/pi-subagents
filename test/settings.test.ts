import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULTS, loadSettings, settingsFiles } from "../src/settings.ts";

function settingsWith(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "settings-")), "pi-subagents.json");
  writeFileSync(file, text);
  return file;
}

test("the user settings file lives in the pi agent directory", () => {
  const files = settingsFiles("/home/user/.pi/agent", "/project", false);

  assert.deepEqual(files, ["/home/user/.pi/agent/pi-subagents.json"]);
});

test("a trusted project adds its own file after the user file", () => {
  const files = settingsFiles("/home/user/.pi/agent", "/project", true);

  assert.deepEqual(files, [
    "/home/user/.pi/agent/pi-subagents.json",
    join("/project", ".pi", "pi-subagents.json"),
  ]);
});

test("the defaults are depth three, concurrency four and thirty minutes", () => {
  assert.equal(DEFAULTS.maxDepth, 3);
  assert.equal(DEFAULTS.maxConcurrency, 4);
  assert.equal(DEFAULTS.timeoutMinutes, 30);
  assert.equal(DEFAULTS.defaultModel, undefined);
  assert.deepEqual(DEFAULTS.agentDirs, []);
});

test("a missing file gives the defaults and no warning", () => {
  const loaded = loadSettings([join(tmpdir(), "no-such-settings.json")]);

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

  const loaded = loadSettings([file]);

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
  const loaded = loadSettings([settingsWith(JSON.stringify({ maxConcurrency: 2 }))]);

  assert.deepEqual(loaded.settings, { ...DEFAULTS, maxConcurrency: 2 });
  assert.equal(loaded.warning, undefined);
});

test("an unknown key is ignored and the known keys are kept", () => {
  const loaded = loadSettings([settingsWith(JSON.stringify({ maxdepth: 5, maxConcurrency: 2 }))]);

  assert.deepEqual(loaded.settings, { ...DEFAULTS, maxConcurrency: 2 });
  assert.equal(loaded.warning, undefined);
});

test("a tilde in an agent directory is expanded", () => {
  const loaded = loadSettings([settingsWith(JSON.stringify({ agentDirs: ["~/work/agents"] }))]);

  assert.equal(loaded.settings.agentDirs.length, 1);
  assert.doesNotMatch(loaded.settings.agentDirs[0], /^~/);
  assert.match(loaded.settings.agentDirs[0], /work\/agents$/);
});

test("a file that is not JSON warns and gives the defaults", () => {
  const loaded = loadSettings([settingsWith("{ maxDepth: 5, }")]);

  assert.deepEqual(loaded.settings, DEFAULTS);
  assert.match(loaded.warning ?? "", /pi-subagents\.json/);
});

test("a wrong value type warns and gives the defaults", () => {
  const loaded = loadSettings([settingsWith(JSON.stringify({ maxDepth: "three" }))]);

  assert.deepEqual(loaded.settings, DEFAULTS);
  assert.match(loaded.warning ?? "", /pi-subagents\.json/);
});

test("the project file overrides the user file, key by key", () => {
  const user = settingsWith(JSON.stringify({ maxDepth: 5, maxConcurrency: 2 }));
  const project = settingsWith(JSON.stringify({ maxConcurrency: 1 }));

  const loaded = loadSettings([user, project]);

  assert.equal(loaded.settings.maxDepth, 5);
  assert.equal(loaded.settings.maxConcurrency, 1);
  assert.equal(loaded.warning, undefined);
});

test("a broken project file warns and keeps the user values", () => {
  const user = settingsWith(JSON.stringify({ maxDepth: 5 }));
  const project = settingsWith("not json");

  const loaded = loadSettings([user, project]);

  assert.equal(loaded.settings.maxDepth, 5);
  assert.match(loaded.warning ?? "", /pi-subagents\.json/);
});

test("two broken files give one warning that names both", () => {
  const user = settingsWith("not json");
  const project = settingsWith(JSON.stringify({ maxDepth: "three" }));

  const loaded = loadSettings([user, project]);

  assert.deepEqual(loaded.settings, DEFAULTS);
  assert.ok((loaded.warning ?? "").includes(user));
  assert.ok((loaded.warning ?? "").includes(project));
});
