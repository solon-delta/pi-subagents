import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { createRunQueue } from "../src/queue.ts";

interface Gate {
  /** True once the queue has started this run. */
  started: boolean;
  /** Ends the run. */
  finish: () => void;
  start: () => Promise<void>;
}

/** A run that the test starts and ends by hand. */
function gate(): Gate {
  const item: Gate = {
    started: false,
    finish: () => {},
    start: () =>
      new Promise<void>((resolve) => {
        item.started = true;
        item.finish = resolve;
      }),
  };
  return item;
}

test("a run below the limit starts at once", () => {
  const queue = createRunQueue(2);
  const first = gate();

  queue.add(first.start);

  assert.equal(first.started, true);
});

test("add reports whether the run started at once", () => {
  const queue = createRunQueue(1);
  const [first, second] = [gate(), gate()];

  assert.equal(queue.add(first.start), true);
  assert.equal(queue.add(second.start), false);
});

test("a run above the limit waits for a free slot", async () => {
  const queue = createRunQueue(2);
  const [first, second, third] = [gate(), gate(), gate()];

  queue.add(first.start);
  queue.add(second.start);
  queue.add(third.start);
  assert.equal(third.started, false);

  first.finish();
  await setImmediate();

  assert.equal(third.started, true);
});

test("queued runs start in the order they arrive", async () => {
  const queue = createRunQueue(1);
  const order: string[] = [];
  const gates = new Map(["a", "b", "c", "d"].map((id) => [id, gate()]));

  for (const [id, item] of gates) {
    queue.add(async () => {
      order.push(id);
      await item.start();
    });
  }

  for (let step = 0; step < gates.size; step += 1) {
    for (const item of gates.values()) if (item.started) item.finish();
    await setImmediate();
  }

  assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("a start that fails frees its slot", async () => {
  const queue = createRunQueue(1);
  const next = gate();

  queue.add(() => {
    throw new Error("the child did not start");
  });
  queue.add(next.start);
  await setImmediate();

  assert.equal(next.started, true);
});
