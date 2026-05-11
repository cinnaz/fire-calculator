import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'

const TAX_RATE_ROUTE = '/api/tax-rate'

const handleTaxRateRequest = async (request: IncomingMessage, response: ServerResponse) => {
  if (!request.url) {
    response.statusCode = 400
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ error: 'Missing request URL.' }))
    return
  }

  const url = new URL(request.url, 'http://localhost')
  const income = Number(url.searchParams.get('income'))
  const state = url.searchParams.get('state')?.trim() ?? ''

  if (!Number.isFinite(income) || income <= 0 || state.length === 0) {
    response.statusCode = 400
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ error: 'Income and state are required.' }))
    return
  }

  const sourceUrl = `https://www.talent.com/tax-calculator/${encodeURIComponent(state)}-${Math.round(income)}`

  try {
    const upstreamResponse = await fetch(sourceUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 FireCalculator Tax Lookup',
      },
    })

    if (!upstreamResponse.ok) {
      response.statusCode = 502
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ error: 'Talent.com lookup failed.' }))
      return
    }

    const html = await upstreamResponse.text()
    const match = html.match(/Average tax rate[^0-9]*([0-9]+(?:\.[0-9]+)?)%/i)

    if (!match) {
      response.statusCode = 502
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ error: 'Average tax rate was not found.' }))
      return
    }

    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        averageTaxRate: Number(match[1]) / 100,
        sourceUrl,
      }),
    )
  } catch {
    response.statusCode = 502
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ error: 'Talent.com lookup failed.' }))
  }
}

const taxRateProxyPlugin = (): Plugin => ({
  name: 'tax-rate-proxy',
  configureServer(server: ViteDevServer) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.startsWith(TAX_RATE_ROUTE)) {
        void handleTaxRateRequest(request, response)
        return
      }

      next()
    })
  },
  configurePreviewServer(server: PreviewServer) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.startsWith(TAX_RATE_ROUTE)) {
        void handleTaxRateRequest(request, response)
        return
      }

      next()
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), taxRateProxyPlugin()],
  test: {
    environment: 'node',
  },
})
