import { parseIsoDateStrict } from '../../src/core/dates'
import { extractStationDay } from './stationDay'
import { MAX_UPSTREAM_CSV_BYTES, STATION_ID_PATTERN, type StationDayResponse } from './protocol'

const ROUTE_PATH = '/v1/station-day'
const UPSTREAM_TIMEOUT_MS = 30_000
const CACHE_MAX_AGE_SECONDS = 6 * 60 * 60
const CACHE_SCHEMA_VERSION = '2'
const ERROR_LIMIT = 256
const MAX_BATCH_DAYS = 6
const MAX_UPSTREAM_CONCURRENCY = 6

export interface WorkerEnv {
  ALLOWED_ORIGINS: string
  SOURCE_BASE_URL: string
  /** Test-only override; it is not configured as a Worker variable. */
  __TEST_TIMEOUT_MS?: number
}

type CacheLike = Pick<Cache, 'match' | 'put'>

class UpstreamTooLargeError extends Error {}

function json(body: unknown, status: number, origin?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  if (origin) addCors(headers, origin)
  return new Response(JSON.stringify(body), { status, headers })
}

function error(status: number, message: string, origin?: string): Response {
  const safeMessage = message.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, ERROR_LIMIT)
  return json({ error: safeMessage || '请求处理失败' }, status, origin)
}

function addCors(headers: Headers, origin: string): void {
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-methods', 'GET, OPTIONS')
  headers.set('vary', 'Origin')
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers)
  addCors(headers, origin)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function allowedOrigin(request: Request, env: WorkerEnv): string | undefined {
  const origin = request.headers.get('Origin')
  if (!origin) return undefined
  const allowed = env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)
  return allowed.includes(origin) ? origin : undefined
}

function validSourceBase(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
    return url
  } catch {
    return undefined
  }
}

function getCache(): CacheLike | undefined {
  const candidate = (globalThis as typeof globalThis & { caches?: { default?: unknown } }).caches?.default
  if (!candidate || typeof (candidate as CacheLike).match !== 'function' || typeof (candidate as CacheLike).put !== 'function') return undefined
  return candidate as CacheLike
}

function cacheKey(date: string, stationId: string): Request {
  return new Request(`https://station-day-cache.invalid${ROUTE_PATH}?schema=${CACHE_SCHEMA_VERSION}&date=${date}&station=${stationId}`)
}

function requestParameters(url: URL): { dates: string[]; stationId: string; batch: boolean } | undefined {
  const stationId = url.searchParams.get('station') ?? ''
  if (!STATION_ID_PATTERN.test(stationId)) return undefined
  const date = url.searchParams.get('date')
  const datesValue = url.searchParams.get('dates')
  if ((date === null) === (datesValue === null)) return undefined
  const dates = datesValue === null ? [date!] : datesValue.split(',')
  if (dates.length < 1 || dates.length > MAX_BATCH_DAYS || new Set(dates).size !== dates.length) return undefined
  try { dates.forEach((value) => parseIsoDateStrict(value)) } catch { return undefined }
  return { dates, stationId, batch: datesValue !== null }
}

async function boundedCsv(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_UPSTREAM_CSV_BYTES) throw new UpstreamTooLargeError()
  if (!response.body) throw new Error('empty upstream response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_UPSTREAM_CSV_BYTES) {
        await reader.cancel()
        throw new UpstreamTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

async function loadStationDay(sourceUrl: string, date: string, stationId: string, timeoutMs: number): Promise<StationDayResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const upstream = await fetch(sourceUrl, { redirect: 'manual', signal: controller.signal })
    if (!upstream.ok) throw new Error('upstream status')
    const contentType = upstream.headers.get('content-type') ?? ''
    if (!/^text\/csv(?:;|$)|^application\/(?:csv|octet-stream)(?:;|$)/i.test(contentType)) throw new Error('non csv')
    return extractStationDay(await boundedCsv(upstream), date, stationId)
  } finally {
    clearTimeout(timer)
  }
}

async function resolveStationDay(
  sourceBase: URL,
  date: string,
  stationId: string,
  timeoutMs: number,
  cache: CacheLike | undefined,
): Promise<StationDayResponse> {
  const key = cacheKey(date, stationId)
  try {
    const cached = await cache?.match(key)
    if (cached?.ok) return await cached.json() as StationDayResponse
  } catch {
    // Cache outages or malformed cache entries are safe to treat as misses.
  }
  const sourceUrl = new URL(`china_sites_${date.replaceAll('-', '')}.csv`, sourceBase).toString()
  const result = await loadStationDay(sourceUrl, date, stationId, timeoutMs)
  const canonical = json(result, 200)
  canonical.headers.set('cache-control', `public, max-age=${CACHE_MAX_AGE_SECONDS}`)
  try { await cache?.put(key, canonical.clone()) } catch { /* optional cache */ }
  return result
}

async function resolveStationDays(
  sourceBase: URL,
  dates: readonly string[],
  stationId: string,
  timeoutMs: number,
  cache: CacheLike | undefined,
): Promise<StationDayResponse[]> {
  const results: Array<StationDayResponse | undefined> = Array.from({ length: dates.length })
  let next = 0
  let failed = false
  let failure: unknown
  const run = async (): Promise<void> => {
    while (!failed) {
      const index = next
      next += 1
      if (index >= dates.length) return
      try {
        results[index] = await resolveStationDay(sourceBase, dates[index], stationId, timeoutMs, cache)
      } catch (cause) {
        failed = true
        failure = cause
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_UPSTREAM_CONCURRENCY, dates.length) }, run))
  if (failed) throw failure
  return results as StationDayResponse[]
}

const worker = {
  async fetch(request: Request, env: WorkerEnv, _ctx: object): Promise<Response> {
    const origin = allowedOrigin(request, env)
    if (!origin) return error(403, '来源不被允许')
    const url = new URL(request.url)
    if (request.method === 'OPTIONS' && url.pathname === ROUTE_PATH) {
      const headers = new Headers()
      addCors(headers, origin)
      return new Response(null, { status: 204, headers })
    }
    if (request.method !== 'GET') return error(405, '不支持的请求方法', origin)
    if (url.pathname !== ROUTE_PATH) return error(404, '请求路径不存在', origin)
    const params = requestParameters(url)
    if (!params) return error(400, '日期或站点编号格式无效', origin)
    const sourceBase = validSourceBase(env.SOURCE_BASE_URL)
    if (!sourceBase) return error(500, '服务配置无效', origin)
    const cache = getCache()
    try {
      const timeoutMs = env.__TEST_TIMEOUT_MS && Number.isFinite(env.__TEST_TIMEOUT_MS) && env.__TEST_TIMEOUT_MS > 0 ? env.__TEST_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS
      const days = await resolveStationDays(sourceBase, params.dates, params.stationId, timeoutMs, cache)
      const canonical = json(params.batch ? { days } : days[0], 200)
      canonical.headers.set('cache-control', `public, max-age=${CACHE_MAX_AGE_SECONDS}`)
      return withCors(canonical, origin)
    } catch (cause) {
      if (cause instanceof UpstreamTooLargeError) return error(413, '上游 CSV 文件超过大小限制', origin)
      if (cause instanceof DOMException && cause.name === 'AbortError') return error(504, '上游数据请求超时', origin)
      return error(502, '上游数据不可用或格式无效', origin)
    }
  },
}

export default worker
