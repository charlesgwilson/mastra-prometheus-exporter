import test from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import client from 'prom-client'
import { PrometheusExporter, parseTokenName } from '../src/index.ts'

interface EventExtras {
  labels?: Record<string, string>
  traceId?: string
  entity?: string
  entityType?: string
  costContext?: Record<string, unknown>
  top?: Record<string, unknown>
}

const buildExporter = (options = {}) =>
  new PrometheusExporter({ collectDefaultMetrics: false, ...options })

// Mirrors the real Mastra 1.49 event shape: provider/model/estimatedCost arrive in
// a nested `costContext` (verified live in the lab), NOT flat on the metric.
const buildEvent = (name: string, value: number, extras: EventExtras = {}) => ({
  metric: {
    name,
    value,
    labels: extras.labels ?? { status: 'ok' },
    correlationContext: {
      traceId: extras.traceId,
      entityName: extras.entity ?? 'Weather Agent',
      entityType: extras.entityType ?? 'agent',
    },
    ...(extras.costContext ? { costContext: extras.costContext } : {}),
    ...extras.top,
  },
})

const listen = async (server: import('node:http').Server): Promise<number> => {
  await new Promise((resolve) => server.once('listening', resolve))
  return (server.address() as AddressInfo).port
}

test('converts duration from milliseconds to seconds', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent(buildEvent('mastra_agent_duration_ms', 2000))

  const output = await exporter.metrics()
  assert.match(output, /mastra_agent_duration_seconds_sum\{[^}]*entity="Weather Agent"[^}]*\} 2\b/)
})

test('places a duration observation in the correct bucket', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent(buildEvent('mastra_agent_duration_ms', 2000))

  const output = await exporter.metrics()
  assert.match(output, /mastra_agent_duration_seconds_bucket\{le="2"[^}]*\} 1/)
  assert.match(output, /mastra_agent_duration_seconds_bucket\{le="1"[^}]*\} 0/)
})

test('carries the status label onto the duration histogram', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent(buildEvent('mastra_agent_duration_ms', 500, { labels: { status: 'error' } }))

  const output = await exporter.metrics()
  assert.match(output, /mastra_agent_duration_seconds_count\{[^}]*status="error"[^}]*\} 1/)
})

test('maps every duration kind to its own histogram', async () => {
  const exporter = buildExporter({ useExemplars: false })

  for (const kind of ['agent', 'tool', 'workflow', 'model', 'processor']) {
    exporter.onMetricEvent(buildEvent(`mastra_${kind}_duration_ms`, 500))
  }

  const output = await exporter.metrics()
  for (const kind of ['agent', 'tool', 'workflow', 'model', 'processor']) {
    assert.match(output, new RegExp(`mastra_${kind}_duration_seconds_count`))
  }
})

test('drops non-finite metric values instead of throwing', async () => {
  const exporter = buildExporter({ useExemplars: false })

  for (const value of [NaN, Infinity, -Infinity]) {
    exporter.onMetricEvent(buildEvent('mastra_agent_duration_ms', value))
  }

  const output = await exporter.metrics()
  assert.match(output, /mastra_exporter_dropped_events_total\{reason="invalid_payload"\} 3/)
})

test('drops negative metric values', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent(buildEvent('mastra_agent_duration_ms', -500))

  const output = await exporter.metrics()
  assert.match(output, /mastra_exporter_dropped_events_total\{reason="invalid_payload"\} 1/)
})

test('reads provider and model from the Mastra costContext', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent(buildEvent('mastra_model_total_input_tokens', 100, { costContext: { provider: 'openrouter', model: 'gpt-4o-mini' } }))
  exporter.onMetricEvent(buildEvent('mastra_model_output_reasoning_tokens', 20, { costContext: { provider: 'openrouter', model: 'gpt-4o-mini' } }))

  const output = await exporter.metrics()
  assert.match(output, /mastra_model_tokens_total\{direction="input",type="total",provider="openrouter",model="gpt-4o-mini"\} 100/)
  assert.match(output, /mastra_model_tokens_total\{direction="output",type="reasoning",[^}]*\} 20/)
})

test('falls back to flat provider and model when costContext is absent', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent(buildEvent('mastra_model_total_input_tokens', 42, { top: { provider: 'flatp', model: 'flatm' } }))

  const output = await exporter.metrics()
  assert.match(output, /mastra_model_tokens_total\{direction="input",type="total",provider="flatp",model="flatm"\} 42/)
})

test('emits cost from the costContext of the total input token event', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent(buildEvent('mastra_model_total_input_tokens', 100, { costContext: { provider: 'openrouter', model: 'm', estimatedCost: 0.00004736 } }))

  const output = await exporter.metrics()
  assert.match(output, /mastra_model_cost_usd_total\{provider="openrouter",model="m"\} 0\.00004736\b/)
})

test('does not double-count cost across total input and output events', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent(buildEvent('mastra_model_total_input_tokens', 100, { costContext: { provider: 'p', model: 'm', estimatedCost: 0.01 } }))
  exporter.onMetricEvent(buildEvent('mastra_model_total_output_tokens', 50, { costContext: { provider: 'p', model: 'm', estimatedCost: 0.01 } }))

  const output = await exporter.metrics()
  assert.match(output, /mastra_model_cost_usd_total\{provider="p",model="m"\} 0\.01\b/)
})

test('does not emit cost from non-total token events', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent(buildEvent('mastra_model_input_text_tokens', 90, { costContext: { provider: 'p', model: 'm', estimatedCost: 0.009 } }))

  const output = await exporter.metrics()
  assert.doesNotMatch(output, /mastra_model_cost_usd_total\{provider="p"/)
})

test('drops an event with no numeric value', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent({ metric: { name: 'mastra_agent_duration_ms' } })

  const output = await exporter.metrics()
  assert.match(output, /mastra_exporter_dropped_events_total\{reason="invalid_payload"\} 1/)
})

test('drops an unrecognised metric name', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onMetricEvent(buildEvent('mastra_unknown_thing', 1))

  const output = await exporter.metrics()
  assert.match(output, /mastra_exporter_dropped_events_total\{reason="unmapped_metric"\} 1/)
})

test('records dropped events reported by Mastra with their reason and count', async () => {
  const exporter = buildExporter({ useExemplars: false })

  exporter.onDroppedEvent({ reason: 'unsupported_storage', count: 3 })

  const output = await exporter.metrics()
  assert.match(output, /mastra_exporter_dropped_events_total\{reason="unsupported_storage"\} 3/)
})

test('attaches a trace_id exemplar to duration observations', async () => {
  const exporter = buildExporter({ useExemplars: true })

  exporter.onMetricEvent(buildEvent('mastra_agent_duration_ms', 1500, { traceId: 't-abc-123' }))

  const output = await exporter.metrics()
  assert.match(output, /trace_id="t-abc-123"/)
})

test('attaches a trace_id exemplar to token counters', async () => {
  const exporter = buildExporter({ useExemplars: true })

  exporter.onMetricEvent(buildEvent('mastra_model_total_input_tokens', 100, { traceId: 'tok-9', costContext: { provider: 'p', model: 'm' } }))

  const output = await exporter.metrics()
  assert.match(output, /mastra_model_tokens_total\{[^}]*\} 100 # \{trace_id="tok-9"\}/)
})

test('serves exemplars in the OpenMetrics exposition format', async () => {
  const exporter = buildExporter({ useExemplars: true })

  const contentType = exporter.contentType

  assert.equal(contentType, client.Registry.OPENMETRICS_CONTENT_TYPE)
})

test('exposes a constant build_info gauge', async () => {
  const exporter = buildExporter({ useExemplars: false, version: '1.2.3' })

  const output = await exporter.metrics()

  assert.match(output, /mastra_exporter_build_info\{version="1\.2\.3",node_version="[^"]+"\} 1/)
})

test('never registers on the global default registry', async () => {
  const before = (await client.register.metrics()).length

  buildExporter({ useExemplars: false }).onMetricEvent(buildEvent('mastra_agent_duration_ms', 100))

  const after = (await client.register.metrics()).length
  assert.equal(before, after)
})

test('serves the exposition text over HTTP at /metrics', async () => {
  const exporter = buildExporter({ useExemplars: false })
  exporter.onMetricEvent(buildEvent('mastra_agent_duration_ms', 1000))
  const port = await listen(exporter.serve(0, '127.0.0.1'))

  const response = await fetch(`http://127.0.0.1:${port}/metrics`)
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.match(body, /mastra_agent_duration_seconds_count/)

  await exporter.shutdown()
})

test('answers health checks at /healthz', async () => {
  const exporter = buildExporter({ useExemplars: false })
  const port = await listen(exporter.serve(0, '127.0.0.1'))

  const response = await fetch(`http://127.0.0.1:${port}/healthz`)

  assert.equal(response.status, 200)

  await exporter.shutdown()
})

test('rejects non-GET requests with 405', async () => {
  const exporter = buildExporter({ useExemplars: false })
  const port = await listen(exporter.serve(0, '127.0.0.1'))

  const response = await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })

  assert.equal(response.status, 405)

  await exporter.shutdown()
})

test('refuses to start a second server on the same exporter', async () => {
  const exporter = buildExporter({ useExemplars: false })
  await listen(exporter.serve(0, '127.0.0.1'))

  assert.throws(() => exporter.serve(0, '127.0.0.1'), /already started/)

  await exporter.shutdown()
})

test('parses the documented Mastra token metric shapes', () => {
  assert.deepEqual(parseTokenName('mastra_model_total_input_tokens'), { direction: 'input', type: 'total' })
  assert.deepEqual(parseTokenName('mastra_model_total_output_tokens'), { direction: 'output', type: 'total' })
  assert.deepEqual(parseTokenName('mastra_model_input_cache_read_tokens'), { direction: 'input', type: 'cache_read' })
  assert.deepEqual(parseTokenName('mastra_model_output_reasoning_tokens'), { direction: 'output', type: 'reasoning' })
  assert.equal(parseTokenName('mastra_agent_duration_ms'), null)
})
