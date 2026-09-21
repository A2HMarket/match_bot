/** 回放与指标。只读 decision_traces / messages / leads，出站一律 dry-run。 */
export {
  computeDailyMetrics,
  percentile,
  type DailyMetrics,
  type TracesReader,
} from './metrics.js';
export {
  evaluateSamples,
  replayInbound,
  scoreInbound,
  summarizeSignals,
  type InboundDecider,
  type ReplayReport,
  type ReplayRow,
  type SampleVerdict,
  type SignalStats,
  type SignalSummary,
} from './replay.js';
export {
  labeledSampleSchema,
  loadLabeledSamples,
  parseLabeledSamples,
  LABELED_INBOUND_URL,
  type LabeledSample,
} from './samples.js';
export {
  createFixtureFetch,
  jevFixtureSchema,
  loadJevFixture,
  recordedLatencies,
  JEV_FIXTURE_URL,
  type JevFixture,
} from './fixture-jev.js';
export { createMemoryTraces, type MemoryTraces } from './memory-traces.js';
export { loadInboundGate, type BoundInboundGate } from './gate.js';
