import JSZip from 'jszip'
import readXlsxFile from 'read-excel-file/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DynamicCheckedRow, DynamicQualityControlResult } from '../../src/core/dynamicQualityControl'
import { createResultZipDirect } from '../../src/core/resultZip'
import {
  buildCombinedQcDownload,
  buildMergedQcArtifacts,
  buildStationQcArtifacts,
} from '../../src/core/qcModeExports'
import { createQcWorkbookBlobFromModelDirect } from '../../src/core/qcWorkbook'
import type { StationCheckedRow, StationQualityControlResult } from '../../src/core/stationQualityControl'
import type { UserDataMapping, UserVariableSpec } from '../../src/core/userDataset'

const metadata = {
  processingTime: '2024-11-02T03:04:05.000Z',
  stationId: '1001A',
  inputFiles: ['C:\\private\\station.csv', '/private/user.xlsx'],
  inputCounts: { stationFiles: 1, userFiles: 1 },
  rowCounts: { station: 2, merged: 2 },
  warnings: ['=warning', '/private/warning'],
  version: '2.0.0',
  logicNotes: ['station-authoritative timeline'],
}

function stationChecked(overrides: Partial<StationCheckedRow> = {}): StationCheckedRow {
  return {
    timestamp: '2024-11-01 00:00:00',
    SO2: 0,
    NO2: 2,
    O3: 3,
    CO: 0.4,
    PM10: 5,
    'PM2.5': 6,
    missing: [],
    status: '完整',
    QC_flag: '正常',
    QC_flags: [],
    QC_keep: true,
    ...overrides,
  }
}

function stationQc(rows: StationCheckedRow[]): StationQualityControlResult {
  return {
    rows,
    keptRows: rows.filter(({ QC_keep }) => QC_keep),
    rejectedRows: rows.filter(({ QC_keep }) => !QC_keep),
    counts: { 正常: rows.filter(({ QC_keep }) => QC_keep).length },
    gaps: ['2024-11-01 01:00:00'],
    gapCount: 1,
    warnings: ['one station warning'],
  }
}

const variables: UserVariableSpec[] = [
  { key: 'no3', label: 'NO3⁻', unit: 'μg/m³', nonNegative: true, sourceColumn: 1 },
  { key: 'zero', label: 'Zero', unit: 'ppb', nonNegative: false, sourceColumn: 2 },
]

const mapping: UserDataMapping = { timestampColumn: 0, variables }

function mergedChecked(overrides: Partial<DynamicCheckedRow> = {}): DynamicCheckedRow {
  return {
    ...stationChecked(),
    userValues: { no3: 7, zero: 0 },
    ...overrides,
  }
}

function mergedQc(rows: DynamicCheckedRow[]): DynamicQualityControlResult {
  return {
    rows,
    keptRows: rows.filter(({ QC_keep }) => QC_keep),
    rejectedRows: rows.filter(({ QC_keep }) => !QC_keep),
    counts: { 正常: rows.filter(({ QC_keep }) => QC_keep).length },
    gaps: [],
    gapCount: 0,
    warnings: ['one merged warning'],
  }
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

class DirectExportWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  private readonly name: string | undefined

  constructor(_url: URL, options?: WorkerOptions) {
    this.name = options?.name
  }

  postMessage(message: unknown): void {
    if (this.name === 'result-zip-export') {
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

describe('mode-specific QC exports', () => {
  beforeEach(() => vi.stubGlobal('Worker', DirectExportWorker))
  afterEach(() => vi.unstubAllGlobals())

  it('builds a station-only bundle with fixed units, gaps and no user columns', async () => {
    const artifacts = await buildStationQcArtifacts({
      qcResult: stationQc([stationChecked()]),
      metadata,
    })

    expect(artifacts.zip.name).toBe('站点数据_质控结果.zip')
    expect(artifacts.checkedCsv.content.startsWith('\uFEFF')).toBe(true)
    expect(artifacts.checkedCsv.content.replaceAll('\r\n', '')).not.toContain('\n')
    expect(artifacts.checkedCsv.content).toContain('CO (mg/m³)')
    expect(artifacts.checkedCsv.content).toContain('SO2 (µg/m³)')
    expect(artifacts.checkedCsv.content).not.toMatch(/NO3|userValues/)
    expect(artifacts.checkedCsv.content).toContain(',0,2,3,0.4,5,6,')
    expect(artifacts.gapsCsv.content).toContain('2024-11-01 01:00:00')
    expect(JSON.parse(artifacts.processingLog.content)).toMatchObject({
      mode: 'station',
      warningTotal: 1,
      counts: { all: 1, kept: 1, rejected: 0, gaps: 1 },
    })

    const zip = await JSZip.loadAsync(await blobBuffer(artifacts.zip.content))
    expect(Object.keys(zip.files)).toEqual([
      artifacts.checkedCsv.name,
      artifacts.gapsCsv.name,
      artifacts.qcSummary.name,
      artifacts.qcWorkbook.name,
      artifacts.processingLog.name,
    ])
  })

  it('builds a merged bundle from explicit variables with unmatched rows and safe dynamic headers', async () => {
    const hostileVariables: UserVariableSpec[] = [
      ...variables,
      { key: 'duplicate', label: 'NO3⁻', unit: 'μg/m³', nonNegative: false, sourceColumn: 3 },
      { key: 'formula', label: '=HYPERLINK("bad")', unit: '@unit', nonNegative: false, sourceColumn: 4 },
    ]
    const row = mergedChecked({
      timestamp: '=2024-11-01 00:00:00',
      userValues: {
        no3: 7,
        zero: 0,
        duplicate: 8,
        formula: 9,
        secret: 999,
        __proto__: 111,
      },
    })
    const artifacts = await buildMergedQcArtifacts({
      qcResult: mergedQc([row]),
      metadata,
      variables: hostileVariables,
      mapping: { timestampColumn: 0, variables: hostileVariables },
      unmatched: [
        { timestamp: '2024-11-02 02:00:00', details: '=not inserted' },
      ],
      warningTotal: 9,
    })

    const csv = artifacts.checkedCsv.content
    expect(csv).toContain('NO3⁻ (μg/m³)')
    expect(csv).toContain('NO3⁻ (μg/m³)_2')
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).toContain("'@unit")
    expect(csv).not.toContain('secret')
    expect(csv).not.toContain('999')
    expect(csv).toContain(',7,0,8,9,')
    expect(csv).toContain("'=2024-11-01 00:00:00")
    expect(artifacts.unmatchedCsv.content).toContain('timestamp,details')
    expect(artifacts.unmatchedCsv.content).toContain("'=not inserted")
    expect(artifacts.variablesCsv.content).toContain('sourceColumn')
    expect(artifacts.mappingCsv.content).toContain('timestampColumn')
    expect(JSON.parse(artifacts.processingLog.content)).toMatchObject({
      mode: 'merged', warningTotal: 9,
      counts: { all: 1, kept: 1, rejected: 0, gaps: 0, unmatched: 1 },
    })
  })

  it('writes deterministic mode-specific workbook sheets with text timestamps and numeric zeros', async () => {
    const station = await buildStationQcArtifacts({ qcResult: stationQc([stationChecked()]), metadata })
    const merged = await buildMergedQcArtifacts({
      qcResult: mergedQc([mergedChecked()]), metadata, variables, mapping,
      unmatched: [{ timestamp: '2024-11-02 02:00:00', details: 'not inserted' }],
    })
    const stationSheets = await readXlsxFile(Buffer.from(await blobBuffer(station.qcWorkbook.content)))
    const mergedSheets = await readXlsxFile(Buffer.from(await blobBuffer(merged.qcWorkbook.content)))

    expect(stationSheets.map(({ sheet }) => sheet)).toEqual([
      '站点质控结果', '质控保留', '质控异常', '时间缺口', '质控汇总', '处理日志',
    ])
    expect(mergedSheets.map(({ sheet }) => sheet)).toEqual([
      '合并质控结果', '质控保留', '质控异常', '未匹配时间', '变量说明', '映射说明', '质控汇总', '处理日志',
    ])
    expect(stationSheets[0]?.data[1]?.slice(0, 3)).toEqual(['2024-11-01 00:00:00', 0, 2])
    expect(mergedSheets[0]?.data[0]).toContain('NO3⁻ (μg/m³)')
    expect(mergedSheets[0]?.data[1]).toContain(0)

    for (const workbook of [station.qcWorkbook.content, merged.qcWorkbook.content]) {
      const archive = await JSZip.loadAsync(await blobBuffer(workbook))
      const names = Object.keys(archive.files)
      expect(names).not.toContain('xl/vbaProject.bin')
      expect(names.some((name) => name.startsWith('xl/externalLinks/'))).toBe(false)
      const worksheets = await Promise.all(names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map((name) => archive.file(name)!.async('string')))
      expect(worksheets.join('\n')).not.toMatch(/<f(?:\s|>)/)
    }
  })

  it('requires both modes for an explicit combined download and produces deterministic safe paths', async () => {
    const station = await buildStationQcArtifacts({ qcResult: stationQc([stationChecked()]), metadata })
    const merged = await buildMergedQcArtifacts({
      qcResult: mergedQc([mergedChecked()]), metadata, variables, mapping, unmatched: [],
    })
    await expect(buildCombinedQcDownload({ station })).rejects.toThrow(/merged/i)
    await expect(buildCombinedQcDownload({ merged })).rejects.toThrow(/station/i)

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime('2024-01-01T00:00:00.000Z')
      const first = await buildCombinedQcDownload({ station, merged })
      vi.setSystemTime('2026-01-01T00:00:00.000Z')
      const second = await buildCombinedQcDownload({ station, merged })
      expect(new Uint8Array(await blobBuffer(second.content))).toEqual(new Uint8Array(await blobBuffer(first.content)))
      const zip = await JSZip.loadAsync(await blobBuffer(first.content))
      const names = Object.keys(zip.files)
      expect(names.every((name) => /^(station-qc|merged-qc)\//.test(name))).toBe(true)
      expect(names.some((name) => name.includes('..') || name.includes('\\'))).toBe(false)
      expect(new Set(names).size).toBe(names.length)
      expect(names.some((name) => name.endsWith('.zip'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects prototype keys, excessive columns, overlong strings, and excessive rows', async () => {
    const base = { qcResult: mergedQc([mergedChecked()]), metadata, mapping, unmatched: [] }
    await expect(buildMergedQcArtifacts({
      ...base,
      variables: [{ key: '__proto__', label: 'bad', unit: '', nonNegative: false, sourceColumn: 1 }],
    })).rejects.toThrow(/key|prototype/i)
    await expect(buildMergedQcArtifacts({
      ...base,
      variables: Array.from({ length: 1_001 }, (_, index) => ({
        key: `v${index}`, label: `v${index}`, unit: '', nonNegative: false, sourceColumn: index,
      })),
    })).rejects.toThrow(/column|variable|1000/i)
    await expect(buildMergedQcArtifacts({
      ...base,
      variables: [{ key: 'long', label: 'x'.repeat(32_769), unit: '', nonNegative: false, sourceColumn: 1 }],
    })).rejects.toThrow(/string|length|字符/i)
    await expect(buildStationQcArtifacts({
      qcResult: stationQc(Array.from({ length: 8_785 }, () => stationChecked())), metadata,
    })).rejects.toThrow('8784')
  })
})
