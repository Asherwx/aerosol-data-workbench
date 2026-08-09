import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createResultZip } from '../../src/core/exports'
import { createResultZipDirect } from '../../src/core/resultZip'

async function blobBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })
}

class FakeResultZipWorker {
  static instances: FakeResultZipWorker[] = []
  static postError: Error | undefined
  static constructorError: Error | undefined

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  posted: unknown[] = []
  transferLists: Transferable[][] = []
  terminateCalls = 0
  readonly options: WorkerOptions | undefined

  constructor(_url: URL, options?: WorkerOptions) {
    if (FakeResultZipWorker.constructorError) throw FakeResultZipWorker.constructorError
    this.options = options
    FakeResultZipWorker.instances.push(this)
  }

  postMessage(message: unknown, optionsOrTransfer?: StructuredSerializeOptions | Transferable[]): void {
    if (FakeResultZipWorker.postError) throw FakeResultZipWorker.postError
    this.posted.push(message)
    this.transferLists.push(Array.isArray(optionsOrTransfer) ? optionsOrTransfer : optionsOrTransfer?.transfer ?? [])
  }

  terminate(): void {
    this.terminateCalls += 1
  }
}

describe('result ZIP direct builder', () => {
  it('round-trips ordered names and bytes deterministically', async () => {
    const request = [
      { name: 'data/a.csv', buffer: new TextEncoder().encode('时间,值\r\n').buffer },
      { name: 'report.bin', buffer: new Uint8Array([1, 2, 3]).buffer },
    ]
    const first = await createResultZipDirect(request)
    const second = await createResultZipDirect(request)
    expect(new Uint8Array(second)).toEqual(new Uint8Array(first))

    const zip = await JSZip.loadAsync(first)
    expect(Object.keys(zip.files)).toEqual(['data/a.csv', 'report.bin'])
    expect(await zip.file('data/a.csv')?.async('string')).toBe('时间,值\r\n')
    expect(await zip.file('report.bin')?.async('uint8array')).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('result ZIP worker protocol', () => {
  beforeEach(() => {
    FakeResultZipWorker.instances = []
    FakeResultZipWorker.postError = undefined
    FakeResultZipWorker.constructorError = undefined
    vi.stubGlobal('Worker', FakeResultZipWorker)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('copies and transfers bounded materialized contents then resolves once', async () => {
    const source = new Uint8Array([1, 2, 3])
    const pending = createResultZip([
      { name: 'a.txt', content: 'abc' },
      { name: 'b.bin', content: source },
      { name: 'c.bin', content: new Blob([new Uint8Array([4, 5])]) },
    ])
    await vi.waitFor(() => expect(FakeResultZipWorker.instances).toHaveLength(1))
    const worker = FakeResultZipWorker.instances[0]
    const request = worker.posted[0] as { files: Array<{ name: string; buffer: ArrayBuffer }> }
    expect(worker.options).toEqual({ type: 'module', name: 'result-zip-export' })
    expect(request.files.map((file) => file.name)).toEqual(['a.txt', 'b.bin', 'c.bin'])
    expect(worker.transferLists[0]).toEqual(request.files.map((file) => file.buffer))
    expect(new Uint8Array(request.files[1].buffer)).toEqual(new Uint8Array([1, 2, 3]))

    const resultBuffer = new Uint8Array([80, 75, 1, 2]).buffer
    const lateError = worker.onerror
    worker.onmessage?.(new MessageEvent('message', { data: { ok: true, buffer: resultBuffer } }))
    lateError?.(new ErrorEvent('error', { message: 'late crash' }))
    expect(new Uint8Array(await blobBuffer(await pending))).toEqual(new Uint8Array(resultBuffer))
    expect(worker.terminateCalls).toBe(1)
  })

  it('rejects typed, runtime, message decoding, malformed, and post failures with cleanup', async () => {
    const typed = createResultZip([{ name: 'a.txt', content: 'x' }])
    await vi.waitFor(() => expect(FakeResultZipWorker.instances).toHaveLength(1))
    FakeResultZipWorker.instances[0].onmessage?.(new MessageEvent('message', { data: { ok: false, message: '压缩失败' } }))
    await expect(typed).rejects.toThrow('压缩失败')
    expect(FakeResultZipWorker.instances[0].terminateCalls).toBe(1)

    const runtime = createResultZip([{ name: 'a.txt', content: 'x' }])
    await vi.waitFor(() => expect(FakeResultZipWorker.instances).toHaveLength(2))
    FakeResultZipWorker.instances[1].onerror?.(new ErrorEvent('error', { message: 'zip crashed' }))
    await expect(runtime).rejects.toThrow('zip crashed')
    expect(FakeResultZipWorker.instances[1].terminateCalls).toBe(1)

    const decoding = createResultZip([{ name: 'a.txt', content: 'x' }])
    await vi.waitFor(() => expect(FakeResultZipWorker.instances).toHaveLength(3))
    FakeResultZipWorker.instances[2].onmessageerror?.(new MessageEvent('messageerror'))
    await expect(decoding).rejects.toThrow('消息')
    expect(FakeResultZipWorker.instances[2].terminateCalls).toBe(1)

    const malformed = createResultZip([{ name: 'a.txt', content: 'x' }])
    await vi.waitFor(() => expect(FakeResultZipWorker.instances).toHaveLength(4))
    FakeResultZipWorker.instances[3].onmessage?.(new MessageEvent('message', { data: { ok: true, buffer: 'bad' } }))
    await expect(malformed).rejects.toThrow('格式无效')
    expect(FakeResultZipWorker.instances[3].terminateCalls).toBe(1)

    FakeResultZipWorker.postError = new Error('clone failed')
    await expect(createResultZip([{ name: 'a.txt', content: 'x' }])).rejects.toThrow('clone failed')
    expect(FakeResultZipWorker.instances[4].terminateCalls).toBe(1)
  })

  it('fails closed when Worker is unavailable or construction is blocked', async () => {
    vi.stubGlobal('Worker', undefined)
    await expect(createResultZip([{ name: 'a.txt', content: 'x' }])).rejects.toThrow(/浏览器.*后台|后台.*浏览器/)

    vi.stubGlobal('Worker', FakeResultZipWorker)
    FakeResultZipWorker.constructorError = new Error('blocked')
    await expect(createResultZip([{ name: 'a.txt', content: 'x' }])).rejects.toThrow(/后台.*升级|升级.*后台/)
  })

  it('rejects an invalid timeout before reading file contents', async () => {
    const blob = new Blob([])
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    Object.defineProperty(blob, 'arrayBuffer', { value: arrayBuffer })
    await expect(createResultZip(
      [{ name: 'a.bin', content: blob }],
      { timeoutMs: 0 },
    )).rejects.toThrow('整数')
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(FakeResultZipWorker.instances).toHaveLength(0)
  })

  it('times out and aborts while terminating exactly once', async () => {
    vi.useFakeTimers()
    const timeout = createResultZip([{ name: 'a.txt', content: 'x' }], { timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(0)
    const timeoutWorker = FakeResultZipWorker.instances[0]
    const timeoutAssertion = expect(timeout).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(50)
    await timeoutAssertion
    expect(timeoutWorker.terminateCalls).toBe(1)

    const controller = new AbortController()
    const aborted = createResultZip([{ name: 'a.txt', content: 'x' }], { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    const abortWorker = FakeResultZipWorker.instances[1]
    controller.abort()
    await expect(aborted).rejects.toThrow('取消')
    expect(abortWorker.terminateCalls).toBe(1)
  })
})
