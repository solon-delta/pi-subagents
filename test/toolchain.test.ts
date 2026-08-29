import assert from "node:assert/strict";
import { test } from "node:test";

// Placeholder. It proves the container runs the node test runner on a .ts file.
test("node strips types and runs this file", () => {
  const version: string = process.version;
  assert.match(version, /^v26\./);
});
