import writeXlsxFile, {
  type Row,
  type Sheet,
} from 'write-excel-file/browser'

import type { CheckedRow, QualityControlResult } from './qualityControl'
import {
  EXPORT_HEADERS,
  MAX_WORKBOOK_ESTIMATED_BYTES,
  type QcWorkbookCell,
  type QcWorkbookColumnDescriptor,
  type QcWorkbookMetadata,
  type QcWorkbookModel,
  normalizeQcWorkbookModel,
  sanitizeQcWorkbookMetadata,
  safeSpreadsheetString,
} from './exportShared'

const MAX_LOG_ITEMS = 100
const MAX_LOG_TEXT_LENGTH = 500

function finiteCell(value: number | undefined): number | null {
  return Number.isFinite(value) ? value as number : null
}

export function checkedRowCells(row: CheckedRow): QcWorkbookCell[] {
  return [
    safeSpreadsheetString(row.timestamp),
    finiteCell(row.SO2),
    finiteCell(row.NO2),
    finiteCell(row.O3),
    finiteCell(row.CO),
    finiteCell(row.PM10),
    finiteCell(row['PM2.5']),
    safeSpreadsheetString(row.missing.join('；')),
    safeSpreadsheetString(row.status),
    finiteCell(row.NO3),
    finiteCell(row.SO4),
    finiteCell(row.NH4),
    safeSpreadsheetString(row.QC_flag),
    row.QC_keep,
  ]
}

function stripAbsolutePaths(value: string): string {
  return value
    .replace(/[A-Za-z]:\\[^\s,;，；]+/g, '[已移除本地路径]')
    .replace(/\/(?:Users|home)\/[^\s,;，；]+/g, '[已移除本地路径]')
}

function boundedLogString(value: unknown): string {
  const text = stripAbsolutePaths(String(value)).slice(0, MAX_LOG_TEXT_LENGTH)
  return safeSpreadsheetString(text)
}

function safeInputFilename(value: string): string {
  const parts = value.split(/[\\/]/)
  return boundedLogString(parts.at(-1) || '未命名文件')
}

const LEGACY_COLUMNS: QcWorkbookColumnDescriptor[] = EXPORT_HEADERS.map((header, index) => ({
  id: `legacy_${index}`,
  header,
  kind: index === 0 || index === 7 || index === 8 || index === 12
    ? 'text'
    : index === 13 ? 'boolean' : 'number',
  width: header === '时间' ? 22 : Math.min(42, Math.max(12, header.length + 3)),
}))

function summaryRows(result: QualityControlResult): QcWorkbookCell[][] {
  const flags = Object.entries(result.counts).sort(([left], [right]) => {
    if (left === '正常') return -1
    if (right === '正常') return 1
    return left.localeCompare(right, 'zh-CN')
  })
  return flags.map(([flag, count]) => [safeSpreadsheetString(flag), count])
}

function recordRows(
  label: string,
  values: Readonly<Record<string, string | number | boolean | null>>,
): QcWorkbookCell[][] {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([key, value]) => [
      label,
      boundedLogString(key),
      typeof value === 'string' ? boundedLogString(value) : value,
    ])
}

function listRows(label: string, values: readonly string[], filename = false): QcWorkbookCell[][] {
  const safeValues = values.slice(0, MAX_LOG_ITEMS)
  const rows = safeValues.map((value, index): QcWorkbookCell[] => [
    label,
    index + 1,
    filename ? safeInputFilename(value) : boundedLogString(value),
  ])
  if (values.length > safeValues.length) {
    rows.push([label, '截断', `共 ${values.length} 项，仅记录前 ${MAX_LOG_ITEMS} 项`])
  }
  return rows
}

function logRows(metadata: QcWorkbookMetadata): QcWorkbookCell[][] {
  return [
    ['处理时间', '', boundedLogString(metadata.processingTime)],
    ['站点编号', '', boundedLogString(metadata.stationId)],
    ...listRows('输入文件', metadata.inputFiles, true),
    ...recordRows('输入计数', metadata.inputCounts),
    ...recordRows('行数', metadata.rowCounts),
    ...listRows('警告', metadata.warnings),
    ['版本', '', boundedLogString(metadata.version)],
    ...listRows('逻辑说明', metadata.logicNotes),
  ]
}

export function createLegacyQcWorkbookModel(
  result: QualityControlResult,
  metadata: QcWorkbookMetadata,
): QcWorkbookModel {
  const safeMetadata = sanitizeQcWorkbookMetadata(metadata)
  const dataSheet = (name: string, rows: readonly CheckedRow[]) => ({
    name,
    columns: LEGACY_COLUMNS,
    rows: rows.map(checkedRowCells),
  })
  return {
    sheets: [
      dataSheet('逐时合并与质控', result.rows),
      dataSheet('质控保留', result.keptRows),
      dataSheet('质控异常', result.rejectedRows),
      {
        name: '质控汇总',
        columns: [
          { id: 'qc_flag', header: '质控标记', kind: 'text', width: 48 },
          { id: 'count', header: '数量', kind: 'number', width: 14 },
        ],
        rows: summaryRows(result),
      },
      {
        name: '处理日志',
        columns: [
          { id: 'item', header: '项目', kind: 'text', width: 16 },
          { id: 'name', header: '序号或名称', kind: 'auto', width: 20 },
          { id: 'content', header: '内容', kind: 'auto', width: 72 },
        ],
        rows: logRows(safeMetadata),
      },
    ],
  }
}

function workbookHeaderRow(columns: readonly QcWorkbookColumnDescriptor[]): Row {
  return columns.map(({ header }) => ({
    value: header,
    type: String,
    fontWeight: 'bold',
    backgroundColor: '#DCE6F1',
    align: 'center',
  }))
}

export async function createQcWorkbookBlobFromModelDirect(input: unknown): Promise<Blob> {
  const model = normalizeQcWorkbookModel(input)
  const sheets: Sheet<Blob>[] = model.sheets.map(({ name, columns, rows }) => ({
    sheet: name,
    stickyRowsCount: 1,
    columns: columns.map(({ width, header }) => ({
      width: width ?? Math.min(72, Math.max(12, header.length + 3)),
    })),
    data: [workbookHeaderRow(columns), ...rows.map((row) => [...row])],
  }))
  const blob = await writeXlsxFile(sheets).toBlob()
  if (blob.size > MAX_WORKBOOK_ESTIMATED_BYTES) {
    throw new Error(`Workbook file size exceeds safe limit ${MAX_WORKBOOK_ESTIMATED_BYTES}`)
  }
  return blob
}

export async function createQcWorkbookBlobDirect(
  result: QualityControlResult,
  metadata: QcWorkbookMetadata,
): Promise<Blob> {
  return createQcWorkbookBlobFromModelDirect(createLegacyQcWorkbookModel(result, metadata))
}
