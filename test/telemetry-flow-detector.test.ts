import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceFlow,
  flowPourDueAt,
  reduceFlow,
  waitingFlowState,
  type FlowDetectorConfig,
  type FlowDetectorEffect,
  type FlowDetectorState,
} from "../src/features/telemetry/flow-detector.ts";

const config: FlowDetectorConfig = {
  quietPeriodMs: 5_000,
  hardTimeoutMs: 15_000,
  minimumPourMl: 30,
};

/** Feeds `[atMs, counterMl]` readings in order, collecting every effect. */
function run(
  readings: readonly (readonly [number, number])[],
  start: FlowDetectorState = waitingFlowState(),
) {
  let state = start;
  let session = 0;
  const effects: FlowDetectorEffect[] = [];
  for (const [atMs, counterMl] of readings) {
    const transition = reduceFlow(state, { atMs, counterMl }, config, `pour-${++session}`);
    state = transition.state;
    effects.push(...transition.effects);
  }
  return { state, effects };
}

const pours = (effects: readonly FlowDetectorEffect[]) =>
  effects.filter((effect) => effect.type === "flow_pour_completed");

void test("the first reading sets the baseline and records no pour", () => {
  const { state, effects } = run([[0, 12_345]]);
  assert.deepEqual(effects, [{ type: "flow_baseline_established", counterMl: 12_345 }]);
  assert.deepEqual(state, { counterMl: 12_345, counterAtMs: 0, pour: null });
});

void test("a single pour is the counter delta, from the first to the last increase", () => {
  const { state } = run([
    [0, 1_000],
    [60_000, 1_000],
    [61_000, 1_100],
    [62_000, 1_300],
    [63_000, 1_473],
    [64_000, 1_473],
  ]);
  assert.deepEqual(state.pour, {
    sessionId: "pour-3",
    startCounterMl: 1_000,
    startedAtMs: 61_000,
    lastFlowAtMs: 63_000,
  });
  assert.equal(flowPourDueAt(state, config), 68_000);
  assert.deepEqual(advanceFlow(state, config, 67_999).effects, []);
  const closed = advanceFlow(state, config, 68_000);
  assert.deepEqual(closed.effects, [
    {
      type: "flow_pour_completed",
      sessionId: "pour-3",
      volumeMl: 473,
      startedAtMs: 61_000,
      completedAtMs: 63_000,
    },
  ]);
  assert.deepEqual(closed.state, { counterMl: 1_473, counterAtMs: 64_000, pour: null });
});

void test("a pause shorter than the quiet period stays one pour", () => {
  const { state, effects } = run([
    [0, 0],
    [1_000, 200],
    [5_500, 200],
    [5_900, 450],
  ]);
  assert.deepEqual(pours(effects), []);
  assert.equal(state.pour?.startCounterMl, 0);
  assert.equal(advanceFlow(state, config, 10_900).effects.length, 1);
  assert.deepEqual(pours(advanceFlow(state, config, 10_900).effects), [
    {
      type: "flow_pour_completed",
      sessionId: "pour-2",
      volumeMl: 450,
      startedAtMs: 1_000,
      completedAtMs: 5_900,
    },
  ]);
});

void test("quiet time closes a pour, and the next increase opens a new one", () => {
  const { effects, state } = run([
    [0, 0],
    [1_000, 300],
    [6_000, 300],
    [7_000, 500],
  ]);
  assert.deepEqual(pours(effects), [
    {
      type: "flow_pour_completed",
      sessionId: "pour-2",
      volumeMl: 300,
      startedAtMs: 1_000,
      completedAtMs: 1_000,
    },
  ]);
  assert.deepEqual(state.pour, {
    sessionId: "pour-4",
    startCounterMl: 300,
    startedAtMs: 7_000,
    lastFlowAtMs: 7_000,
  });
});

void test("a reading after the quiet deadline closes the due pour before it counts", () => {
  // The device was offline across the quiet deadline; its next reading is a new pour.
  const { effects, state } = run([
    [0, 0],
    [1_000, 300],
    [30_000, 800],
  ]);
  assert.deepEqual(
    pours(effects).map((pour) => pour.volumeMl),
    [300],
  );
  assert.equal(state.pour?.startCounterMl, 300);
  assert.equal(state.pour?.startedAtMs, 30_000);
});

void test("a counter decrease mid-pour closes the pour at the last value and re-baselines", () => {
  const { effects, state } = run([
    [0, 5_000],
    [1_000, 5_200],
    [2_000, 5_400],
    [3_000, 20],
    [4_000, 120],
  ]);
  assert.deepEqual(effects, [
    { type: "flow_baseline_established", counterMl: 5_000 },
    {
      type: "flow_pour_completed",
      sessionId: "pour-2",
      volumeMl: 400,
      startedAtMs: 1_000,
      completedAtMs: 2_000,
    },
    { type: "flow_baseline_established", counterMl: 20 },
  ]);
  // Flow after the reset counts from the new baseline.
  assert.deepEqual(state.pour, {
    sessionId: "pour-5",
    startCounterMl: 20,
    startedAtMs: 4_000,
    lastFlowAtMs: 4_000,
  });
});

void test("a pour below the minimum is discarded", () => {
  const { state } = run([
    [0, 100],
    [1_000, 129],
  ]);
  assert.deepEqual(advanceFlow(state, config, 6_000).effects, [
    { type: "flow_pour_discarded", sessionId: "pour-2", volumeMl: 29 },
  ]);
  assert.equal(advanceFlow(state, config, 6_000).state.pour, null);
});

void test("the hard timeout records the pour so far and later flow opens the next pour", () => {
  const readings: [number, number][] = [[0, 0]];
  for (let second = 1; second <= 20; second += 1) readings.push([second * 1_000, second * 100]);
  const { effects, state } = run(readings);
  // The pour that started at 1 s closes at 16 s with the counter it had reached by then.
  assert.deepEqual(pours(effects), [
    {
      type: "flow_pour_completed",
      sessionId: "pour-2",
      volumeMl: 1_500,
      startedAtMs: 1_000,
      completedAtMs: 15_000,
    },
  ]);
  assert.deepEqual(state.pour, {
    sessionId: "pour-17",
    startCounterMl: 1_500,
    startedAtMs: 16_000,
    lastFlowAtMs: 20_000,
  });
  // Without new readings the timeout alone closes a pour that keeps flowing past it.
  assert.equal(flowPourDueAt(state, config), 25_000);
});

void test("a reading at or before the last one is ignored", () => {
  const first = run([
    [0, 0],
    [1_000, 100],
  ]).state;
  assert.deepEqual(reduceFlow(first, { atMs: 1_000, counterMl: 900 }, config, "x"), {
    state: first,
    effects: [],
  });
});
