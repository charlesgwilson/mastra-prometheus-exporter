// Wire the exporter into a Mastra instance with NO OLAP store — a plain LibSQL
// default is enough. Run: node --env-file=.env examples/basic.ts
//   (requires @mastra/core, @mastra/observability, @mastra/libsql and a model key)
import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { LibSQLStore } from '@mastra/libsql'
import { Observability } from '@mastra/observability'
import { PrometheusExporter } from 'mastra-prometheus-exporter'

const agent = new Agent({
  id: 'weather-agent',
  name: 'Weather Agent',
  instructions: 'You are a concise weather assistant.',
  model: process.env.MODEL ?? 'openai/gpt-5-mini',
})

const prom = new PrometheusExporter({ version: '0.1.0' })

const mastra = new Mastra({
  storage: new LibSQLStore({ id: 'app', url: 'file:./app.db' }), // NO DuckDB/ClickHouse
  observability: new Observability({
    configs: { default: { serviceName: 'demo', exporters: [prom] } },
  }),
  agents: { weatherAgent: agent },
})

prom.serve(9464) // http://localhost:9464/metrics

const a = mastra.getAgentById('weather-agent')
setInterval(async () => {
  try { await a.generate('Weather in SF?') } catch (e) { console.error(String(e).slice(0, 80)) }
}, 15_000)
console.log('exporter on http://localhost:9464/metrics — Ctrl-C to stop')
