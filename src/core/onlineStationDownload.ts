import { buildDownloadLinks, MAX_DOWNLOAD_RANGE_DAYS } from './downloadLinks'
import { serializeExtractedStationCsv } from './extractedStationCsv'
import type {
  DownloadedStationRange,
  DownloadStationRangeOptions,
  HourlyStationDataRow,
  HourlyStationRow,
} from './types'
import { assertCanonicalStationId } from './types'

const MAX_RESPONSE_BYTES = 1024 * 1024
const WARNING_CAP = 100
const MAX_DAY_WARNING_TOTAL = 1_000_000
const MAX_RANGE_WARNING_TOTAL =
  MAX_DOWNLOAD_RANGE_DAYS * (MAX_DAY_WARNING_TOTAL + 24 * 6 + 1)
const MAX_DATA_TYPES_PER_HOUR = 64
const MAX_DAY_ATTEMPTS = 3

function abortError(): DOMException {
  return new DOMException('The station download was aborted.', 'AbortError')
}

export function isSafeStationEndpoint(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  return (url.protocol === 'https:' || (local && url.protocol === 'http:'))
    && !url.username && !url.password && !url.hash
}

function endpointUrl(value: string): URL {
  if (!isSafeStationEndpoint(value)) {
    throw new Error('endpoint must be HTTPS (HTTP is allowed only for localhost or 127.0.0.1), with no credentials or fragment')
  }
  return new URL(value)
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return 2
  if (!Number.isInteger(value) || value < 1) throw new Error('concurrency must be a whole number of at least 1')
  return Math.min(value, 4)
}

function dayUrl(endpoint: URL, date: string, stationId: string): string {
  const url = new URL(endpoint.toString())
  url.searchParams.set('date', date)
  url.searchParams.set('station', stationId)
  return url.toString()
}

function boundedMessage(value: unknown): string {
  return String(value).replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 240)
}

async function readBoundedUtf8(response: Response): Promise<string> {
  if (!response.body) throw new Error('response body is empty')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('response exceeds the 1 MiB safety limit')
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('response is not valid UTF-8 JSON')
  }
}

class WarningCollector {
  readonly warnings: string[] = []
  total = 0
  add(message: string): void {
    this.increase(1)
    if (this.warnings.length < WARNING_CAP) this.warnings.push(message)
    if (this.total === WARNING_CAP + 1) this.warnings[WARNING_CAP - 1] = `Warnings truncated after ${WARNING_CAP - 1} entries.`
  }
  addHidden(count: number): void {
    if (count > 0) this.increase(count)
  }
  private increase(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || this.total > MAX_RANGE_WARNING_TOTAL - count) {
      throw new Error('warning total exceeds the station range safety limit')
    }
    this.total += count
  }
}

async function fetchDay(
  url: string,
  date: string,
  filename: string,
  stationId: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<{ rows: HourlyStationRow[]; allRows: HourlyStationDataRow[]; warnings: string[]; warningTotal: number }> {
  const response = await fetcher(url, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new Error(`unexpected content type ${boundedMessage(contentType)}`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error('response exceeds the 5 MiB safety limit')
  const text = await readBoundedUtf8(response)
  let payload: unknown
  try { payload = JSON.parse(text) } catch { throw new Error('response JSON is malformed') }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('response schema is invalid')
  const record = payload as Record<string, unknown>
  if (record.date !== date || record.stationId !== stationId || record.sourceFilename !== filename) {
    throw new Error('response date, station ID, or source filename does not match the request')
  }
  if (!Array.isArray(record.rows) || record.rows.length > 24) throw new Error('response rows are invalid or exceed 24 hours')
  if (!Array.isArray(record.warnings) || record.warnings.length > WARNING_CAP || !Number.isSafeInteger(record.warningTotal) || (record.warningTotal as number) < record.warnings.length || (record.warningTotal as number) > MAX_DAY_WARNING_TOTAL) {
    throw new Error('response warnings are invalid')
  }
  const rows: HourlyStationRow[] = record.rows.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('response row is invalid')
    const source = candidate as Record<string, unknown>
    const keys = Object.keys(source)
    if (!keys.includes('timestamp') || keys.some((key) => key !== 'timestamp' && !['SO2', 'NO2', 'O3', 'CO', 'PM10', 'PM2.5'].includes(key))) throw new Error('response row schema is invalid')
    const timestamp = source.timestamp
    if (typeof timestamp !== 'string' || !timestamp.startsWith(`${date} `) || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):00:00$/.test(timestamp)) throw new Error('response row timestamp is invalid')
    const row: HourlyStationRow = { timestamp }
    for (const pollutant of ['SO2', 'NO2', 'O3', 'CO', 'PM10', 'PM2.5'] as const) {
      const value = source[pollutant]
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('response measurement is invalid')
        row[pollutant] = value
      }
    }
    return row
  })
  if (!Array.isArray(record.allRows) || record.allRows.length > 24) {
    throw new Error('response all-data rows are invalid or exceed 24 hours')
  }
  const allRows: HourlyStationDataRow[] = record.allRows.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('response all-data row is invalid')
    const source = candidate as Record<string, unknown>
    if (Object.keys(source).some((key) => key !== 'timestamp' && key !== 'values')) throw new Error('response all-data row schema is invalid')
    const timestamp = source.timestamp
    if (typeof timestamp !== 'string' || !timestamp.startsWith(`${date} `) || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):00:00$/.test(timestamp)) throw new Error('response all-data timestamp is invalid')
    if (!source.values || typeof source.values !== 'object' || Array.isArray(source.values)) throw new Error('response all-data values are invalid')
    const entries = Object.entries(source.values as Record<string, unknown>)
    if (entries.length > MAX_DATA_TYPES_PER_HOUR) throw new Error('response data types exceed the safety limit')
    const values: Record<string, number> = {}
    for (const [type, value] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(type) || typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('response all-data measurement is invalid')
      }
      values[type] = value
    }
    return { timestamp, values }
  })
  const warnings = record.warnings.map((warning) => {
    if (typeof warning !== 'string' || warning.length > 320) throw new Error('response warning is invalid')
    return warning
  })
  return { rows, allRows, warnings, warningTotal: record.warningTotal as number }
}

function retryDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function fetchDayWithRetry(
  url: string,
  date: string,
  filename: string,
  stationId: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): ReturnType<typeof fetchDay> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_DAY_ATTEMPTS; attempt += 1) {
    try {
      return await fetchDay(url, date, filename, stationId, fetcher, signal)
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const retryable = error instanceof TypeError || /^HTTP (?:408|429|5\d\d)$/.test(message)
      if (!retryable || attempt === MAX_DAY_ATTEMPTS) break
      await retryDelay(signal, attempt === 1 ? 100 : 300)
    }
  }
  throw lastError
}

function mergeRows(rows: readonly HourlyStationRow[], warnings: WarningCollector): HourlyStationRow[] {
  const byTimestamp = new Map<string, HourlyStationRow>()
  for (const source of rows) {
    let target = byTimestamp.get(source.timestamp)
    if (!target) {
      target = { timestamp: source.timestamp }
      byTimestamp.set(source.timestamp, target)
    }
    for (const pollutant of ['SO2', 'NO2', 'O3', 'CO', 'PM10', 'PM2.5'] as const) {
      const next = source[pollutant]
      if (!Number.isFinite(next)) continue
      if (Number.isFinite(target[pollutant])) {
        warnings.add(`Duplicate ${source.timestamp} ${pollutant}; kept the first finite value.`)
      } else {
        target[pollutant] = next
      }
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

type DayOutcome =
  | { rows: HourlyStationRow[]; allRows: HourlyStationDataRow[]; warnings: string[]; warningTotal: number }
  | { error: string }

export async function downloadStationRange(options: DownloadStationRangeOptions): Promise<DownloadedStationRange> {
  const endpoint = endpointUrl(options.endpoint)
  const stationId = assertCanonicalStationId(options.stationId)
  const concurrency = normalizeConcurrency(options.concurrency)
  if (options.signal.aborted) throw abortError()
  const links = buildDownloadLinks(options.startDate, options.endDate)
  if (links.length > MAX_DOWNLOAD_RANGE_DAYS) throw new Error('download range exceeds the 366-day safety limit')
  const fetcher = options.fetcher ?? fetch
  const outcomes: Array<DayOutcome | undefined> = Array.from({ length: links.length })
  const internalController = new AbortController()
  let next = 0
  let completed = 0
  let failed = 0
  let stopped = false
  let externallyAborted = false
  let progressFailure: Error | undefined
  const onAbort = () => {
    externallyAborted = true
    stopped = true
    internalController.abort()
  }
  options.signal.addEventListener('abort', onAbort, { once: true })
  const reportProgress = (): void => {
    if (!options.onProgress || stopped) return
    try {
      options.onProgress({ completed, total: links.length, failed })
    } catch (cause) {
      progressFailure = new Error(
        `Progress callback failed: ${boundedMessage(cause instanceof Error ? cause.message : cause)}. Download cancelled.`,
      )
      stopped = true
      internalController.abort()
    }
  }
  try {
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const index = next
        next += 1
        if (index >= links.length) return
        const link = links[index]
        try {
          const result = await fetchDayWithRetry(dayUrl(endpoint, link.date, stationId), link.date, link.filename, stationId, fetcher, internalController.signal)
          if (stopped) return
          outcomes[index] = result
          completed += 1
          reportProgress()
          if (stopped) return
        } catch (error) {
          if (stopped || (error instanceof DOMException && error.name === 'AbortError')) return
          outcomes[index] = { error: boundedMessage(error instanceof Error ? error.message : error) }
          completed += 1
          failed += 1
          reportProgress()
          if (stopped) return
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, links.length) }, worker))
    if (progressFailure) throw progressFailure
    if (externallyAborted) throw abortError()
  } finally {
    options.signal.removeEventListener('abort', onAbort)
  }
  const warnings = new WarningCollector()
  const rows: HourlyStationRow[] = []
  const allRows: HourlyStationDataRow[] = []
  const failedDates: string[] = []
  for (const [index, outcome] of outcomes.entries()) {
    const link = links[index]
    if (!outcome || 'error' in outcome) {
      failedDates.push(link.date)
      warnings.add(`${link.date}: download failed (${outcome?.error ?? 'unknown error'}).`)
      continue
    }
    rows.push(...outcome.rows.map((row) => ({ ...row })))
    allRows.push(...outcome.allRows.map((row) => ({ timestamp: row.timestamp, values: { ...row.values } })))
    for (const warning of outcome.warnings) warnings.add(`${link.date}: ${boundedMessage(warning)}`)
    warnings.addHidden(outcome.warningTotal - outcome.warnings.length)
  }
  if (failedDates.length === links.length) {
    throw new Error('All requested days failed; check the endpoint, station ID, and network access, then retry.')
  }
  if (failedDates.length > 0) {
    const sample = failedDates.slice(0, 5).join('、')
    throw new Error(`下载未完成：${failedDates.length} 个日期失败（${sample}），未生成残缺文件，请重试。`)
  }
  const canonicalRows = mergeRows(rows, warnings)
  const canonicalAllRows = [...allRows]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .map((row) => ({ timestamp: row.timestamp, values: { ...row.values } }))
  const filename = `${stationId}_${options.startDate.replaceAll('-', '')}_${options.endDate.replaceAll('-', '')}.csv`
  return {
    filename,
    csvText: serializeExtractedStationCsv({ stationId, rows: canonicalRows, allRows: canonicalAllRows }),
    rows: canonicalRows.map((row) => ({ ...row })),
    allRows: canonicalAllRows,
    failedDates: [...failedDates].sort(),
    warnings: [...warnings.warnings],
    warningTotal: warnings.total,
  }
}
