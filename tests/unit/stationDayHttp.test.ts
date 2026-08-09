import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type WorkerEnv } from '../../worker/src/index'
import { MAX_UPSTREAM_CSV_BYTES } from '../../worker/src/protocol'

const ORIGIN = 'https://asherwx.github.io'
const ENV: WorkerEnv = {
  ALLOWED_ORIGINS: 'https://asherwx.github.io,http://127.0.0.1:4173',
  SOURCE_BASE_URL: 'https://quotsoft.net/air/data',
  __TEST_TIMEOUT_MS: 20,
}
const CSV = ['date,hour,type,3329A', '20241101,0,SO2,3'].join('\n')

class MemoryCache {
  private readonly entries = new Map<string, Response>()

  private key(request: RequestInfo | URL): string {
    if (request instanceof Request) return request.url
    return request.toString()
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(this.key(request))?.clone()
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(this.key(request), response.clone())
  }
}

function request(path = '/v1/station-day?date=2024-11-01&station=3329A', origin = ORIGIN): Request {
  return new Request(`https://api.example.test${path}`, { headers: { Origin: origin } })
}

function upstream(body: BodyInit | null = CSV, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    ...init,
    headers: { 'content-type': 'text/csv; charset=utf-8', ...init.headers },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('station day HTTP worker', () => {
  it('fetches only the derived HTTPS CSV URL and returns allowed-origin JSON', async () => {
    const fetchSpy = vi.fn(async () => upstream())
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('caches', { default: new MemoryCache() })

    const response = await worker.fetch(request(), ENV, {})

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({ date: '2024-11-01', stationId: '3329A' })
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://quotsoft.net/air/data/china_sites_20241101.csv',
      expect.objectContaining({ redirect: 'manual' }),
    )
  })

  it('accepts the upstream octet-stream content type used for daily CSV files', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream(CSV, {
      headers: { 'content-type': 'application/octet-stream' },
    })))
    vi.stubGlobal('caches', { default: new MemoryCache() })

    const response = await worker.fetch(request(), ENV, {})

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ date: '2024-11-01', stationId: '3329A' })
  })

  it.each([
    ['missing origin', request('/v1/station-day?date=2024-11-01&station=3329A', '')],
    ['unapproved origin', request('/v1/station-day?date=2024-11-01&station=3329A', 'https://evil.test')],
    ['invalid date', request('/v1/station-day?date=2024-02-30&station=3329A')],
    ['invalid station', request('/v1/station-day?date=2024-11-01&station=x<script>')],
    ['wrong path', request('/other?date=2024-11-01&station=3329A')],
  ])('rejects %s without an upstream request', async (_label, input) => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('caches', { default: new MemoryCache() })

    const response = await worker.fetch(input, ENV, {})

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await response.text()).length).toBeLessThanOrEqual(512)
  })

  it('handles OPTIONS preflight and rejects unsupported methods', async () => {
    vi.stubGlobal('caches', { default: new MemoryCache() })
    const preflight = await worker.fetch(
      new Request('https://api.example.test/v1/station-day', { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
      ENV,
      {},
    )
    const post = await worker.fetch(
      new Request('https://api.example.test/v1/station-day?date=2024-11-01&station=3329A', { method: 'POST', headers: { Origin: ORIGIN } }),
      ENV,
      {},
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS')
    expect(post.status).toBe(405)
  })

  it.each([
    ['redirect', async () => upstream(CSV, { status: 302, headers: { location: 'https://evil.test' } })],
    ['not found', async () => upstream('no', { status: 404 })],
    ['non-csv', async () => upstream('<html>', { headers: { 'content-type': 'text/html' } })],
    ['declared oversize', async () => upstream(CSV, { headers: { 'content-length': String(MAX_UPSTREAM_CSV_BYTES + 1) } })],
    ['malformed csv', async () => upstream('date,hour,type,3329A\n20241101,0,SO2,"bad')],
  ])('returns a bounded safe error for upstream %s', async (_label, implementation) => {
    vi.stubGlobal('fetch', vi.fn(implementation))
    vi.stubGlobal('caches', { default: new MemoryCache() })

    const response = await worker.fetch(request(), ENV, {})
    const body = await response.text()

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(body.length).toBeLessThanOrEqual(512)
    expect(body).not.toMatch(/https:\/\/evil|stack|Error:/i)
  })

  it('rejects streamed oversized bodies even when Content-Length lies', async () => {
    const bytes = new TextEncoder().encode('x'.repeat(MAX_UPSTREAM_CSV_BYTES + 1))
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
    vi.stubGlobal('fetch', vi.fn(async () => upstream(stream, { headers: { 'content-length': '1' } })))
    vi.stubGlobal('caches', { default: new MemoryCache() })

    const response = await worker.fetch(request(), ENV, {})

    expect(response.status).toBe(413)
  })

  it('times out a slow upstream request without leaking implementation details', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('long secret upstream details', 'AbortError')))
    })))
    vi.stubGlobal('caches', { default: new MemoryCache() })

    const response = await worker.fetch(request(), ENV, {})

    expect(response.status).toBe(504)
    expect((await response.text()).length).toBeLessThanOrEqual(512)
  })

  it('caches only successful canonical JSON and adds origin-specific CORS on cache hits', async () => {
    const fetchSpy = vi.fn(async () => upstream())
    const cache = new MemoryCache()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('caches', { default: cache })

    const first = await worker.fetch(request('/v1/station-day?station=3329A&date=2024-11-01&source=https://evil.test'), ENV, {})
    const second = await worker.fetch(request('/v1/station-day?date=2024-11-01&station=3329A', 'http://127.0.0.1:4173'), ENV, {})

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4173')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not reuse cached responses from an older response schema', async () => {
    const fetchSpy = vi.fn(async () => upstream())
    const cache = new MemoryCache()
    await cache.put(
      'https://station-day-cache.invalid/v1/station-day?date=2024-11-01&station=3329A',
      new Response(JSON.stringify({ rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 3 }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('caches', { default: cache })

    const response = await worker.fetch(request(), ENV, {})
    const body = await response.json() as { allRows?: unknown[] }

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(body.allRows).toHaveLength(1)
  })

  it('fails closed when the configured source base is not an HTTPS base URL', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('caches', { default: new MemoryCache() })

    const response = await worker.fetch(request(), { ...ENV, SOURCE_BASE_URL: 'http://quotsoft.net/air/data?x=1' }, {})

    expect(response.status).toBe(500)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
