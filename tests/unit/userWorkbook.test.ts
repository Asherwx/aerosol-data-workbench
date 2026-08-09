import { readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  USER_WORKBOOK_MAX_TIMEOUT_MS,
  MAX_USER_SHEETS,
  parseUserCsvFile,
  parseUserWorkbook,
} from '../../src/core/userWorkbook'
import { parseUserCsvBuffer, parseUserWorkbookBuffer } from '../../src/workers/userWorkbook.worker'
import { USER_CSV_MAX_BYTES, parseUserCsv } from '../../src/core/userDataset'

class FakeWorker {
  static instances: FakeWorker[] = []
  static postError: Error | undefined
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  posted: Array<{ message: unknown; transfer?: Transferable[] }> = []
  terminateCalls = 0
  constructor(_url: URL, readonly options?: WorkerOptions) { FakeWorker.instances.push(this) }
  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (FakeWorker.postError) throw FakeWorker.postError
    this.posted.push({ message, transfer })
  }
  terminate(): void { this.terminateCalls += 1 }
}

function fixtureBuffer(): ArrayBuffer {
  const bytes = readFileSync('tests/fixtures/ions-small.xlsx')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

describe('production user workbook parser', () => {
  it('decodes CSV bytes with fatal UTF-8 and supports mapping-required results in the worker', () => {
    const valid = new TextEncoder().encode('time,dust\n2024-01-01 00:00,1').buffer
    expect(parseUserCsvBuffer(valid, 'valid.csv', {}).rows).toEqual([
      { timestamp: '2024-01-01 00:00:00', values: { dust: 1 } },
    ])
    const mapping = new TextEncoder().encode('unknown,dust\n2024-01-01 00:00,1').buffer
    expect(parseUserCsvBuffer(mapping, 'mapping.csv', {}).mappingRequired)
      .toMatchObject({ reason: 'missing-time' })
    expect(() => parseUserCsvBuffer(new Uint8Array([0xff]).buffer, 'bad.csv', {})).toThrow(/UTF-8/i)
    expect(() => parseUserCsvBuffer(
      new TextEncoder().encode('time,dust\n"unterminated,1').buffer,
      'malformed.csv',
      {},
    )).toThrow(/valid CSV/i)
  })
  it('roundtrips a real XLSX fixture through the browser worker parser', async () => {
    const result = await parseUserWorkbookBuffer(fixtureBuffer(), 'ions-small.xlsx', {})
    expect(result.sheetName).toBe('站点数据')
    expect(result.rows).toEqual([
      { timestamp: '2024-01-02 03:00:00', values: { no3: 0, so4: 2.5, nh4: 1 } },
    ])
    expect(result).not.toHaveProperty('data')
    expect(result).not.toHaveProperty('sheets')
    const csv = parseUserCsv('time,NO3,SO4,NH4\nunits,µg/m³,µg/m³,µg/m³\n2024-01-02 03:00,0,2.5,1', 'same.csv')
    expect(csv.rows).toEqual(result.rows)
    expect(csv.variables.map(({ key }) => key)).toEqual(result.variables.map(({ key }) => key))
  })

  it('falls back deterministically from an invalid preferred sheet and warns', async () => {
    const bytes = readFileSync('tests/fixtures/ions-fallback.xlsx')
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const result = await parseUserWorkbookBuffer(buffer, 'fallback.xlsx', { preferredSheet: '站点数据' })
    expect(result.sheetName).toBe('有效数据')
    expect(result.warnings.join('\n')).toMatch(/preferred sheet.*invalid.*fell back/i)
  })

  it('rejects Mac 1904 workbooks rather than guessing their date system', async () => {
    const zip = await JSZip.loadAsync(new Uint8Array(fixtureBuffer()))
    const workbook = await zip.file('xl/workbook.xml')?.async('string')
    expect(workbook).toBeTruthy()
    zip.file('xl/workbook.xml', String(workbook).replace('<workbookPr', '<workbookPr date1904="1"'))
    const buffer = await zip.generateAsync({ type: 'arraybuffer' })
    await expect(parseUserWorkbookBuffer(buffer, 'mac-1904.xlsx', {})).rejects.toThrow(/1904/i)
  })

  it('bounds worksheet count before workbook cell decoding', async () => {
    const zip = new JSZip()
    zip.file('xl/workbook.xml', '<workbook/>')
    for (let index = 1; index <= MAX_USER_SHEETS + 1; index += 1) {
      zip.file(`xl/worksheets/sheet${index}.xml`, '<worksheet/>')
    }
    const buffer = await zip.generateAsync({ type: 'arraybuffer' })
    await expect(parseUserWorkbook(buffer, 'too-many-sheets.xlsx')).rejects.toThrow(/sheet.*20/i)
  })
})

describe('parseUserWorkbook worker client', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    FakeWorker.postError = undefined
    vi.stubGlobal('Worker', FakeWorker)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('preflights, transfers a copied buffer and returns fresh canonical objects', async () => {
    const input = fixtureBuffer()
    const pending = parseUserWorkbook(input, 'fixture.xlsx')
    const worker = FakeWorker.instances[0]
    const request = worker.posted[0]?.message as { kind: string; buffer: ArrayBuffer }
    expect(worker.options).toEqual({ type: 'module' })
    expect(request.kind).toBe('xlsx')
    expect(request.buffer).not.toBe(input)
    expect(worker.posted[0]?.transfer).toEqual([request.buffer])
    const payload = {
      ok: true,
      rawMatrix: [['secret']],
      result: {
        sheetName: 'Data',
        variables: [{ key: 'x', label: 'X', unit: '', nonNegative: false, sourceColumn: 1, extra: true }],
        mapping: { timestampColumn: 0, variables: [{ key: 'x', label: 'X', unit: '', nonNegative: false, sourceColumn: 1 }] },
        rows: [{ timestamp: '2024-01-01 00:00:00', values: { x: 1, __proto__: 2 }, raw: true }],
        warnings: [], warningTotal: 0,
      },
    }
    worker.onmessage?.(new MessageEvent('message', { data: payload }))
    const result = await pending
    expect(result).toEqual({
      sheetName: 'Data',
      variables: [{ key: 'x', label: 'X', unit: '', nonNegative: false, sourceColumn: 1 }],
      mapping: { timestampColumn: 0, variables: [{ key: 'x', label: 'X', unit: '', nonNegative: false, sourceColumn: 1 }] },
      rows: [{ timestamp: '2024-01-01 00:00:00', values: { x: 1 } }],
      warnings: [], warningTotal: 0,
    })
    expect(result).not.toBe(payload.result)
    expect(worker.terminateCalls).toBe(1)
  })

  it('reads and transfers CSV bytes to the generic worker and returns canonical data', async () => {
    const bytes = new TextEncoder().encode('time,x\n2024-01-01 00:00,1').buffer
    const arrayBuffer = vi.fn(async () => bytes)
    const file = { size: bytes.byteLength, name: 'data.csv', arrayBuffer } as unknown as File
    const pending = parseUserCsvFile(file, file.name)
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
    const worker = FakeWorker.instances[0]
    const request = worker.posted[0]?.message as { kind: string; buffer: ArrayBuffer }
    expect(arrayBuffer).toHaveBeenCalledOnce()
    expect(request.kind).toBe('csv')
    expect(request.buffer).not.toBe(bytes)
    expect(worker.posted[0]?.transfer).toEqual([request.buffer])
    worker.onmessage?.(new MessageEvent('message', { data: {
      ok: true,
      result: {
        sheetName: 'Data',
        variables: [{ key: 'x', label: 'x', unit: '', nonNegative: true, sourceColumn: 1 }],
        mapping: { timestampColumn: 0, variables: [{ key: 'x', label: 'x', unit: '', nonNegative: true, sourceColumn: 1 }] },
        rows: [{ timestamp: '2024-01-01 00:00:00', values: { x: 1 } }],
        warnings: [], warningTotal: 0,
      },
    } }))
    await expect(pending).resolves.toMatchObject({ rows: [{ values: { x: 1 } }] })
    expect(worker.terminateCalls).toBe(1)
  })

  it('rejects oversized CSV files before reading bytes or creating a worker', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const file = { size: USER_CSV_MAX_BYTES + 1, name: 'huge.csv', arrayBuffer } as unknown as File
    await expect(parseUserCsvFile(file, file.name)).rejects.toThrow(/25 MiB/i)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('physically terminates CSV worker work on abort and ignores a late response', async () => {
    const bytes = new TextEncoder().encode('time,x\n2024-01-01 00:00,1').buffer
    const file = { size: bytes.byteLength, name: 'data.csv', arrayBuffer: async () => bytes } as unknown as File
    const controller = new AbortController()
    const pending = parseUserCsvFile(file, file.name, { signal: controller.signal })
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
    const worker = FakeWorker.instances[0]
    const late = worker.onmessage
    controller.abort()
    late?.(new MessageEvent('message', { data: { ok: false, error: 'late' } }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminateCalls).toBe(1)
  })

  it('does not read or create a worker for a pre-aborted CSV parse', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const file = { size: 0, name: 'data.csv', arrayBuffer } as unknown as File
    const controller = new AbortController(); controller.abort()
    await expect(parseUserCsvFile(file, file.name, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('aborts a pending CSV file read before any worker is created', async () => {
    let resolveRead!: (value: ArrayBuffer) => void
    const arrayBuffer = vi.fn(() => new Promise<ArrayBuffer>((resolve) => { resolveRead = resolve }))
    const file = { size: 10, name: 'pending.csv', arrayBuffer } as unknown as File
    const controller = new AbortController()
    const pending = parseUserCsvFile(file, file.name, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(arrayBuffer).toHaveBeenCalledOnce()
    expect(FakeWorker.instances).toHaveLength(0)
    resolveRead(new ArrayBuffer(10))
  })

  it('aborts before and during work, with one termination and no late settlement', async () => {
    const before = new AbortController(); before.abort()
    await expect(parseUserWorkbook(fixtureBuffer(), 'before.xlsx', { signal: before.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(0)

    const controller = new AbortController()
    const pending = parseUserWorkbook(fixtureBuffer(), 'during.xlsx', { signal: controller.signal })
    const worker = FakeWorker.instances[0]
    const late = worker.onmessage
    controller.abort()
    late?.(new MessageEvent('message', { data: { ok: false, error: 'late' } }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminateCalls).toBe(1)
  })

  it('aborts a pending File read before creating a worker', async () => {
    let resolveRead!: (value: ArrayBuffer) => void
    const file = { size: fixtureBuffer().byteLength, arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { resolveRead = resolve }) } as File
    const controller = new AbortController()
    const pending = parseUserWorkbook(file, 'pending.xlsx', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(0)
    resolveRead(fixtureBuffer())
  })

  it.each(['malformed', 'runtime', 'messageerror', 'post'])('cleans up on %s failure', async (kind) => {
    if (kind === 'post') FakeWorker.postError = new Error('clone failed')
    const pending = parseUserWorkbook(fixtureBuffer(), `${kind}.xlsx`)
    const worker = FakeWorker.instances[0]
    if (kind === 'malformed') worker.onmessage?.(new MessageEvent('message', { data: { ok: true, result: { rows: 'bad' } } }))
    if (kind === 'runtime') worker.onerror?.(new ErrorEvent('error', { message: 'crashed' }))
    if (kind === 'messageerror') worker.onmessageerror?.(new MessageEvent('messageerror'))
    await expect(pending).rejects.toBeInstanceOf(Error)
    expect(worker.terminateCalls).toBe(1)
  })

  it('enforces a bounded configurable watchdog and ignores late events', async () => {
    vi.useFakeTimers()
    try {
      const pending = parseUserWorkbook(fixtureBuffer(), 'slow.xlsx', { timeoutMs: 999_999 })
      const worker = FakeWorker.instances[0]
      const late = worker.onerror
      const rejection = expect(pending).rejects.toThrow(/120.*timeout/i)
      await vi.advanceTimersByTimeAsync(USER_WORKBOOK_MAX_TIMEOUT_MS)
      late?.(new ErrorEvent('error', { message: 'late' }))
      await rejection
      expect(worker.terminateCalls).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('rejects invalid ZIP input before worker creation', async () => {
    await expect(parseUserWorkbook(new TextEncoder().encode('bad').buffer, 'bad.xlsx'))
      .rejects.toThrow(/ZIP/i)
    expect(FakeWorker.instances).toHaveLength(0)
  })
})
