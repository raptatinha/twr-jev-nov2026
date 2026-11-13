import { metrics, trace, type Counter, type Histogram, type Span } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * Level 3 of "showing the results": OpenTelemetry.
 * Off by default. Turned on only when OTEL_EXPORTER_OTLP_ENDPOINT is set (see .env.example),
 * so the laptop demos never need Docker.
 *
 * Each model call becomes a span using the OpenTelemetry GenAI conventions
 * (gen_ai.request.model, gen_ai.usage.input_tokens, ...), plus our own attributes
 * (jev_training.cost_usd, jev_training.confidence, jev_training.route.path).
 * The same numbers also go out as metrics, for the Grafana dashboard.
 */
// The running OpenTelemetry SDK, or undefined when telemetry is off or not started yet.
let sdk: NodeSDK | undefined;

// On only when .env sets OTEL_EXPORTER_OTLP_ENDPOINT (e.g. http://localhost:4318 after `npm run obs:up`).
export function telemetryEnabled(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

// Start the SDK once. Safe to call many times: later calls do nothing.
export function startTelemetry(): void {
  if (sdk || !telemetryEnabled()) return;
  // The service name Grafana groups everything under.
  process.env.OTEL_SERVICE_NAME ??= 'jev-training';
  sdk = new NodeSDK({
    // Spans go to the collector over OTLP/HTTP (the endpoint comes from the env variable).
    traceExporter: new OTLPTraceExporter(),
    // Metrics are pushed every 5 seconds.
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 5_000 })],
  });
  sdk.start();
}

/** Send everything that is still buffered. Call once at the end of a script or test worker. */
export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
  // Forget the instruments too: they belonged to the SDK we just shut down.
  cached = undefined;
}

// One tracer for the whole project. Safe to create early: it picks up the SDK once it starts.
export const tracer = trace.getTracer('jev-training');

// The four metrics we send. Their names are what the Grafana dashboard queries.
type Instruments = {
  tokens: Counter;
  cost: Counter;
  latency: Histogram;
  decisions: Counter;
};
let cached: Instruments | undefined;

/**
 * Metric instruments, created on first use AFTER the SDK started.
 * (Unlike tracers, a meter created before the SDK starts stays a no-op forever.)
 */
export function instruments(): Instruments {
  startTelemetry();
  if (cached) return cached;
  // Create the instruments: two counters (tokens, cost), a histogram (latency), and decisions by path.
  const meter = metrics.getMeter('jev-training');
  const created: Instruments = {
    tokens: meter.createCounter('jev_training_tokens', { description: 'Tokens per model and direction (input/output)' }),
    cost: meter.createCounter('jev_training_cost_usd', { description: 'Cost in USD per model' }),
    latency: meter.createHistogram('jev_training_latency_ms', {
      description: 'Model call latency in milliseconds',
      // Fine buckets from 50 ms to 60 s, so the typical and slow (1 in 20) values are close to the real ones.
      advice: { explicitBucketBoundaries: [50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 60000] },
    }),
    decisions: meter.createCounter('jev_training_decisions', { description: 'Decisions by route path (jev / cheap / strong)' }),
  };
  // Only keep real instruments; with telemetry off they are no-ops and cheap to recreate.
  if (sdk) cached = created;
  return created;
}

// Re-exported so other files can type spans without importing OpenTelemetry themselves.
export type { Span };
