import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_STATION_CSV_CONCURRENCY,
  parseStationFile,
  parseStationFiles,
  parseStationInputs,
  MAX_STATION_CSV_FILE_BYTES,
} from '../../src/workers/workerClient'
import { parseExtractedStationCsv, serializeExtractedStationCsv } from '../../src/core/extractedStationCsv'

class FakeWorker {
  static instances: FakeWorker[] = []
  static postError: Error | undefined
  static active = 0
  static maxActive = 0

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  posted: unknown[] = []
  terminated = false
  terminateCalls = 0
  readonly options: WorkerOptions | undefined

  constructor(_url: URL, options?: WorkerOptions) {
    this.options = options
    FakeWorker.instances.push(this)
    FakeWorker.active += 1
    FakeWorker.maxActive = Math.max(FakeWorker.maxActive, FakeWorker.active)
  }

  postMessage(message: unknown): void {
    if (FakeWorker.postError) throw FakeWorker.postError
    this.posted.push(message)
  }

  terminate(): void {
    this.terminateCalls += 1
    if (!this.terminated) FakeWorker.active -= 1
    this.terminated = true
  }
}

describe('parseStationFile', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    FakeWorker.postError = undefined
    FakeWorker.active = 0
    FakeWorker.maxActive = 0
    vi.stubGlobal('Worker', FakeWorker)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('uses a module worker, resolves its result, and terminates it', async () => {
    const file = new File(['csv'], 'sample.csv')
    const pending = parseStationFile(file, '3329A')
    const worker = FakeWorker.instances[0]
    const result = { filename: 'sample.csv', rows: [], warnings: [] }

    expect(worker.options).toEqual({ type: 'module' })
    expect(worker.posted).toEqual([{ kind: 'national-daily', identityPolicy: 'legacy', file, stationId: '3329A' }])
    worker.onmessage?.(new MessageEvent('message', { data: { ok: true, result } }))

    await expect(pending).resolves.toEqual(result)
    expect(worker.terminated).toBe(true)
  })

  it('keeps the legacy single-file API compatible with a non-identity filename', async () => {
    const file = new File(['date,hour,type,3329A\n20241101,0,SO2,1'], 'sample.csv')
    const pending = parseStationFile(file, '3329A')
    const worker = FakeWorker.instances[0]
    expect(worker.posted).toEqual([{ kind: 'national-daily', identityPolicy: 'legacy', file, stationId: '3329A' }])
    worker.onmessage?.(new MessageEvent('message', {
      data: { ok: true, result: { filename: file.name, rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 1 }], warnings: [] } },
    }))
    await expect(pending).resolves.toMatchObject({
      rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 1 }],
    })
  })

  it('rejects a typed worker failure and terminates it', async () => {
    const pending = parseStationFile(new File(['csv'], 'sample.csv'), '3329A')
    const worker = FakeWorker.instances[0]

    worker.onmessage?.(
      new MessageEvent('message', { data: { ok: false, error: '解析失败' } }),
    )

    await expect(pending).rejects.toThrow('解析失败')
    expect(worker.terminated).toBe(true)
  })

  it('rejects a worker runtime error and terminates it', async () => {
    const pending = parseStationFile(new File(['csv'], 'sample.csv'), '3329A')
    const worker = FakeWorker.instances[0]

    worker.onerror?.(new ErrorEvent('error', { message: 'worker crashed' }))

    await expect(pending).rejects.toThrow('worker crashed')
    expect(worker.terminated).toBe(true)
  })

  it('rejects a worker message decoding error and terminates it', async () => {
    const pending = parseStationFile(new File(['csv'], 'sample.csv'), '3329A')
    const worker = FakeWorker.instances[0]

    worker.onmessageerror?.(new MessageEvent('messageerror'))

    await expect(pending).rejects.toThrow('工作线程消息无法解析')
    expect(worker.terminated).toBe(true)
  })

  it('rejects a malformed response envelope without leaving the promise pending', async () => {
    const pending = parseStationFile(new File(['csv'], 'sample.csv'), '3329A')
    const worker = FakeWorker.instances[0]

    worker.onmessage?.(new MessageEvent('message', { data: { ok: true } }))

    await expect(pending).rejects.toThrow('工作线程返回格式无效')
    expect(worker.terminated).toBe(true)
  })

  it('settles and terminates only once when multiple terminal events arrive', async () => {
    const pending = parseStationFile(new File(['csv'], 'sample.csv'), '3329A')
    const worker = FakeWorker.instances[0]
    const deliverMessage = worker.onmessage
    const deliverError = worker.onerror
    const result = { filename: 'sample.csv', rows: [], warnings: [] }

    deliverMessage?.(new MessageEvent('message', { data: { ok: true, result } }))
    deliverError?.(new ErrorEvent('error', { message: 'late crash' }))

    await expect(pending).resolves.toEqual(result)
    expect(worker.terminateCalls).toBe(1)
  })

  it('terminates the worker if posting the request fails', async () => {
    FakeWorker.postError = new Error('clone failed')

    const pending = parseStationFile(new File(['csv'], 'sample.csv'), '3329A')
    const worker = FakeWorker.instances[0]

    await expect(pending).rejects.toThrow('clone failed')
    expect(worker.terminated).toBe(true)
  })

  it('does not launch a worker when already aborted and physically terminates on later abort', async () => {
    const beforeStart = new AbortController()
    beforeStart.abort()
    await expect(parseStationFile(
      new File(['csv'], 'before.csv'),
      '3329A',
      beforeStart.signal,
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(0)

    const during = new AbortController()
    const pending = parseStationFile(new File(['csv'], 'during.csv'), '3329A', during.signal)
    const worker = FakeWorker.instances[0]
    const lateMessage = worker.onmessage
    during.abort()
    lateMessage?.(new MessageEvent('message', {
      data: { ok: true, result: { filename: 'during.csv', rows: [], warnings: [] } },
    }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminateCalls).toBe(1)
  })
})

describe('parseStationFiles', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    FakeWorker.postError = undefined
    FakeWorker.active = 0
    FakeWorker.maxActive = 0
    vi.stubGlobal('Worker', FakeWorker)
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([0, -1, 1.5, MAX_STATION_CSV_CONCURRENCY + 1])(
    'rejects invalid concurrency %s',
    (concurrency) => {
      expect(() => parseStationFiles([], '3329A', concurrency)).toThrow(
        `并发数必须是 1 到 ${MAX_STATION_CSV_CONCURRENCY} 之间的整数`,
      )
    },
  )

  it('bounds active workers and preserves input order', async () => {
    const files = ['a.csv', 'b.csv', 'c.csv', 'd.csv'].map(
      (name) => new File(['csv'], name),
    )
    const pending = parseStationFiles(files, '3329A', 2)

    expect(FakeWorker.instances).toHaveLength(2)
    FakeWorker.instances[1].onmessage?.(
      new MessageEvent('message', {
        data: { ok: true, result: { filename: 'b.csv', rows: [], warnings: [] } },
      }),
    )
    await Promise.resolve()
    expect(FakeWorker.instances).toHaveLength(3)

    FakeWorker.instances[0].onmessage?.(
      new MessageEvent('message', {
        data: { ok: true, result: { filename: 'a.csv', rows: [], warnings: [] } },
      }),
    )
    await Promise.resolve()
    expect(FakeWorker.instances).toHaveLength(4)

    FakeWorker.instances[3].onmessage?.(
      new MessageEvent('message', {
        data: { ok: true, result: { filename: 'd.csv', rows: [], warnings: [] } },
      }),
    )
    FakeWorker.instances[2].onmessage?.(
      new MessageEvent('message', {
        data: { ok: true, result: { filename: 'c.csv', rows: [], warnings: [] } },
      }),
    )

    await expect(pending).resolves.toEqual([
      { filename: 'a.csv', rows: [], warnings: [] },
      { filename: 'b.csv', rows: [], warnings: [] },
      { filename: 'c.csv', rows: [], warnings: [] },
      { filename: 'd.csv', rows: [], warnings: [] },
    ])
    expect(FakeWorker.maxActive).toBe(2)
  })

  it('stops scheduling and terminates in-flight workers after a failure', async () => {
    const files = ['a.csv', 'b.csv', 'c.csv'].map((name) => new File(['csv'], name))
    const pending = parseStationFiles(files, '3329A', 2)
    const [first, second] = FakeWorker.instances

    first.onmessage?.(
      new MessageEvent('message', { data: { ok: false, error: 'bad csv' } }),
    )

    await expect(pending).rejects.toThrow('bad csv')
    expect(FakeWorker.instances).toHaveLength(2)
    expect(first.terminated).toBe(true)
    expect(second.terminated).toBe(true)
  })

  it('aborts a batch once, stops launching, and terminates every active worker', async () => {
    const files = ['a.csv', 'b.csv', 'c.csv'].map((name) => new File(['csv'], name))
    const controller = new AbortController()
    const pending = parseStationFiles(files, '3329A', 2, controller.signal)
    const [first, second] = FakeWorker.instances
    const lateFirst = first.onmessage
    controller.abort()
    lateFirst?.(new MessageEvent('message', {
      data: { ok: true, result: { filename: 'a.csv', rows: [], warnings: [] } },
    }))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(2)
    expect(first.terminateCalls).toBe(1)
    expect(second.terminateCalls).toBe(1)

    const beforeStart = new AbortController()
    beforeStart.abort()
    await expect(parseStationFiles(files, '3329A', beforeStart.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(FakeWorker.instances).toHaveLength(2)
  })
})

describe('parseStationInputs', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    FakeWorker.postError = undefined
    FakeWorker.active = 0
    FakeWorker.maxActive = 0
    vi.stubGlobal('Worker', FakeWorker)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('round-trips a real station-wide CSV and rejects missing station metadata', () => {
    const csv = serializeExtractedStationCsv({
      stationId: '3329A',
      rows: [
        { timestamp: '2024-11-01 00:00:00', SO2: 1 },
        { timestamp: '2024-11-01 01:00:00', SO2: 2 },
      ],
    })
    expect(parseExtractedStationCsv(csv).rows).toEqual([
      { timestamp: '2024-11-01 00:00:00', SO2: 1 },
      { timestamp: '2024-11-01 01:00:00', SO2: 2 },
    ])
    expect(() => parseExtractedStationCsv(csv.replace('3329A', ''))).toThrow('站点编号格式无效')
  })

  it('detects a daily file from a bounded preview before dispatching a typed worker request', async () => {
    const file = new File(['date,hour,type,3329A\n20241101,0,SO2,1'], 'china_sites_20241101.csv')
    const pending = parseStationInputs([file], '3329A')
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
    const worker = FakeWorker.instances[0]
    expect(worker.posted).toEqual([{ kind: 'national-daily', identityPolicy: 'strict', file, stationId: '3329A' }])
    worker.onmessage?.(new MessageEvent('message', { data: { ok: true, result: { filename: file.name, rows: [], warnings: [] } } }))
    await expect(pending).resolves.toEqual([{ filename: file.name, rows: [], warnings: [] }])
  })

  it('rejects mixed formats before launching workers', async () => {
    const national = new File(['date,hour,type,3329A\n20241101,0,SO2,1'], 'china_sites_20241101.csv')
    const wide = new File([serializeExtractedStationCsv({
      stationId: '3329A', rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 1 }],
    })], '3329A_20241101_20241101.csv')
    await expect(parseStationInputs([national, wide], '3329A')).rejects.toThrow(/不能混合/)
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('rejects a second station-wide file before launching workers', async () => {
    const content = serializeExtractedStationCsv({
      stationId: '3329A', rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 1 }],
    })
    await expect(parseStationInputs([
      new File([content], '3329A_20241101_20241101.csv'),
      new File([content], '3329A_20241101_20241101.csv'),
    ], '3329A')).rejects.toThrow(/一次只能导入一个/)
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('rejects oversized national and station-wide inputs before creating workers', async () => {
    const tooLarge = new Uint8Array(MAX_STATION_CSV_FILE_BYTES + 1)
    const national = new File([tooLarge], 'china_sites_20241101.csv')
    await expect(parseStationInputs([national], '3329A')).rejects.toThrow(/大小/)
    const wide = new File([tooLarge], '3329A_20241101_20241101.csv')
    await expect(parseStationInputs([wide], '3329A')).rejects.toThrow(/大小/)
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('rejects a batch whose combined bytes exceed the cap before workers launch', async () => {
    const eightMiB = new Uint8Array(MAX_STATION_CSV_FILE_BYTES)
    const files = Array.from({ length: 5 }, (_, index) =>
      new File([eightMiB], `china_sites_2024110${index + 1}.csv`),
    )
    await expect(parseStationInputs(files, '3329A')).rejects.toThrow(/总大小/)
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('dispatches a serialized station-wide CSV to the worker and terminates it after success', async () => {
    const file = new File([serializeExtractedStationCsv({
      stationId: '3329A', rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 1 }],
    })], '3329A_20241101_20241101.csv')
    const pending = parseStationInputs([file], '3329A')
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
    const worker = FakeWorker.instances[0]
    expect(worker.posted).toEqual([{ kind: 'station-wide', identityPolicy: 'strict', file, stationId: '3329A' }])
    worker.onmessage?.(new MessageEvent('message', {
      data: { ok: true, result: { filename: file.name, rows: [], warnings: [] } },
    }))
    await expect(pending).resolves.toEqual([{ filename: file.name, rows: [], warnings: [] }])
    expect(worker.terminated).toBe(true)
  })

  it('does not launch or resolve a station-wide worker after abort', async () => {
    const file = new File([serializeExtractedStationCsv({
      stationId: '3329A', rows: [{ timestamp: '2024-11-01 00:00:00', SO2: 1 }],
    })], '3329A_20241101_20241101.csv')
    const before = new AbortController()
    before.abort()
    await expect(parseStationInputs([file], '3329A', before.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(0)

    const during = new AbortController()
    const pending = parseStationInputs([file], '3329A', during.signal)
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
    const worker = FakeWorker.instances[0]
    const lateMessage = worker.onmessage
    during.abort()
    lateMessage?.(new MessageEvent('message', { data: { ok: true, result: { filename: file.name, rows: [], warnings: [] } } }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminateCalls).toBe(1)
  })
})

describe('stationCsv worker size guard', () => {
  it('rejects an oversized file before its text method is called', async () => {
    const scope = {
      onmessage: null as ((event: MessageEvent) => Promise<void>) | null,
      postMessage: vi.fn(),
    }
    vi.stubGlobal('self', scope)
    const { handleStationWorkerRequest } = await import('../../src/workers/stationCsv.worker')
    const text = vi.fn()
    const file = {
      name: 'china_sites_20241101.csv',
      size: MAX_STATION_CSV_FILE_BYTES + 1,
      text,
    } as unknown as File

    await scope.onmessage?.(new MessageEvent('message', {
      data: { kind: 'national-daily', file, stationId: '3329A' },
    }))
    const wideText = vi.fn()
    await scope.onmessage?.(new MessageEvent('message', {
      data: {
        kind: 'station-wide',
        file: { name: '3329A_20241101_20241101.csv', size: MAX_STATION_CSV_FILE_BYTES + 1, text: wideText } as unknown as File,
        stationId: '3329A',
      },
    }))
    expect(text).not.toHaveBeenCalled()
    expect(wideText).not.toHaveBeenCalled()
    expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))

    const legacyFile = {
      name: 'sample.csv',
      size: 32,
      text: vi.fn().mockResolvedValue('date,hour,type,3329A\n20241101,0,SO2,1'),
    } as unknown as File
    await expect(handleStationWorkerRequest({
      kind: 'national-daily', identityPolicy: 'legacy', file: legacyFile, stationId: '3329A',
    })).resolves.toMatchObject({ ok: true })
    await expect(handleStationWorkerRequest({
      kind: 'national-daily', identityPolicy: 'strict', file: legacyFile, stationId: '3329A',
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/文件名/) })
    vi.unstubAllGlobals()
  })
})
