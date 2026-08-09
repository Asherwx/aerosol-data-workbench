import JSZip from 'jszip'
import readXlsxFile from 'read-excel-file/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CheckedRow, QualityControlResult } from '../../src/core/qualityControl'
import type { StationSeriesRow } from '../../src/core/stationSeries'
import {
  MAX_EXPORT_ROWS,
  RESULT_ZIP_MAX_FILES,
  RESULT_ZIP_MAX_TOTAL_BYTES,
  buildResultArtifacts,
  createMergedCsv,
  createQcWorkbook,
  createResultZip,
  createStationCsv,
  downloadArtifact,
} from '../../src/core/exports'
import { createQcWorkbookBlobDirect, createQcWorkbookBlobFromModelDirect } from '../../src/core/qcWorkbook'
import { EXPORT_HEADERS, sanitizeQcWorkbookMetadata } from '../../src/core/exportShared'
import { createResultZipDirect } from '../../src/core/resultZip'

const stationRow: StationSeriesRow = {
  timestamp: '2024-11-01 00:00:00',
  SO2: 0,
  NO2: 2,
  O3: 3,
  CO: 0.4,
  PM10: 5,
  'PM2.5': 6,
  missing: [],
  status: '完整',
}

function checked(values: Partial<CheckedRow> = {}): CheckedRow {
  return {
    ...stationRow,
    NO3: 7,
    SO4: 8,
    NH4: 9,
    QC_flag: '正常',
    QC_flags: [],
    QC_keep: true,
    ...values,
  }
}

function qc(rows: CheckedRow[]): QualityControlResult {
  const keptRows = rows.filter((row) => row.QC_keep)
  const rejectedRows = rows.filter((row) => !row.QC_keep)
  const counts: Record<string, number> = { 正常: keptRows.length }
  for (const row of rejectedRows) counts[row.QC_flag] = (counts[row.QC_flag] ?? 0) + 1
  return { rows, keptRows, rejectedRows, counts }
}

const metadata = {
  processingTime: '2024-11-02T03:04:05.000Z',
  stationId: '1001A',
  inputFiles: ['china_sites_20241101.csv', 'ions.xlsx'],
  inputCounts: { stationFiles: 1, ionFiles: 1 },
  rowCounts: { station: 2, merged: 2, kept: 1, rejected: 1 },
  warnings: ['一个提醒'],
  version: '1.0.0',
  logicNotes: ['按北京时间逐时合并', '负值不保留'],
}

function lines(csv: string): string[] {
  return csv.slice(1).split('\r\n')
}

async function blobBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })
}

describe('CSV exports', () => {
  it('creates station CSV with BOM, CRLF, fixed headers, timestamp text and zero', () => {
    const csv = createStationCsv([stationRow])

    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.replaceAll('\r\n', '')).not.toContain('\n')
    expect(lines(csv)[0]).toBe(
      '时间,SO2_μg_m3,NO2_μg_m3,O3_μg_m3,CO_mg_m3,PM10_μg_m3,PM2.5_μg_m3,缺测项目,数据状态',
    )
    expect(lines(csv)[1]).toBe('2024-11-01 00:00:00,0,2,3,0.4,5,6,,完整')
  })

  it('puts station fields before ions and QC fields while preserving blanks', () => {
    const csv = createMergedCsv([checked({ NO2: undefined, NO3: undefined })])

    expect(lines(csv)[0]).toBe(
      '时间,SO2_μg_m3,NO2_μg_m3,O3_μg_m3,CO_mg_m3,PM10_μg_m3,PM2.5_μg_m3,缺测项目,数据状态,NO3_μg_m3,SO4_μg_m3,NH4_μg_m3,QC_flag,QC_keep',
    )
    expect(lines(csv)[1]).toBe('2024-11-01 00:00:00,0,,3,0.4,5,6,,完整,,8,9,正常,true')
  })

  it('neutralizes formula-like strings but leaves negative numbers numeric', () => {
    const row = checked({
      timestamp: ' =HYPERLINK("https://bad")',
      SO2: -1,
      QC_flag: '\t@SUM(1,1)',
      status: '+cmd' as CheckedRow['status'],
    })
    const csv = createMergedCsv([row])

    expect(csv).toContain("' =HYPERLINK")
    expect(csv).toContain(',-1,')
    expect(csv).toContain("'\t@SUM")
    expect(csv).toContain("'+cmd")
  })

  it('neutralizes every legacy CSV header before serialization', () => {
    const headers = EXPORT_HEADERS as unknown as string[]
    const original = headers[0]
    headers[0] = '=header'
    try {
      expect(lines(createMergedCsv([checked()]))[0]).toContain("'=header")
    } finally {
      headers[0] = original
    }
  })

  it('formats finite numbers without locale separators or scientific notation', () => {
    const csv = createMergedCsv([checked({ SO2: 1e-7, NO2: 1e21 })])
    expect(lines(csv)[1]).toContain(',0.0000001,1000000000000000000000,')
  })

  it('does not mutate source rows and enforces the 8784-row cap', () => {
    const source = [checked()]
    const snapshot = structuredClone(source)
    createMergedCsv(source)
    expect(source).toEqual(snapshot)

    const boundary = Array.from({ length: MAX_EXPORT_ROWS }, () => checked())
    expect(() => createMergedCsv(boundary)).not.toThrow()
    expect(() => createMergedCsv([...boundary, checked()])).toThrow('8784')
  })
})

describe('QC workbook', () => {
  it('writes deterministic sheets, rows, headers, values, summary and safe log strings', async () => {
    const result = qc([
      checked(),
      checked({ QC_flag: '=危险', QC_keep: false, QC_flags: [{ code: 'negative', message: '=危险' }] }),
    ])
    const blob = await createQcWorkbookBlobDirect(result, {
      ...metadata,
      inputFiles: ['C:\\Users\\secret\\raw.csv', '=formula.xlsx'],
      warnings: ['@warning'],
    })
    const sheets = await readXlsxFile(Buffer.from(await blobBuffer(blob)))

    expect(sheets.map(({ sheet }) => sheet)).toEqual([
      '逐时合并与质控',
      '质控保留',
      '质控异常',
      '质控汇总',
      '处理日志',
    ])
    expect(sheets[0]?.data).toHaveLength(3)
    expect(sheets[0]?.data[0]).toEqual([
      '时间', 'SO2_μg_m3', 'NO2_μg_m3', 'O3_μg_m3', 'CO_mg_m3', 'PM10_μg_m3',
      'PM2.5_μg_m3', '缺测项目', '数据状态', 'NO3_μg_m3', 'SO4_μg_m3', 'NH4_μg_m3',
      'QC_flag', 'QC_keep',
    ])
    expect(sheets[0]?.data[1]?.slice(0, 4)).toEqual(['2024-11-01 00:00:00', 0, 2, 3])
    expect(sheets[1]?.data).toHaveLength(2)
    expect(sheets[2]?.data).toHaveLength(2)
    expect(sheets[3]?.data).toEqual([
      ['质控标记', '数量'],
      ['正常', 1],
      ["'=危险", 1],
    ])
    expect(sheets[4]?.data.flat().join('\n')).toContain('1001A')
    expect(sheets[4]?.data.flat().join('\n')).not.toMatch(/[A-Z]:\\|\/Users\//)
    expect(sheets[4]?.data.flat().join('\n')).toContain("'=formula.xlsx")
    expect(sheets[4]?.data.flat().join('\n')).toContain("'@warning")

    const workbookArchive = await JSZip.loadAsync(await blobBuffer(blob))
    const worksheetXml = await Promise.all(
      Object.values(workbookArchive.files)
        .filter(({ name }) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
        .map((file) => file.async('string')),
    )
    expect(worksheetXml.join('\n')).not.toMatch(/<f(?:\s|>)/)
    expect(Object.keys(workbookArchive.files)).not.toContain('xl/vbaProject.bin')
    expect(Object.keys(workbookArchive.files).some((name) => name.startsWith('xl/externalLinks/'))).toBe(false)
  })

  it('does not mutate QC input and rejects more than 8784 rows', async () => {
    const source = qc([checked()])
    const snapshot = structuredClone(source)
    await createQcWorkbookBlobDirect(source, metadata)
    expect(source).toEqual(snapshot)

    const tooMany = Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => checked())
    await expect(createQcWorkbook(qc(tooMany), metadata)).rejects.toThrow('8784')

    const inconsistent = qc([checked()])
    inconsistent.keptRows = tooMany
    await expect(createQcWorkbook(inconsistent, metadata)).rejects.toThrow('8784')
  })
})

class FakeWorkbookWorker {
  static instances: FakeWorkbookWorker[] = []
  static postError: Error | undefined
  static constructorError: Error | undefined

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  posted: unknown[] = []
  terminateCalls = 0
  readonly options: WorkerOptions | undefined

  constructor(_url: URL, options?: WorkerOptions) {
    if (FakeWorkbookWorker.constructorError) throw FakeWorkbookWorker.constructorError
    this.options = options
    FakeWorkbookWorker.instances.push(this)
  }

  postMessage(message: unknown): void {
    if (FakeWorkbookWorker.postError) throw FakeWorkbookWorker.postError
    this.posted.push(message)
  }

  terminate(): void {
    this.terminateCalls += 1
  }
}

describe('QC workbook worker protocol', () => {
  beforeEach(() => {
    FakeWorkbookWorker.instances = []
    FakeWorkbookWorker.postError = undefined
    FakeWorkbookWorker.constructorError = undefined
    vi.stubGlobal('Worker', FakeWorkbookWorker)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('resolves a transferred workbook buffer and cleans up exactly once', async () => {
    const pending = createQcWorkbook(qc([checked()]), metadata)
    const worker = FakeWorkbookWorker.instances[0]
    const buffer = new Uint8Array([1, 2, 3]).buffer
    const lateError = worker.onerror

    expect(worker.options).toEqual({ type: 'module', name: 'qc-workbook-export' })
    expect(worker.posted).toHaveLength(1)
    worker.onmessage?.(new MessageEvent('message', { data: { ok: true, buffer } }))
    lateError?.(new ErrorEvent('error', { message: 'late failure' }))

    const result = await pending
    expect(new Uint8Array(await blobBuffer(result))).toEqual(new Uint8Array([1, 2, 3]))
    expect(worker.terminateCalls).toBe(1)
  })

  it('rejects a typed worker error response and terminates', async () => {
    const pending = createQcWorkbook(qc([checked()]), metadata)
    const worker = FakeWorkbookWorker.instances[0]
    worker.onmessage?.(new MessageEvent('message', { data: { ok: false, message: '生成失败' } }))
    await expect(pending).rejects.toThrow('生成失败')
    expect(worker.terminateCalls).toBe(1)
  })

  it('rejects runtime and message decoding errors with cleanup', async () => {
    const runtimePending = createQcWorkbook(qc([checked()]), metadata)
    const runtimeWorker = FakeWorkbookWorker.instances[0]
    runtimeWorker.onerror?.(new ErrorEvent('error', { message: 'worker crashed' }))
    await expect(runtimePending).rejects.toThrow('worker crashed')
    expect(runtimeWorker.terminateCalls).toBe(1)

    const messagePending = createQcWorkbook(qc([checked()]), metadata)
    const messageWorker = FakeWorkbookWorker.instances[1]
    messageWorker.onmessageerror?.(new MessageEvent('messageerror'))
    await expect(messagePending).rejects.toThrow('工作线程消息无法解析')
    expect(messageWorker.terminateCalls).toBe(1)
  })

  it('rejects malformed responses and postMessage failures with cleanup', async () => {
    const malformedPending = createQcWorkbook(qc([checked()]), metadata)
    const malformedWorker = FakeWorkbookWorker.instances[0]
    malformedWorker.onmessage?.(new MessageEvent('message', { data: { ok: true, buffer: 'bad' } }))
    await expect(malformedPending).rejects.toThrow('工作线程返回格式无效')
    expect(malformedWorker.terminateCalls).toBe(1)

    FakeWorkbookWorker.postError = new Error('clone failed')
    await expect(createQcWorkbook(qc([checked()]), metadata)).rejects.toThrow('clone failed')
    expect(FakeWorkbookWorker.instances[1].terminateCalls).toBe(1)
  })

  it('fails closed when Worker is unavailable or cannot be constructed', async () => {
    vi.stubGlobal('Worker', undefined)
    await expect(createQcWorkbook(qc([checked()]), metadata)).rejects.toThrow(
      /浏览器.*后台|后台.*浏览器/,
    )

    vi.stubGlobal('Worker', FakeWorkbookWorker)
    FakeWorkbookWorker.constructorError = new Error('worker blocked')
    await expect(createQcWorkbook(qc([checked()]), metadata)).rejects.toThrow(
      /后台.*升级|升级.*后台/,
    )
  })

  it('times out and supports AbortSignal while terminating exactly once', async () => {
    vi.useFakeTimers()
    const timeoutPending = createQcWorkbook(qc([checked()]), metadata, { timeoutMs: 50 })
    const timeoutWorker = FakeWorkbookWorker.instances[0]
    const timeoutAssertion = expect(timeoutPending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(50)
    await timeoutAssertion
    expect(timeoutWorker.terminateCalls).toBe(1)

    const controller = new AbortController()
    const abortPending = createQcWorkbook(qc([checked()]), metadata, { signal: controller.signal })
    const abortWorker = FakeWorkbookWorker.instances[1]
    controller.abort()
    await expect(abortPending).rejects.toThrow('已取消')
    expect(abortWorker.terminateCalls).toBe(1)
  })
})

describe('result ZIP', () => {
  beforeEach(() => vi.stubGlobal('Worker', DirectWorkbookWorker))
  afterEach(() => vi.unstubAllGlobals())

  it('compresses supported content and round-trips names and bytes', async () => {
    const zipBlob = await createResultZip([
      { name: 'data/a.csv', content: '时间,值\r\n' },
      { name: 'report.xlsx', content: new Uint8Array([1, 2, 3]) },
      { name: 'log.json', content: new Blob(['{"ok":true}']) },
    ])
    const zip = await JSZip.loadAsync(await blobBuffer(zipBlob))

    expect(Object.keys(zip.files)).toEqual(['data/a.csv', 'report.xlsx', 'log.json'])
    expect(await zip.file('data/a.csv')?.async('string')).toBe('时间,值\r\n')
    expect(await zip.file('report.xlsx')?.async('uint8array')).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('produces byte-identical ZIP files for identical ordered inputs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const files = [
      { name: 'a.txt', content: 'same content' },
      { name: 'b.bin', content: new Uint8Array([0, 1, 2, 3]) },
    ]
    try {
      vi.setSystemTime('2024-01-01T00:00:00.000Z')
      const first = new Uint8Array(await blobBuffer(await createResultZip(files)))
      vi.setSystemTime('2025-06-01T12:34:56.000Z')
      const second = new Uint8Array(await blobBuffer(await createResultZip(files)))
      expect(second).toEqual(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['../x', '/x', 'C:/x', 'a\\b', 'a/../b', 'a\0b', 'a\nb', 'a:b', './x', ''])('rejects unsafe name %j', async (name) => {
    await expect(createResultZip([{ name, content: 'x' }])).rejects.toThrow(/文件名|路径/)
  })

  it('rejects duplicate names, excessive count, and excessive total bytes', async () => {
    await expect(createResultZip([
      { name: 'same.txt', content: '1' },
      { name: 'same.txt', content: '2' },
    ])).rejects.toThrow('重复')
    await expect(createResultZip(Array.from({ length: RESULT_ZIP_MAX_FILES + 1 }, (_, index) => ({
      name: `${index}.txt`, content: '',
    })))).rejects.toThrow(String(RESULT_ZIP_MAX_FILES))
    await expect(createResultZip([
      { name: 'large.bin', content: new Uint8Array(RESULT_ZIP_MAX_TOTAL_BYTES + 1) },
    ])).rejects.toThrow(/大小|上限/)
  })

  it('rejects case-folded duplicate names for Windows extractors', async () => {
    await expect(createResultZip([
      { name: 'A.csv', content: '1' },
      { name: 'a.csv', content: '2' },
    ])).rejects.toThrow('重复')
  })

  it('rejects oversized binary objects before reading or copying them', async () => {
    const blob = new Blob([])
    Object.defineProperty(blob, 'size', { value: RESULT_ZIP_MAX_TOTAL_BYTES + 1 })
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    Object.defineProperty(blob, 'arrayBuffer', { value: arrayBuffer })
    await expect(createResultZip([{ name: 'large.blob', content: blob }])).rejects.toThrow(/大小|上限/)
    expect(arrayBuffer).not.toHaveBeenCalled()

    await expect(createResultZip([{
      name: 'large.buffer',
      content: new ArrayBuffer(RESULT_ZIP_MAX_TOTAL_BYTES + 1),
    }])).rejects.toThrow(/大小|上限/)
  })
})

class DirectWorkbookWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  private readonly workerName: string | undefined

  constructor(_url: URL, options?: WorkerOptions) {
    this.workerName = options?.name
  }

  postMessage(message: unknown): void {
    if (this.workerName === 'result-zip-export') {
      const request = message as { files: Array<{ name: string; buffer: ArrayBuffer }> }
      void createResultZipDirect(request.files).then((buffer) => {
        this.onmessage?.(new MessageEvent('message', { data: { ok: true, buffer } }))
      })
      return
    }
    const request = message as { model: Parameters<typeof createQcWorkbookBlobFromModelDirect>[0] }
    void createQcWorkbookBlobFromModelDirect(request.model).then(async (blob) => {
      const buffer = await blobBuffer(blob)
      this.onmessage?.(new MessageEvent('message', { data: { ok: true, buffer } }))
    })
  }

  terminate(): void {}
}

describe('artifact orchestration', () => {
  beforeEach(() => vi.stubGlobal('Worker', DirectWorkbookWorker))
  afterEach(() => vi.unstubAllGlobals())

  it('builds deterministic sanitized names, UTF-8 log, and a ZIP containing each result', async () => {
    const artifacts = await buildResultArtifacts({
      stationRows: [stationRow],
      qcResult: qc([checked()]),
      metadata: { ...metadata, stationId: '../站点 A' },
      startDate: '2024-11-01',
      endDate: '2024-11-02',
    })

    expect(artifacts.stationCsv.name).toBe('A_20241101-20241102_station.csv')
    expect(artifacts.mergedCsv.name).toBe('A_20241101-20241102_merged-qc.csv')
    expect(artifacts.qcWorkbook.name).toBe('A_20241101-20241102_qc-report.xlsx')
    expect(artifacts.processingLog.name).toBe('A_20241101-20241102_processing-log.json')
    expect(artifacts.zip.name).toBe('A_20241101-20241102_results.zip')
    expect(artifacts.processingLog.content.startsWith('{')).toBe(true)
    expect(artifacts.processingLog.content).not.toMatch(/[A-Z]:\\|\/Users\//)

    const zip = await JSZip.loadAsync(await blobBuffer(artifacts.zip.content))
    expect(Object.keys(zip.files)).toEqual([
      artifacts.stationCsv.name,
      artifacts.mergedCsv.name,
      artifacts.qcWorkbook.name,
      artifacts.processingLog.name,
    ])
  })

  it('recursively removes paths, controls and bidi from every metadata string and key', async () => {
    const hostileMetadata = {
      processingTime: 'C:\\private\\processing-time',
      stationId: '/srv/private/station-id',
      inputFiles: ['C:\\private\\input.csv\u202E'],
      inputCounts: { 'C:\\private\\input-key': 'C:\\private\\input-value\u0001' },
      rowCounts: { '/srv/private/row-key': '/srv/private/row-value\u202E' },
      warnings: ['/etc/private-warning\u0007', 'source C:\\Private Folder\\secret.txt'],
      version: 'C:\\private\\version\u202E',
      logicNotes: ['/opt/private-note\u2066', 'x'.repeat(800)],
    } as unknown as typeof metadata
    const artifacts = await buildResultArtifacts({
      stationRows: [stationRow],
      qcResult: qc([checked()]),
      metadata: hostileMetadata,
      startDate: '2024-11-01',
      endDate: '2024-11-01',
    })
    const parsed = JSON.parse(artifacts.processingLog.content) as Record<string, unknown>
    const serialized = JSON.stringify(parsed)

    expect(serialized).not.toMatch(/[A-Z]:\\|\/(?:srv|etc|opt)\//)
    expect(serialized).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
    expect(Object.keys(parsed.inputCounts as object).join()).not.toContain('private')
    expect(Object.values(parsed.inputCounts as object).join()).not.toContain('private')
    expect(Object.keys(parsed.rowCounts as object).join()).not.toContain('private')
    expect(Object.values(parsed.rowCounts as object).join()).not.toContain('private')
    expect(serialized).not.toContain('Private Folder')
    expect(serialized).not.toContain('secret.txt')
    expect((parsed.logicNotes as string[])[1]).toHaveLength(500)
  })

  it('redacts delimiter-adjacent POSIX and Windows paths while preserving safe URLs', async () => {
    const variants = [
      "file='/home/alice/private.csv'",
      '"path":"/srv/secret/data.csv"',
      'files=[/opt/restricted/a.csv]',
      'left,/var/private.csv;right',
      'json={"C:\\private\\source.csv":"\\\\server\\share\\secret.csv"}',
      'https://example.com/data.csv',
    ]
    const artifacts = await buildResultArtifacts({
      stationRows: [stationRow],
      qcResult: qc([checked()]),
      metadata: { ...metadata, warnings: variants },
      startDate: '2024-11-01',
      endDate: '2024-11-01',
    })
    const warnings = JSON.parse(artifacts.processingLog.content).warnings as string[]
    expect(warnings.join('\n')).not.toMatch(/\/home\/|\/srv\/|\/opt\/|\/var\/|C:\\|\\\\server\\share/)
    expect(warnings.at(-1)).toBe('https://example.com/data.csv')
  })

  it('preserves a normal ISO processing time and station identifier', async () => {
    const artifacts = await buildResultArtifacts({
      stationRows: [stationRow],
      qcResult: qc([checked()]),
      metadata,
      startDate: '2024-11-01',
      endDate: '2024-11-01',
    })
    const parsed = JSON.parse(artifacts.processingLog.content)
    expect(parsed.processingTime).toBe(metadata.processingTime)
    expect(parsed.stationId).toBe(metadata.stationId)
  })

  it('passes cancellation and timeout options through artifact worker stages', async () => {
    const input = {
      stationRows: [stationRow],
      qcResult: qc([checked()]),
      metadata,
      startDate: '2024-11-01',
      endDate: '2024-11-01',
    }
    const controller = new AbortController()
    controller.abort()
    await expect(buildResultArtifacts(input, { signal: controller.signal })).rejects.toThrow('取消')
    await expect(buildResultArtifacts(input, { timeoutMs: 0 })).rejects.toThrow('整数')
  })

  it.each([
    ['2024-02-30', '2024-03-01', '有效的日历日期'],
    ['2024-03-02', '2024-03-01', '结束日期不能早于开始日期'],
    ['2024/03/01', '2024-03-01', 'YYYY-MM-DD'],
  ])('rejects invalid artifact date range %s to %s', async (startDate, endDate, message) => {
    await expect(buildResultArtifacts({
      stationRows: [stationRow],
      qcResult: qc([checked()]),
      metadata,
      startDate,
      endDate,
    })).rejects.toThrow(message)
  })
})

describe('metadata path token redaction', () => {
  it.each([
    ['FiLe://server/share/private.csv', 'server/share/private.csv'],
    ['file:///home/alice/private.csv', '/home/alice/private.csv'],
    ['file:///C:/Users/alice/private.csv', 'C:/Users/alice/private.csv'],
    ['path|/etc/private.conf|done', '/etc/private.conf'],
    ['path>/etc/private.conf<done', '/etc/private.conf'],
    ['path</etc/private.conf>done', '/etc/private.conf'],
    ['{"path":</srv/private.json>,"next":"ok"}', '/srv/private.json'],
    ['{"path":"C:\\private\\data.csv","unc":"\\\\server\\share\\x.csv"}', 'private'],
  ])('redacts path token in %s', (input, leakedPart) => {
    const result = sanitizeQcWorkbookMetadata({ ...metadata, warnings: [input] })
    expect(result.warnings[0]).toContain('[已移除本地路径]')
    expect(result.warnings[0]).not.toContain(leakedPart)
  })

  it.each([
    'https://example.com/path/data.csv',
    '2024-11-01T00:00:00.000Z',
    'ratio 1/2 and notes/aerosol',
    'station_1001A',
  ])('preserves safe non-path text %s', (input) => {
    const result = sanitizeQcWorkbookMetadata({ ...metadata, warnings: [input] })
    expect(result.warnings[0]).toBe(input)
  })
})

describe('downloadArtifact', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('creates, clicks, removes, and later revokes a semantic download anchor', () => {
    vi.useFakeTimers()
    const createObjectURL = vi.fn(() => 'blob:result')
    const revokeObjectURL = vi.fn()
    const anchor = document.createElement('a')
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined)
    const remove = vi.spyOn(anchor, 'remove')
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(anchor)

    downloadArtifact(new Blob(['x']), 'result.csv', {
      document,
      url: { createObjectURL, revokeObjectURL },
      revokeDelayMs: 1_000,
    })

    expect(createElement).toHaveBeenCalledWith('a')
    expect(anchor.download).toBe('result.csv')
    expect(anchor.href).toBe('blob:result')
    expect(click).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:result')
  })

  it.each(['createElement', 'append', 'click'] as const)(
    'schedules exactly one revoke and removes only an appended anchor when %s fails',
    (failurePoint) => {
      vi.useFakeTimers()
      const createObjectURL = vi.fn(() => 'blob:failure')
      const revokeObjectURL = vi.fn()
      const anchor = document.createElement('a')
      const remove = vi.spyOn(anchor, 'remove')
      const click = vi.spyOn(anchor, 'click').mockImplementation(() => {
        if (failurePoint === 'click') throw new Error('click failed')
      })
      const createElement = vi.spyOn(document, 'createElement').mockImplementation(() => {
        if (failurePoint === 'createElement') throw new Error('create failed')
        return anchor
      })
      const append = vi.spyOn(document.body, 'append').mockImplementation((...nodes) => {
        if (failurePoint === 'append') throw new Error('append failed')
        return HTMLElement.prototype.append.call(document.body, ...nodes)
      })

      expect(() => downloadArtifact(new Blob(['x']), 'result.csv', {
        document,
        url: { createObjectURL, revokeObjectURL },
        revokeDelayMs: 10,
      })).toThrow()

      expect(createObjectURL).toHaveBeenCalledOnce()
      expect(remove).toHaveBeenCalledTimes(failurePoint === 'click' ? 1 : 0)
      if (failurePoint === 'click') expect(click).toHaveBeenCalledOnce()
      if (failurePoint !== 'createElement') expect(append).toHaveBeenCalledOnce()
      vi.advanceTimersByTime(10)
      expect(revokeObjectURL).toHaveBeenCalledOnce()
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:failure')
    },
  )
})
