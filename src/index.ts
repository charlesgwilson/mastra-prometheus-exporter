import http from 'node:http'
import client from 'prom-client'

export interface PrometheusExporterOptions {
  /** Registry to register into. Defaults to a private registry (never the global default). */
  registry?: client.Registry
  /** Histogram buckets in SECONDS. Default is tuned for LLM latencies. */
  buckets?: number[]
  /** Register process/GC self-metrics (prefixed mastra_exporter_). Default true. */
  collectDefaultMetrics?: boolean
  /** Attach the Mastra traceId as an OpenMetrics exemplar. Default true. */
  useExemplars?: boolean
  /** Emit mastra_model_cost_usd_total from Mastra's estimatedCost, when present. Default true. */
  emitCost?: boolean
  /** Version string for the build-info metric. */
  version?: string
  /** Static labels attached to every series (e.g. { instance, env }). */
  defaultLabels?: Record<string, string>
}

/** LLM calls span sub-second to minutes; the prom-client default (10s ceiling) is too low. */
export const DEFAULT_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120]

const DURATION_KINDS = ['agent', 'tool', 'workflow', 'model', 'processor'] as const
const DURATION_LABELS = ['entity', 'entity_type', 'status']
const TOKEN_LABELS = ['direction', 'type', 'provider', 'model']
const DURATION_METRIC = /^mastra_(agent|tool|workflow|model|processor)_duration_ms$/
const MILLISECONDS_PER_SECOND = 1000
const MAX_LABEL_LENGTH = 200
const SERVER_TIMEOUT_MS = 15_000
const DEFAULT_PORT = 9464
const DEFAULT_HOST = '0.0.0.0'
const LANDING_PAGE =
  '<h1>mastra-prometheus-exporter</h1><p><a href="/metrics">/metrics</a></p>'

interface MastraCorrelationContext {
  traceId?: string
  entityName?: string
  entityId?: string
  entityType?: string
  provider?: string
  model?: string
}

/** Mastra attaches provider/model/estimatedCost here on token metric events. */
interface MastraCostContext {
  provider?: unknown
  model?: unknown
  estimatedCost?: unknown
}

interface MastraMetric {
  name?: unknown
  value?: unknown
  labels?: Record<string, unknown>
  correlationContext?: MastraCorrelationContext
  costContext?: MastraCostContext
  provider?: unknown
  model?: unknown
  estimatedCost?: unknown
  cost?: { estimatedCost?: unknown }
}

interface TokenName {
  direction: string
  type: string
}

/** Anything that can render Prometheus exposition text over HTTP. */
interface MetricsSource {
  readonly contentType: string
  metrics(): Promise<string>
}

export function parseTokenName(name: string): TokenName | null {
  const match = /^mastra_model_(.+)_tokens$/.exec(name)
  if (!match) return null

  const body = match[1]
  if (body.startsWith('total_')) {
    const direction = body.slice('total_'.length)
    return isDirection(direction) ? { direction, type: 'total' } : null
  }

  const separator = body.indexOf('_')
  if (separator < 0) return null

  const direction = body.slice(0, separator)
  return isDirection(direction) ? { direction, type: body.slice(separator + 1) } : null
}

function isDirection(value: string): boolean {
  return value === 'input' || value === 'output'
}

function sanitizeLabel(value: unknown): string {
  return String(value ?? 'unknown').replace(/[\r\n]+/g, ' ').slice(0, MAX_LABEL_LENGTH)
}

/** Mastra metric values are non-negative counts and durations; anything else (NaN,
 *  Infinity, negatives) would make prom-client throw, so it is dropped as invalid. */
function isMeasurement(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Serves a MetricsSource over HTTP at /metrics (plus /healthz and a landing page). */
class MetricsServer {
  #source: MetricsSource
  #server?: http.Server

  constructor(source: MetricsSource) {
    this.#source = source
  }

  start(port: number, host: string): http.Server {
    if (this.#server) throw new Error('metrics server already started')

    const server = http.createServer((request, response) => {
      this.#route(request, response).catch(() => this.#fail(response))
    })
    server.requestTimeout = SERVER_TIMEOUT_MS
    server.headersTimeout = SERVER_TIMEOUT_MS
    server.on('error', (error) => {
      if (!server.listening) this.#server = undefined
      this.#report(error)
    })
    server.listen(port, host)

    this.#server = server
    return server
  }

  async stop(): Promise<void> {
    const server = this.#server
    if (!server) return

    this.#server = undefined
    server.closeAllConnections?.()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (error && code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
        else resolve()
      })
    })
  }

  async #route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return this.#send(response, 405, 'text/plain', 'method not allowed\n')
    }

    const path = (request.url ?? '').split('?')[0]
    if (path === '/metrics') return this.#serveMetrics(response)
    if (path === '/healthz') return this.#send(response, 200, 'text/plain', 'ok\n')
    if (path === '/') return this.#send(response, 200, 'text/html', LANDING_PAGE)
    this.#send(response, 404, 'text/plain', 'not found\n')
  }

  async #serveMetrics(response: http.ServerResponse): Promise<void> {
    const body = await this.#source.metrics()
    this.#send(response, 200, this.#source.contentType, body)
  }

  #send(response: http.ServerResponse, status: number, contentType: string, body: string): void {
    response.writeHead(status, { 'content-type': contentType })
    response.end(body)
  }

  #fail(response: http.ServerResponse): void {
    this.#send(response, 500, 'text/plain', 'error serializing metrics\n')
  }

  #report(error: Error): void {
    console.error(`[mastra-prometheus-exporter] server error: ${error.message}`)
  }
}

/**
 * Store-free Prometheus exporter for Mastra. It consumes the metric events Mastra
 * pushes on its observability bus (via onMetricEvent) and turns them into
 * prom-client counters/histograms, so no observability store (DuckDB/ClickHouse)
 * is required — a plain relational store, or none, is enough.
 */
export class PrometheusExporter implements MetricsSource {
  readonly name = 'prometheus'
  readonly registry: client.Registry

  #useExemplars: boolean
  #emitCost: boolean
  #durationHistograms = new Map<string, client.Histogram<string>>()
  #tokens: client.Counter<string>
  #cost?: client.Counter<string>
  #dropped: client.Counter<string>
  #server: MetricsServer

  constructor(options: PrometheusExporterOptions = {}) {
    this.#useExemplars = options.useExemplars ?? true
    this.#emitCost = options.emitCost ?? true
    this.registry = options.registry ?? new client.Registry()
    this.#server = new MetricsServer(this)

    if (this.#useExemplars) this.#enableOpenMetrics()
    if (options.defaultLabels) this.registry.setDefaultLabels(options.defaultLabels)

    this.#buildDurationHistograms(options.buckets ?? DEFAULT_DURATION_BUCKETS)
    this.#tokens = this.#buildTokenCounter()
    if (this.#emitCost) this.#cost = this.#buildCostCounter()
    this.#dropped = this.#buildDroppedCounter()
    this.#buildInfo(options.version ?? '0.0.0')

    if (options.collectDefaultMetrics ?? true) {
      client.collectDefaultMetrics({ register: this.registry, prefix: 'mastra_exporter_' })
    }
  }

  get contentType(): string {
    return this.registry.contentType
  }

  metrics(): Promise<string> {
    return this.registry.metrics()
  }

  onMetricEvent(event: unknown): void {
    const metric = this.#readMetric(event)
    if (typeof metric.name !== 'string' || !isMeasurement(metric.value)) {
      return this.#drop('invalid_payload')
    }

    if (DURATION_METRIC.test(metric.name)) return this.#recordDuration(metric.name, metric)

    const token = parseTokenName(metric.name)
    if (token) return this.#recordTokens(token, metric)

    this.#drop('unmapped_metric')
  }

  onDroppedEvent(event: unknown): void {
    const dropped = (event ?? {}) as { reason?: unknown; count?: unknown }
    const reason = sanitizeLabel(dropped.reason ?? 'mastra_drop')
    const count = Number(dropped.count) || 1

    this.#dropped.inc({ reason }, count)
  }

  async exportTracingEvent(_event: unknown): Promise<void> {}

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {
    await this.#server.stop()
  }

  serve(port = DEFAULT_PORT, host = DEFAULT_HOST): http.Server {
    return this.#server.start(port, host)
  }

  #recordDuration(name: string, metric: MastraMetric): void {
    const histogram = this.#durationHistograms.get(name.split('_')[1])!
    const seconds = (metric.value as number) / MILLISECONDS_PER_SECOND

    this.#observe(histogram, this.#durationLabels(metric), seconds, metric)
  }

  #recordTokens(token: TokenName, metric: MastraMetric): void {
    const labels = this.#tokenLabels(token, metric)

    this.#count(this.#tokens, labels, metric.value as number, metric)
    this.#recordCost(token, metric, labels.provider, labels.model)
  }

  #recordCost(token: TokenName, metric: MastraMetric, provider: string, model: string): void {
    if (!this.#cost || token.type !== 'total' || token.direction !== 'input') return

    const cost = metric.costContext?.estimatedCost ?? metric.estimatedCost ?? metric.cost?.estimatedCost
    if (isMeasurement(cost)) this.#cost.inc({ provider, model }, cost)
  }

  #observe(
    histogram: client.Histogram<string>,
    labels: Record<string, string>,
    value: number,
    metric: MastraMetric,
  ): void {
    if (this.#useExemplars) {
      histogram.observe({ labels, value, exemplarLabels: this.#exemplar(metric) })
    } else {
      histogram.observe(labels, value)
    }
  }

  #count(
    counter: client.Counter<string>,
    labels: Record<string, string>,
    value: number,
    metric: MastraMetric,
  ): void {
    if (this.#useExemplars) {
      counter.inc({ labels, value, exemplarLabels: this.#exemplar(metric) })
    } else {
      counter.inc(labels, value)
    }
  }

  #durationLabels(metric: MastraMetric): Record<string, string> {
    const context = metric.correlationContext ?? {}
    return {
      entity: sanitizeLabel(context.entityName ?? context.entityId),
      entity_type: sanitizeLabel(context.entityType),
      status: sanitizeLabel(metric.labels?.status ?? 'ok'),
    }
  }

  #tokenLabels(token: TokenName, metric: MastraMetric): Record<string, string> {
    const context = metric.correlationContext ?? {}
    return {
      direction: token.direction,
      type: token.type,
      provider: sanitizeLabel(metric.costContext?.provider ?? metric.provider ?? context.provider),
      model: sanitizeLabel(metric.costContext?.model ?? metric.model ?? context.model),
    }
  }

  #drop(reason: string): void {
    this.#dropped.inc({ reason })
  }

  #readMetric(event: unknown): MastraMetric {
    const envelope = (event ?? {}) as { metric?: MastraMetric } & MastraMetric
    return envelope.metric ?? envelope
  }

  #exemplar(metric: MastraMetric): Record<string, string> {
    const traceId = metric.correlationContext?.traceId
    return traceId ? { trace_id: traceId } : {}
  }

  #enableOpenMetrics(): void {
    const registry = this.registry as unknown as client.Registry<client.RegistryContentType>
    registry.setContentType(client.Registry.OPENMETRICS_CONTENT_TYPE)
  }

  #buildDurationHistograms(buckets: number[]): void {
    for (const kind of DURATION_KINDS) {
      this.#durationHistograms.set(kind, new client.Histogram({
        name: `mastra_${kind}_duration_seconds`,
        help: `Duration of Mastra ${kind} executions in seconds`,
        labelNames: DURATION_LABELS,
        buckets,
        enableExemplars: this.#useExemplars,
        registers: [this.registry],
      }))
    }
  }

  #buildTokenCounter(): client.Counter<string> {
    return new client.Counter({
      name: 'mastra_model_tokens_total',
      help: 'Model token usage by direction and type',
      labelNames: TOKEN_LABELS,
      enableExemplars: this.#useExemplars,
      registers: [this.registry],
    })
  }

  #buildCostCounter(): client.Counter<string> {
    return new client.Counter({
      name: 'mastra_model_cost_usd_total',
      help: "Estimated model cost in USD (best-effort; prefer a recording rule over tokens, prices drift)",
      labelNames: ['provider', 'model'],
      registers: [this.registry],
    })
  }

  #buildDroppedCounter(): client.Counter<string> {
    return new client.Counter({
      name: 'mastra_exporter_dropped_events_total',
      help: 'Observability events the exporter could not record',
      labelNames: ['reason'],
      registers: [this.registry],
    })
  }

  #buildInfo(version: string): void {
    new client.Gauge({
      name: 'mastra_exporter_build_info',
      help: 'Exporter build info (constant 1)',
      labelNames: ['version', 'node_version'],
      registers: [this.registry],
    }).set({ version, node_version: process.version }, 1)
  }
}

export function createPrometheusExporter(options?: PrometheusExporterOptions): PrometheusExporter {
  return new PrometheusExporter(options)
}
