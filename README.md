# mastra-prometheus-exporter

A Prometheus exporter for [Mastra](https://mastra.ai) that doesn't need an analytics store.

Mastra derives per-agent metrics (latency, tokens, cost) from its traces, but its
metrics query API only works with an OLAP store: DuckDB in development, ClickHouse in
production. You don't need that store to monitor and alert. Mastra also pushes every
metric onto its observability bus, so this exporter listens on `onMetricEvent`, feeds
[`prom-client`](https://github.com/siimon/prom-client), and serves the result at
`/metrics`. A plain relational store (LibSQL, Postgres), or none, is enough.

Because it builds real Prometheus histograms, you get windowed `histogram_quantile`
percentiles, and trace-id exemplars that jump from a latency spike to the exact
Mastra trace.

## Install

```bash
npm install mastra-prometheus-exporter prom-client
```

`@mastra/core`, `@mastra/observability`, and a storage adapter (for example
`@mastra/libsql`) come from your Mastra app. This exporter only adds `prom-client`.

## Usage

```ts
import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'
import { Observability } from '@mastra/observability'
import { PrometheusExporter } from 'mastra-prometheus-exporter'

const prom = new PrometheusExporter({ version: '1.0.0' })

export const mastra = new Mastra({
  storage: new LibSQLStore({ id: 'app', url: 'file:./app.db' }), // no OLAP store
  observability: new Observability({
    configs: { default: { serviceName: 'my-service', exporters: [prom] } },
  }),
})

prom.serve(9464) // http://0.0.0.0:9464/metrics  (also /healthz and /)
```

`serve(port, host)` binds all interfaces by default (`0.0.0.0`) so a containerized or
remote Prometheus can reach it. Pass `serve(9464, '127.0.0.1')` to restrict it to
loopback. Point Prometheus at `:9464`. From a Docker Prometheus on Linux, use
`host.docker.internal` with `--add-host=host.docker.internal:host-gateway`. To store
exemplars, run Prometheus with `--enable-feature=exemplar-storage`.

`serve()` returns the Node `http.Server`. Bind failures (for example `EADDRINUSE`) are
logged; for programmatic control, attach your own handlers to the returned server:
`prom.serve(9464).on('listening', …).on('error', …)`. Call `await prom.shutdown()` to
stop it.

## Metrics

| Metric | Type | Unit | Labels | Description |
|---|---|---|---|---|
| `mastra_agent_duration_seconds` | Histogram | seconds | `entity`, `entity_type`, `status` | Agent run latency |
| `mastra_tool_duration_seconds` | Histogram | seconds | `entity`, `entity_type`, `status` | Tool call latency (incl. MCP) |
| `mastra_workflow_duration_seconds` | Histogram | seconds | `entity`, `entity_type`, `status` | Workflow run latency |
| `mastra_model_duration_seconds` | Histogram | seconds | `entity`, `entity_type`, `status` | Model generation latency |
| `mastra_processor_duration_seconds` | Histogram | seconds | `entity`, `entity_type`, `status` | Processor run latency |
| `mastra_model_tokens_total` | Counter | tokens | `direction`, `type`, `provider`, `model` | Token usage (`type` = `total`, `text`, `reasoning`, `cache_read`, …) |
| `mastra_model_cost_usd_total` | Counter | USD | `provider`, `model` | Estimated cost, best-effort (prefer a recording rule; see below) |
| `mastra_exporter_dropped_events_total` | Counter | events | `reason` | Events the exporter could not record |
| `mastra_exporter_build_info` | Gauge | n/a | `version`, `node_version` | Constant `1` |
| `mastra_exporter_*` | (various) | n/a | n/a | Process/GC self-metrics (`collectDefaultMetrics`) |

Durations are converted from milliseconds to seconds (the Prometheus base unit).
Histograms carry a `trace_id` exemplar (OpenMetrics) so you can jump from a metric to
its trace. High-cardinality fields (`traceId`, `spanId`, `runId`, `userId`) are never
labels.

### When each series appears

A metric materializes once its first event arrives. `mastra_model_tokens_total` and
`mastra_model_cost_usd_total` appear after the first successful model call (a failed
call reports no `usage`). `mastra_tool_duration_seconds` appears after the first tool
call, and `mastra_exporter_dropped_events_total` after the first drop. On error-only
traffic you correctly see just the duration histograms, with `status="error"`.

One thing to know about status: Mastra reports the model span `status="ok"` even when
the provider call fails upstream (for example an OpenRouter 429). The agent span
carries `status="error"`, which is what the shipped error-ratio rule keys off, so
alert on the agent metric.

### Cost

Cost is tokens times price, and prices drift, so the exporter treats the raw token
counters as the source of truth and emits `mastra_model_cost_usd_total` from Mastra's
`estimatedCost` on a best-effort basis. For authoritative cost, derive it with a
recording rule (see [`prometheus/recording-rules.yml`](prometheus/recording-rules.yml)).
Disable the emitted metric with `emitCost: false`.

To avoid double-counting, cost is accumulated only from the total-input token event
(both total-input and total-output carry `type="total"`). One consequence: if a Mastra
version attaches `estimatedCost` only to the output event, the emitted cost metric
stays empty. The recording rule over token counters is unaffected, and it stays the
recommended path.

## Options

```ts
new PrometheusExporter({
  registry,               // bring your own prom-client Registry (default: a private one)
  buckets,                // histogram buckets in SECONDS (default: LLM-tuned, up to 120s)
  collectDefaultMetrics,  // process/GC metrics, prefixed mastra_exporter_ (default: true)
  useExemplars,           // trace_id exemplars + OpenMetrics content type (default: true)
  emitCost,               // emit mastra_model_cost_usd_total (default: true)
  version,                // build-info version label
  defaultLabels,          // static labels on every series, e.g. { instance, env }
})
```

By default the exporter uses its own registry and never touches prom-client's global
default registry.

## Alerts and dashboards

- [`prometheus/recording-rules.yml`](prometheus/recording-rules.yml): p95 latency,
  error ratio, tokens per second, and the cost-derivation pattern.
- [`prometheus/alerts.yml`](prometheus/alerts.yml): example latency, error-ratio, and
  dropped-events alerts.

## Notes and compatibility

- Native histograms (Prometheus v3.8+) are not emitted yet, because `prom-client`
  doesn't support them ([#576](https://github.com/siimon/prom-client/issues/576)).
  Buckets are configurable, so migration is cheap when it lands.
- The metric surface is this package's public API. Metric renames are treated as
  breaking changes under semver.
- Verified against `@mastra/core` 1.49 and `@mastra/observability` 1.15. Mastra's docs
  frame metrics as requiring `MastraStorageExporter` and an OLAP store, but that is the
  storage and query path. `onMetricEvent` fires on the bus regardless.
- If you already run ClickHouse for storage, an OLAP-query exporter (for example a
  generic SQL exporter over Mastra's tables) is an alternative. It couples to Mastra's
  internal schema; this exporter reads the event bus instead, so it stays independent
  of that schema.

## Development

```bash
npm test      # node --test (unit tests over synthetic metric events; no network)
npm run build # tsc -> dist/ with .d.ts
```

## License

MIT © Greg Wilson
