import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ION_WORKBOOK_WORKER_TIMEOUT_MS,
  parseIonWorkbook,
} from '../../src/core/ionWorkbook'

class FakeWorker {
  static instances: FakeWorker[] = []
  static postError: Error | undefined

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  posted: Array<{ message: unknown; transfer: Transferable[] | undefined }> = []
  terminated = false
  terminateCalls = 0
  readonly options: WorkerOptions | undefined

  constructor(_url: URL, options?: WorkerOptions) {
    this.options = options
    FakeWorker.instances.push(this)
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (FakeWorker.postError) throw FakeWorker.postError
    this.posted.push({ message, transfer })
  }

  terminate(): void {
    this.terminateCalls += 1
    this.terminated = true
  }
}

function fixtureBuffer(): ArrayBuffer {
  const bytes = readFileSync('tests/fixtures/ions-small.xlsx')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

describe('parseIonWorkbook worker client', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    FakeWorker.postError = undefined
    vi.stubGlobal('Worker', FakeWorker)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('preflights, transfers a copy to a module worker, validates success, and terminates', async () => {
    const input = fixtureBuffer()
    const pending = parseIonWorkbook(input, 'fixture.xlsx')
    const worker = FakeWorker.instances[0]

    expect(worker.options).toEqual({ type: 'module' })
    expect(worker.posted).toHaveLength(1)
    const request = worker.posted[0]?.message as { buffer: ArrayBuffer }
    expect(request.buffer).not.toBe(input)
    expect(worker.posted[0]?.transfer).toEqual([request.buffer])
    worker.onmessage?.(
      new MessageEvent('message', {
        data: {
          ok: true,
          result: {
            sheetName: '站点数据',
            rows: [{ timestamp: '2024-01-01 00:00:00', NO3: 1, SO4: 2, NH4: 3 }],
            warnings: [],
          },
        },
      }),
    )

    await expect(pending).resolves.toMatchObject({
      sheetName: '站点数据',
      rows: [{ timestamp: '2024-01-01 00:00:00', NO3: 1, SO4: 2, NH4: 3 }],
    })
    expect(worker.terminated).toBe(true)
  })

  it('reconstructs a compact canonical result and strips every extra response key', async () => {
    const pending = parseIonWorkbook(fixtureBuffer(), 'compact.xlsx')
    const worker = FakeWorker.instances[0]
    worker.onmessage?.(
      new MessageEvent('message', {
        data: {
          ok: true,
          rawMatrix: [['secret']],
          result: {
            sheetName: 'Data',
            sheets: [{ data: [['secret']] }],
            rows: [{
              timestamp: '2024-01-01 00:00:00',
              NO3: 1,
              data: [['secret']],
            }],
            warnings: [],
          },
        },
      }),
    )

    await expect(pending).resolves.toEqual({
      sheetName: 'Data',
      rows: [{ timestamp: '2024-01-01 00:00:00', NO3: 1 }],
      warnings: [],
    })
  })

  it('sanitizes and bounds sheet names and warning strings from the worker', async () => {
    const pending = parseIonWorkbook(fixtureBuffer(), 'sanitize.xlsx')
    const worker = FakeWorker.instances[0]
    worker.onmessage?.(
      new MessageEvent('message', {
        data: {
          ok: true,
          result: {
            sheetName: `safe\n\u202E${'s'.repeat(200)}`,
            rows: [],
            warnings: [`warning\r\n\u2066${'w'.repeat(1200)}`],
          },
        },
      }),
    )

    const result = await pending
    expect(result.sheetName).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
    expect(result.sheetName.length).toBeLessThanOrEqual(120)
    expect(result.warnings[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
    expect(result.warnings[0]?.length).toBeLessThanOrEqual(1_000)
  })

  it('reads a File into an ArrayBuffer before preflight and worker transfer', async () => {
    const buffer = fixtureBuffer()
    const file = {
      size: buffer.byteLength,
      arrayBuffer: vi.fn().mockResolvedValue(buffer),
    } as unknown as File
    const pending = parseIonWorkbook(file, 'file-input.xlsx')
    await Promise.resolve()
    const worker = FakeWorker.instances[0]
    expect(file.arrayBuffer).toHaveBeenCalledOnce()
    expect(worker.posted[0]?.transfer).toHaveLength(1)
    worker.onmessage?.(
      new MessageEvent('message', {
        data: {
          ok: true,
          result: { sheetName: '站点数据', rows: [], warnings: [] },
        },
      }),
    )
    await expect(pending).resolves.toMatchObject({ sheetName: '站点数据' })
    expect(worker.terminated).toBe(true)
  })

  it('aborts while a File read is pending without creating a worker', async () => {
    let completeRead: ((buffer: ArrayBuffer) => void) | undefined
    const file = {
      size: fixtureBuffer().byteLength,
      arrayBuffer: vi.fn(() => new Promise<ArrayBuffer>((resolve) => { completeRead = resolve })),
    } as unknown as File
    const controller = new AbortController()
    const pending = parseIonWorkbook(file, 'pending-read.xlsx', { signal: controller.signal })

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(0)
    completeRead?.(fixtureBuffer())
    await Promise.resolve()
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('rejects cancellation and terminates exactly once', async () => {
    const controller = new AbortController()
    const pending = parseIonWorkbook(fixtureBuffer(), 'cancel.xlsx', {
      signal: controller.signal,
    })
    const worker = FakeWorker.instances[0]
    controller.abort()
    worker.onerror?.(new ErrorEvent('error', { message: 'late failure' }))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminateCalls).toBe(1)
  })

  it('ignores abort and error events after a successful settlement', async () => {
    const controller = new AbortController()
    const pending = parseIonWorkbook(fixtureBuffer(), 'success-race.xlsx', {
      signal: controller.signal,
    })
    const worker = FakeWorker.instances[0]
    const deliverMessage = worker.onmessage
    const deliverError = worker.onerror
    deliverMessage?.(new MessageEvent('message', { data: {
      ok: true,
      result: { sheetName: 'Data', rows: [], warnings: [] },
    } }))
    controller.abort()
    deliverError?.(new ErrorEvent('error', { message: 'late failure' }))

    await expect(pending).resolves.toEqual({ sheetName: 'Data', rows: [], warnings: [] })
    expect(worker.terminateCalls).toBe(1)
  })

  it('rejects a malformed response and terminates', async () => {
    const pending = parseIonWorkbook(fixtureBuffer(), 'malformed.xlsx')
    const worker = FakeWorker.instances[0]
    worker.onmessage?.(
      new MessageEvent('message', {
        data: {
          ok: true,
          sheets: [{ sheet: '站点数据', data: [['时间', 'NO3', 'SO4', 'NH4']] }],
        },
      }),
    )

    await expect(pending).rejects.toThrow(/工作线程返回格式无效/)
    expect(worker.terminated).toBe(true)
  })

  it('terminates on typed failure and messageerror', async () => {
    const failed = parseIonWorkbook(fixtureBuffer(), 'failure.xlsx')
    const first = FakeWorker.instances[0]
    first.onmessage?.(
      new MessageEvent('message', { data: { ok: false, error: 'low\nlevel'.repeat(100) } }),
    )
    let failure: unknown
    try {
      await failed
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    const failureMessage = failure instanceof Error ? failure.message : ''
    expect(failureMessage).toMatch(/XLSX 解析失败/)
    expect(failureMessage).not.toMatch(/[\r\n]/)
    expect(failureMessage.length).toBeLessThan(500)
    expect(first.terminated).toBe(true)

    const decoding = parseIonWorkbook(fixtureBuffer(), 'decoding.xlsx')
    const second = FakeWorker.instances[1]
    second.onmessageerror?.(new MessageEvent('messageerror'))
    await expect(decoding).rejects.toThrow(/工作线程消息无法解析/)
    expect(second.terminated).toBe(true)
  })

  it('terminates on a worker runtime error', async () => {
    const pending = parseIonWorkbook(fixtureBuffer(), 'runtime.xlsx')
    const worker = FakeWorker.instances[0]
    worker.onerror?.(new ErrorEvent('error', { message: 'worker crashed' }))

    await expect(pending).rejects.toThrow(/worker crashed/)
    expect(worker.terminated).toBe(true)
  })

  it('does not create a worker when ZIP preflight fails', async () => {
    await expect(
      parseIonWorkbook(new TextEncoder().encode('not a zip').buffer, 'bad.xlsx'),
    ).rejects.toThrow(/ZIP.*无效/)
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('terminates and bounds diagnostics when posting the transferable fails', async () => {
    FakeWorker.postError = new Error(`clone\n${'x'.repeat(1000)}`)
    const pending = parseIonWorkbook(fixtureBuffer(), 'post.xlsx')
    const worker = FakeWorker.instances[0]
    let failure: unknown
    try {
      await pending
    } catch (error) {
      failure = error
    }
    const message = failure instanceof Error ? failure.message : ''
    expect(message).toMatch(/发送.*失败/)
    expect(message).not.toMatch(/[\r\n]/)
    expect(message.length).toBeLessThan(500)
    expect(worker.terminated).toBe(true)
  })

  it('terminates and rejects with an actionable error when the worker times out', async () => {
    vi.useFakeTimers()
    try {
      const pending = parseIonWorkbook(fixtureBuffer(), 'slow.xlsx')
      const worker = FakeWorker.instances[0]
      const rejection = expect(pending).rejects.toThrow(/slow\.xlsx.*60 秒.*超时.*重试/s)
      await vi.advanceTimersByTimeAsync(ION_WORKBOOK_WORKER_TIMEOUT_MS)

      await rejection
      expect(worker.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores late messages and errors after timeout settlement', async () => {
    vi.useFakeTimers()
    try {
      const pending = parseIonWorkbook(fixtureBuffer(), 'late-timeout.xlsx')
      const worker = FakeWorker.instances[0]
      const deliverMessage = worker.onmessage
      const deliverError = worker.onerror
      const rejection = expect(pending).rejects.toThrow(/60/)
      await vi.advanceTimersByTimeAsync(ION_WORKBOOK_WORKER_TIMEOUT_MS)
      deliverMessage?.(new MessageEvent('message', { data: {
        ok: true,
        result: { sheetName: 'late', rows: [], warnings: [] },
      } }))
      deliverError?.(new ErrorEvent('error', { message: 'late failure' }))

      await rejection
      expect(worker.terminateCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
