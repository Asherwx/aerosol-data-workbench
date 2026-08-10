import { describe, expect, it } from 'vitest'

import { downloadStationRange, isSafeStationEndpoint } from '../../src/core/onlineStationDownload'

const signal = new AbortController().signal

function stationDayResponse(date: string, value: number): string {
  return JSON.stringify({
    date,
    stationId: '3329A',
    sourceFilename: `china_sites_${date.replaceAll('-', '')}.csv`,
    rows: [{ timestamp: `${date} 01:00:00`, SO2: value }],
    allRows: [{ timestamp: `${date} 01:00:00`, values: { SO2: value, AQI: 80, SO2_24h: 12 } }],
    warnings: [],
    warningTotal: 0,
  })
}

describe('downloadStationRange', () => {
  it('shares a pure endpoint safety predicate with callers', () => {
    expect(isSafeStationEndpoint('https://example.test/v1/station-day')).toBe(true)
    expect(isSafeStationEndpoint('http://localhost:8787/v1/station-day')).toBe(true)
    expect(isSafeStationEndpoint('http://127.0.0.1:8787/v1/station-day')).toBe(true)
    expect(isSafeStationEndpoint('http://example.test/v1/station-day')).toBe(false)
    expect(isSafeStationEndpoint('https://user@example.test/v1/station-day')).toBe(false)
    expect(isSafeStationEndpoint('https://example.test/v1/station-day#fragment')).toBe(false)
    expect(isSafeStationEndpoint('not a url')).toBe(false)
  })

  it('downloads a bounded range with mocked fetch, stable sorting, and a deterministic filename', async () => {
    let active = 0
    let maximum = 0
    const fetcher: typeof fetch = async (input) => {
      active += 1
      maximum = Math.max(maximum, active)
      const url = new URL(String(input))
      const date = url.searchParams.get('date') ?? ''
      await new Promise((resolve) => setTimeout(resolve, date === '2024-11-01' ? 5 : 0))
      active -= 1
      return new Response(stationDayResponse(date, Number(date.slice(-2))), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    const result = await downloadStationRange({
      startDate: '2024-11-01',
      endDate: '2024-11-03',
      stationId: '3329A',
      endpoint: 'https://example.test/data',
      signal,
      concurrency: 2,
      fetcher,
    })

    expect(maximum).toBe(2)
    expect(result.filename).toBe('3329A_20241101_20241103.csv')
    expect(result.rows.map((row) => row.timestamp)).toEqual([
      '2024-11-01 01:00:00',
      '2024-11-02 01:00:00',
      '2024-11-03 01:00:00',
    ])
    expect(result.failedDates).toEqual([])
    expect(result.warningTotal).toBe(0)
  })

  it('batches daily requests by default to avoid browser transport exhaustion', async () => {
    let active = 0
    let maximum = 0
    const urls: string[] = []
    await downloadStationRange({
      startDate: '2024-11-01', endDate: '2024-11-03', stationId: '3329A', endpoint: 'https://example.test/data', signal,
      fetcher: async (input) => {
        active += 1
        maximum = Math.max(maximum, active)
        urls.push(String(input))
        const dates = new URL(String(input)).searchParams.get('dates')?.split(',') ?? []
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return new Response(JSON.stringify({ days: dates.map((date) => JSON.parse(stationDayResponse(date, 1))) }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    expect(maximum).toBe(1)
    expect(urls).toHaveLength(1)
    expect(new URL(urls[0]).searchParams.get('dates')).toBe('2024-11-01,2024-11-02,2024-11-03')
  })

  it('limits each browser batch to six dates', async () => {
    const batchSizes: number[] = []
    const result = await downloadStationRange({
      startDate: '2024-11-01', endDate: '2024-11-13', stationId: '3329A', endpoint: 'https://example.test/data', signal,
      fetcher: async (input) => {
        const dates = new URL(String(input)).searchParams.get('dates')?.split(',') ?? []
        batchSizes.push(dates.length)
        return new Response(JSON.stringify({ days: dates.map((date) => JSON.parse(stationDayResponse(date, 1))) }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    expect(batchSizes).toEqual([6, 6, 1])
    expect(result.rows).toHaveLength(13)
  })

  it('refuses to create a partial file when any requested date still fails', async () => {
    await expect(downloadStationRange({
      startDate: '2024-11-01',
      endDate: '2024-11-03',
      stationId: '3329A',
      endpoint: 'https://example.test/data',
      signal,
      concurrency: 1,
      fetcher: async (input) => {
        if (String(input).includes('2024-11-02')) return new Response('nope', { status: 503 })
        const date = new URL(String(input)).searchParams.get('date') ?? '2024-11-01'
        return new Response(stationDayResponse(date, 1), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })).rejects.toThrow(/2024-11-02.*未生成残缺文件/)
  })

  it('retries a transient day failure and exports all returned station data types', async () => {
    let attempts = 0
    const result = await downloadStationRange({
      startDate: '2024-11-01', endDate: '2024-11-01', stationId: '3329A', endpoint: 'https://example.test/data', signal,
      fetcher: async () => {
        attempts += 1
        if (attempts === 1) return new Response('temporary', { status: 503 })
        return new Response(stationDayResponse('2024-11-01', 3), { headers: { 'content-type': 'application/json' } })
      },
    })

    expect(attempts).toBe(2)
    expect(result.failedDates).toEqual([])
    expect(result.csvText).toContain(',AQI,')
    expect(result.csvText).toContain(',SO2_24h')
    expect(result.csvText).toContain(',80,12')
  })

  it('rejects unsafe endpoints, invalid ranges and invalid concurrency before starting fetches', async () => {
    const options = {
      startDate: '2024-11-01', endDate: '2024-11-01', stationId: '3329A', signal,
      fetcher: (() => { throw new Error('must not fetch') }) as typeof fetch,
    }
    await expect(downloadStationRange({ ...options, endpoint: 'http://example.test' })).rejects.toThrow(/HTTPS/)
    await expect(downloadStationRange({ ...options, endpoint: 'https://user@example.test/data' })).rejects.toThrow(/endpoint/)
    await expect(downloadStationRange({ ...options, endpoint: 'https://example.test/#part' })).rejects.toThrow(/endpoint/)
    await expect(downloadStationRange({ ...options, endpoint: 'https://example.test', concurrency: 0 })).rejects.toThrow(/concurrency/)
    await expect(downloadStationRange({ ...options, endpoint: 'https://example.test', concurrency: Number.NaN })).rejects.toThrow(/concurrency/)
    await expect(downloadStationRange({ ...options, endpoint: 'https://example.test', concurrency: 1.5 })).rejects.toThrow(/concurrency/)
    await expect(downloadStationRange({ ...options, endpoint: 'https://example.test', startDate: '2024-02-30' })).rejects.toThrow()
    await expect(downloadStationRange({ ...options, endpoint: 'https://example.test', startDate: '2024-11-02', endDate: '2024-11-01' })).rejects.toThrow()
    await expect(downloadStationRange({ ...options, endpoint: 'https://example.test', stationId: ' =bad' })).rejects.toThrow('站点编号格式无效')
  })

  it('does not launch requests when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let launches = 0
    await expect(downloadStationRange({
      startDate: '2024-11-01', endDate: '2024-11-03', stationId: '3329A', endpoint: 'https://example.test', signal: controller.signal,
      fetcher: (() => { launches += 1; throw new Error('unexpected') }) as typeof fetch,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(launches).toBe(0)
  })

  it('clamps high concurrency and makes an all-days-failed error actionable', async () => {
    let active = 0
    let maximum = 0
    await expect(downloadStationRange({
      startDate: '2024-11-01', endDate: '2024-11-05', stationId: '3329A', endpoint: 'https://example.test', concurrency: 99,
      signal,
      fetcher: async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return new Response('unavailable', { status: 503 })
      },
    })).rejects.toThrow(/All requested days failed.*endpoint.*station ID/i)
    expect(maximum).toBe(4)
  })

  it('requires a signal in the public options type and reports cumulative progress', async () => {
    const missingSignal = { startDate: '2024-11-01', endDate: '2024-11-01', stationId: '3329A', endpoint: 'https://example.test' }
    if (false) {
      // @ts-expect-error signal is mandatory for the cancellable public API
      void downloadStationRange(missingSignal)
    }
    const progress: Array<{ completed: number; total: number; failed: number }> = []
    await expect(downloadStationRange({
      startDate: '2024-11-01', endDate: '2024-11-02', stationId: '3329A', endpoint: 'https://example.test', signal, concurrency: 1,
      fetcher: async (input) => String(input).includes('2024-11-02')
        ? new Response('nope', { status: 503 })
        : new Response(stationDayResponse('2024-11-01', 1), { headers: { 'content-type': 'application/json' } }),
      onProgress: (next) => progress.push(next),
    })).rejects.toThrow(/2024-11-02.*未生成残缺文件/)
    expect(progress).toEqual([
      { completed: 1, total: 2, failed: 0 },
      { completed: 2, total: 2, failed: 1 },
    ])
  })

  it('rejects non-canonical station IDs before fetching and orders warnings by date', async () => {
    let launches = 0
    await expect(downloadStationRange({
      startDate: '2024-11-01', endDate: '2024-11-01', stationId: 'abc', endpoint: 'https://example.test', signal,
      fetcher: (() => { launches += 1; throw new Error('unexpected') }) as typeof fetch,
    })).rejects.toThrow('站点编号格式无效')
    expect(launches).toBe(0)

    await expect(downloadStationRange({
      startDate: '2024-11-01', endDate: '2024-11-03', stationId: '3329A', endpoint: 'https://example.test', signal, concurrency: 2,
      fetcher: async (input) => {
        const date = new URL(String(input)).searchParams.get('date') ?? ''
        await new Promise((resolve) => setTimeout(resolve, date === '2024-11-01' ? 5 : 0))
        if (date === '2024-11-03') return new Response('nope', { status: 503 })
        const payload = JSON.parse(stationDayResponse(date, 1)) as Record<string, unknown>
        payload.warnings = [`warning-${date}`]
        payload.warningTotal = 2
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
      },
    })).rejects.toThrow(/2024-11-03.*未生成残缺文件/)
  })

  it('fails fast when progress throws, aborts active requests, and makes no late updates', async () => {
    const controller = new AbortController()
    let launches = 0
    let aborted = 0
    const progress: Array<{ completed: number; total: number; failed: number }> = []
    await expect(downloadStationRange({
      startDate: '2024-11-01', endDate: '2024-11-04', stationId: '3329A', endpoint: 'https://example.test', signal: controller.signal, concurrency: 2,
      fetcher: (async (input, init) => {
        launches += 1
        const date = new URL(String(input)).searchParams.get('date') ?? ''
        if (date === '2024-11-01') return new Response(stationDayResponse(date, 1), { headers: { 'content-type': 'application/json' } })
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { aborted += 1; reject(new DOMException('aborted', 'AbortError')) }, { once: true })
        })
      }) as typeof fetch,
      onProgress: (next) => {
        progress.push(next)
        throw new Error('callback boom')
      },
    })).rejects.toThrow(/progress callback failed.*callback boom/i)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(progress).toEqual([{ completed: 1, total: 4, failed: 0 }])
    expect(launches).toBe(2)
    expect(aborted).toBe(1)
  })

  it('rejects malicious per-day warning totals and preserves bounded multi-day totals', async () => {
    await expect(downloadStationRange({
      startDate: '2024-11-01', endDate: '2024-11-03', stationId: '3329A', endpoint: 'https://example.test', signal, concurrency: 1,
      fetcher: async (input) => {
        const date = new URL(String(input)).searchParams.get('date') ?? ''
        const payload = JSON.parse(stationDayResponse(date, 1)) as Record<string, unknown>
        payload.warningTotal = date === '2024-11-02' ? Number.MAX_SAFE_INTEGER : 1_000_000
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
      },
    })).rejects.toThrow(/2024-11-02.*未生成残缺文件/)
  })
})
