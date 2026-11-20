import type { DetectorConfig } from "./detector-config.ts";

/**
 * The flow pour detector (#170). A flow meter sends a cumulative, device-calibrated
 * `dispensed_volume` counter. The first reading sets the baseline; an increase opens or extends
 * a pour; `quietPeriodMs` without an increase closes it; a pour is at most `hardTimeoutMs` long
 * (later flow opens the next pour); a decrease is a reset that closes any open pour at the last
 * value and re-baselines. A pour below `minimumPourMl` is discarded.
 *
 * Readings arrive in measured order (the per-source watermark rejects older ones), so the
 * detector needs no sample history.
 */
export interface FlowPourState {
  readonly sessionId: string;
  /** The counter before the pour's first increase. */
  readonly startCounterMl: number;
  readonly startedAtMs: number;
  readonly lastFlowAtMs: number;
}

export interface FlowDetectorState {
  /** The last counter value; null until the first reading sets the baseline. */
  readonly counterMl: number | null;
  readonly counterAtMs: number | null;
  readonly pour: FlowPourState | null;
}

export interface FlowSample {
  readonly counterMl: number;
  readonly atMs: number;
}

export type FlowDetectorConfig = Pick<
  DetectorConfig,
  "quietPeriodMs" | "hardTimeoutMs" | "minimumPourMl"
>;

export type FlowDetectorEffect =
  | { readonly type: "flow_baseline_established"; readonly counterMl: number }
  | {
      readonly type: "flow_pour_completed";
      readonly sessionId: string;
      readonly volumeMl: number;
      readonly startedAtMs: number;
      readonly completedAtMs: number;
    }
  | { readonly type: "flow_pour_discarded"; readonly sessionId: string; readonly volumeMl: number };

export interface FlowDetectorTransition {
  readonly state: FlowDetectorState;
  readonly effects: readonly FlowDetectorEffect[];
}

export const waitingFlowState = (): FlowDetectorState => ({
  counterMl: null,
  counterAtMs: null,
  pour: null,
});

/** When the open pour closes on its own: after the quiet period or at the hard timeout. */
export function flowPourDueAt(state: FlowDetectorState, config: FlowDetectorConfig): number | null {
  const pour = state.pour;
  if (pour === null) return null;
  return Math.min(
    pour.lastFlowAtMs + config.quietPeriodMs,
    pour.startedAtMs + config.hardTimeoutMs,
  );
}

/** Closes the open pour at the last counter value: recorded, or discarded below the minimum. */
export function closeFlowPour(
  state: FlowDetectorState,
  config: FlowDetectorConfig,
): FlowDetectorTransition {
  const pour = state.pour;
  if (pour === null || state.counterMl === null) return { state, effects: [] };
  const volumeMl = state.counterMl - pour.startCounterMl;
  return {
    state: { ...state, pour: null },
    effects: [
      volumeMl < config.minimumPourMl
        ? { type: "flow_pour_discarded", sessionId: pour.sessionId, volumeMl }
        : {
            type: "flow_pour_completed",
            sessionId: pour.sessionId,
            volumeMl,
            startedAtMs: pour.startedAtMs,
            completedAtMs: pour.lastFlowAtMs,
          },
    ],
  };
}

/** Closes the open pour if it is due by `nowMs`. */
export function advanceFlow(
  state: FlowDetectorState,
  config: FlowDetectorConfig,
  nowMs: number,
): FlowDetectorTransition {
  const dueAt = flowPourDueAt(state, config);
  return dueAt !== null && dueAt <= nowMs ? closeFlowPour(state, config) : { state, effects: [] };
}

export function reduceFlow(
  previous: FlowDetectorState,
  sample: FlowSample,
  config: FlowDetectorConfig,
  sessionId: string,
): FlowDetectorTransition {
  if (previous.counterAtMs !== null && sample.atMs <= previous.counterAtMs) {
    return { state: previous, effects: [] };
  }
  // A pour that was due before this reading closes first, so the reading cannot extend it.
  const due = advanceFlow(previous, config, sample.atMs);
  const effects: FlowDetectorEffect[] = [...due.effects];
  let state = due.state;
  const counterMl = state.counterMl;
  if (counterMl === null || sample.counterMl < counterMl) {
    // First reading, or a reset (reboot or keg reset): close at the last value and re-baseline.
    const closed = closeFlowPour(state, config);
    effects.push(...closed.effects, {
      type: "flow_baseline_established",
      counterMl: sample.counterMl,
    });
    state = closed.state;
  } else if (sample.counterMl > counterMl) {
    state = {
      ...state,
      pour:
        state.pour === null
          ? {
              sessionId,
              startCounterMl: counterMl,
              startedAtMs: sample.atMs,
              lastFlowAtMs: sample.atMs,
            }
          : { ...state.pour, lastFlowAtMs: sample.atMs },
    };
  }
  return { state: { ...state, counterMl: sample.counterMl, counterAtMs: sample.atMs }, effects };
}
