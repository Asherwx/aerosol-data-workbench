import Papa from 'papaparse'

import type { DynamicCheckedRow, DynamicQualityControlResult } from './dynamicQualityControl'
import {
  type BuildResultArtifactsOptions,
  type NamedArtifact,
  createQcWorkbookFromModel,
  createResultZip,
  MAX_EXPORT_ROWS,
} from './exports'
import {
  MAX_WORKBOOK_COLUMNS,
  MAX_WORKBOOK_STRING_LENGTH,
  type QcWorkbookCell,
  type QcWorkbookColumnDescriptor,
  type QcWorkbookMetadata,
  type QcWorkbookModel,
  sanitizeExportValue,
  safeSpreadsheetString,
} from './exportShared'
import type { StationCheckedRow, StationQualityControlResult } from './stationQualityControl'
import type { UserDataMapping, UserVariableSpec } from './userDataset'

const UTF8_BOM = '\uFEFF'
const MAX_EXPORT_CELLS = 2_000_000
const MAX_EXPORT_FILE_BYTES = 16 * 1024 * 1024
const SAFE_USER_KEY = /^[a-z][a-z0-9_]{0,63}$/
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export interface UnmatchedExportRow {
  timestamp: string
  details: string
}

export interface BuildStationQcArtifactsInput {
  qcResult: StationQualityControlResult
  metadata: QcWorkbookMetadata
}

export interface BuildMergedQcArtifactsInput {
  qcResult: DynamicQualityControlResult
  metadata: QcWorkbookMetadata
  variables?: readonly UserVariableSpec[]
  mapping?: UserDataMapping
  unmatched?: readonly UnmatchedExportRow[] | readonly string[]
  unmatchedTimestamps?: readonly string[]
  warningTotal?: number
  mergeResult?: {
    variables: readonly UserVariableSpec[]
    unmatchedUserTimestamps: readonly string[]
    warningTotal: number
  }
  userDataset?: {
    variables: readonly UserVariableSpec[]
    mapping?: UserDataMapping
  }
}

export interface StationQcArtifacts {
  checkedCsv: NamedArtifact<string>
  gapsCsv: NamedArtifact<string>
  qcSummary: NamedArtifact<string>
  qcWorkbook: NamedArtifact<Blob>
  processingLog: NamedArtifact<string>
  zip: NamedArtifact<Blob>
}

export interface MergedQcArtifacts {
  checkedCsv: NamedArtifact<string>
  unmatchedCsv: NamedArtifact<string>
  variablesCsv: NamedArtifact<string>
  mappingCsv: NamedArtifact<string>
  qcSummary: NamedArtifact<string>
  qcWorkbook: NamedArtifact<Blob>
  processingLog: NamedArtifact<string>
  zip: NamedArtifact<Blob>
}

export interface CombinedQcArtifactsInput {
  station?: StationQcArtifacts
  merged?: MergedQcArtifacts
}

function assertBoundedString(value: string, context: string): string {
  if (value.length > MAX_WORKBOOK_STRING_LENGTH) {
    throw new Error(`${context} string length exceeds safe limit ${MAX_WORKBOOK_STRING_LENGTH}`)
  }
  return safeSpreadsheetString(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ''))
}

function plainNumber(value: number): string {
  if (!Number.isFinite(value)) return ''
  const text = String(value)
  if (!/[eE]/.test(text)) return text
  const [coefficient, exponentText] = text.toLowerCase().split('e') as [string, string]
  const exponent = Number(exponentText)
  const negative = coefficient.startsWith('-')
  const unsigned = negative ? coefficient.slice(1) : coefficient
  const [integer, fraction = ''] = unsigned.split('.')
  const digits = integer + fraction
  const decimalPosition = integer.length + exponent
  let result: string
  if (decimalPosition <= 0) result = `0.${'0'.repeat(-decimalPosition)}${digits}`
  else if (decimalPosition >= digits.length) result = `${digits}${'0'.repeat(decimalPosition - digits.length)}`
  else result = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`
  return negative ? `-${result}` : result
}

function csvCell(value: QcWorkbookCell): string {
  if (value === null) return ''
  if (typeof value === 'number') return plainNumber(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return assertBoundedString(value, 'CSV cell')
}

function createModeCsv(
  headers: readonly string[],
  rows: readonly (readonly QcWorkbookCell[])[],
): string {
  if (headers.length < 1 || headers.length > MAX_WORKBOOK_COLUMNS) {
    throw new Error(`CSV column count exceeds safe limit ${MAX_WORKBOOK_COLUMNS}`)
  }
  if (rows.length > MAX_EXPORT_ROWS) throw new Error(`导出行数 ${rows.length} 超过安全上限 ${MAX_EXPORT_ROWS}`)
  if (rows.length * headers.length > MAX_EXPORT_CELLS) {
    throw new Error(`CSV cell count exceeds safe limit ${MAX_EXPORT_CELLS}`)
  }
  const safeHeaders = uniqueHeaders(headers)
  const safeRows = rows.map((row, rowIndex) => {
    if (row.length !== headers.length) throw new Error(`CSV row ${rowIndex + 1} has an invalid column count`)
    return row.map(csvCell)
  })
  const csv = UTF8_BOM + Papa.unparse([safeHeaders, ...safeRows], { newline: '\r\n', header: false })
  if (new TextEncoder().encode(csv).byteLength > MAX_EXPORT_FILE_BYTES) {
    throw new Error(`CSV file size exceeds safe limit ${MAX_EXPORT_FILE_BYTES}`)
  }
  return csv
}

function uniqueHeaders(headers: readonly string[]): string[] {
  const seen = new Set<string>()
  return headers.map((header) => {
    const safe = assertBoundedString(header, 'CSV header') || '字段'
    if (!seen.has(safe)) {
      seen.add(safe)
      return safe
    }
    for (let suffix = 2; suffix <= MAX_WORKBOOK_COLUMNS; suffix += 1) {
      const tail = `_${suffix}`
      const candidate = `${safe.slice(0, MAX_WORKBOOK_STRING_LENGTH - tail.length)}${tail}`
      if (!seen.has(candidate)) {
        seen.add(candidate)
        return candidate
      }
    }
    throw new Error('CSV headers cannot be made unique')
  })
}

function column(
  id: string,
  header: string,
  kind: QcWorkbookColumnDescriptor['kind'],
  width?: number,
): QcWorkbookColumnDescriptor {
  return { id, header, kind, ...(width === undefined ? {} : { width }) }
}

const STATION_DATA_COLUMNS: readonly QcWorkbookColumnDescriptor[] = [
  column('timestamp', '时间', 'text', 22),
  column('SO2', 'SO2 (µg/m³)', 'number'),
  column('NO2', 'NO2 (µg/m³)', 'number'),
  column('O3', 'O3 (µg/m³)', 'number'),
  column('CO', 'CO (mg/m³)', 'number'),
  column('PM10', 'PM10 (µg/m³)', 'number'),
  column('PM2.5', 'PM2.5 (µg/m³)', 'number'),
  column('missing', '缺测项目', 'text', 24),
  column('status', '数据状态', 'text'),
]

const QC_COLUMNS: readonly QcWorkbookColumnDescriptor[] = [
  column('QC_flag', 'QC标记', 'text', 48),
  column('QC_details', 'QC详情', 'text', 72),
  column('QC_keep', 'QC保留', 'boolean'),
]

function finite(value: number | undefined): number | null {
  return Number.isFinite(value) ? value as number : null
}

function stationCells(row: StationCheckedRow | DynamicCheckedRow): QcWorkbookCell[] {
  return [
    assertBoundedString(row.timestamp, 'Timestamp'),
    finite(row.SO2), finite(row.NO2), finite(row.O3), finite(row.CO), finite(row.PM10), finite(row['PM2.5']),
    assertBoundedString(row.missing.join('；'), 'Missing variables'),
    assertBoundedString(row.status, 'Station status'),
  ]
}

function qcCells(row: StationCheckedRow | DynamicCheckedRow): QcWorkbookCell[] {
  return [
    assertBoundedString(row.QC_flag, 'QC flag'),
    assertBoundedString(JSON.stringify(row.QC_flags), 'QC details'),
    row.QC_keep,
  ]
}

function validateVariables(input: readonly UserVariableSpec[]): UserVariableSpec[] {
  if (input.length + STATION_DATA_COLUMNS.length + QC_COLUMNS.length > MAX_WORKBOOK_COLUMNS) {
    throw new Error(`User variable column count exceeds safe limit ${MAX_WORKBOOK_COLUMNS}`)
  }
  const keys = new Set<string>()
  return input.map((variable) => {
    if (!SAFE_USER_KEY.test(variable.key) || PROTOTYPE_KEYS.has(variable.key) || keys.has(variable.key)) {
      throw new Error(`Invalid, duplicate, or prototype user variable key: ${String(variable.key)}`)
    }
    if (!Number.isInteger(variable.sourceColumn) || variable.sourceColumn < 0 || variable.sourceColumn >= MAX_WORKBOOK_COLUMNS) {
      throw new Error(`Invalid source column for user variable ${variable.key}`)
    }
    assertBoundedString(variable.label, 'Variable label')
    assertBoundedString(variable.unit, 'Variable unit')
    keys.add(variable.key)
    return {
      key: variable.key,
      label: variable.label,
      unit: variable.unit,
      nonNegative: variable.nonNegative === true,
      sourceColumn: variable.sourceColumn,
    }
  })
}

function variableHeader(variable: UserVariableSpec): string {
  const label = assertBoundedString(variable.label, 'Variable label') || variable.key
  const unit = assertBoundedString(variable.unit, 'Variable unit')
  return unit ? `${label} (${unit})` : label
}

function dynamicColumns(variables: readonly UserVariableSpec[]): QcWorkbookColumnDescriptor[] {
  const headers = uniqueHeaders(variables.map(variableHeader))
  return variables.map((variable, index) => column(`user.${variable.key}`, headers[index], 'number'))
}

function dynamicCells(row: DynamicCheckedRow, variables: readonly UserVariableSpec[]): QcWorkbookCell[] {
  return variables.map(({ key }) => {
    if (!Object.prototype.hasOwnProperty.call(row.userValues, key)) return null
    return finite(row.userValues[key])
  })
}

function summaryRows(counts: Readonly<Record<string, number>>): QcWorkbookCell[][] {
  return Object.entries(counts)
    .sort(([left], [right]) => left === '正常' ? -1 : right === '正常' ? 1 : left.localeCompare(right, 'zh-CN'))
    .map(([flag, count]) => [assertBoundedString(flag, 'QC summary flag'), Number.isFinite(count) ? count : 0])
}

const SUMMARY_COLUMNS = [
  column('flag', '质控标记', 'text', 48),
  column('count', '数量', 'number', 14),
]

function safeLog(
  metadata: QcWorkbookMetadata,
  mode: 'station' | 'merged',
  counts: Record<string, number>,
  warnings: readonly string[],
  warningTotal: number,
): Record<string, unknown> {
  return sanitizeExportValue({
    ...metadata,
    mode,
    counts,
    warnings,
    warningTotal,
  }) as Record<string, unknown>
}

function logSheetRows(log: Record<string, unknown>): QcWorkbookCell[][] {
  const rows: QcWorkbookCell[][] = []
  const visit = (path: string, value: unknown): void => {
    if (rows.length >= MAX_EXPORT_ROWS) throw new Error(`Processing log row count exceeds safe limit ${MAX_EXPORT_ROWS}`)
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(`${path}[${index}]`, item))
      if (value.length === 0) rows.push([assertBoundedString(path, 'Log key'), '[]'])
      return
    }
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
      entries.forEach(([key, item]) => visit(path ? `${path}.${key}` : key, item))
      if (entries.length === 0) rows.push([assertBoundedString(path, 'Log key'), '{}'])
      return
    }
    rows.push([
      assertBoundedString(path, 'Log key'),
      assertBoundedString(value === null ? 'null' : String(value), 'Log value'),
    ])
  }
  Object.keys(log).sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .forEach((key) => visit(key, log[key]))
  return rows
}

function namedCsv(name: string, columns: readonly QcWorkbookColumnDescriptor[], rows: readonly (readonly QcWorkbookCell[])[]): NamedArtifact<string> {
  return { name, content: createModeCsv(columns.map(({ header }) => header), rows) }
}

function normalizedUnmatched(input: readonly UnmatchedExportRow[] | readonly string[]): UnmatchedExportRow[] {
  if (input.length > MAX_EXPORT_ROWS) throw new Error(`Unmatched row count exceeds safe limit ${MAX_EXPORT_ROWS}`)
  return input.map((item) => typeof item === 'string'
    ? { timestamp: item, details: '未匹配站点时间线' }
    : { timestamp: item.timestamp, details: item.details })
}

function sheet(
  name: string,
  columns: readonly QcWorkbookColumnDescriptor[],
  rows: readonly (readonly QcWorkbookCell[])[],
) {
  return { name, columns, rows }
}

export async function buildStationQcArtifacts(
  input: BuildStationQcArtifactsInput,
  options: BuildResultArtifactsOptions = {},
): Promise<StationQcArtifacts> {
  const result = input.qcResult
  const columns = [...STATION_DATA_COLUMNS, ...QC_COLUMNS]
  const cells = (row: StationCheckedRow) => [...stationCells(row), ...qcCells(row)]
  const allRows = result.rows.map(cells)
  const keptRows = result.keptRows.map(cells)
  const rejectedRows = result.rejectedRows.map(cells)
  const gapColumns = [column('timestamp', 'timestamp', 'text', 22)]
  const gapRows = result.gaps.map((timestamp): QcWorkbookCell[] => [assertBoundedString(timestamp, 'Gap timestamp')])
  const summary = summaryRows(result.counts)
  const counts = {
    all: result.rows.length,
    kept: result.keptRows.length,
    rejected: result.rejectedRows.length,
    gaps: result.gapCount,
  }
  const log = safeLog(input.metadata, 'station', counts, result.warnings, result.warnings.length)
  const logColumns = [column('item', '项目', 'text', 24), column('value', '内容', 'text', 72)]
  const model: QcWorkbookModel = {
    sheets: [
      sheet('站点质控结果', columns, allRows),
      sheet('质控保留', columns, keptRows),
      sheet('质控异常', columns, rejectedRows),
      sheet('时间缺口', gapColumns, gapRows),
      sheet('质控汇总', SUMMARY_COLUMNS, summary),
      sheet('处理日志', logColumns, logSheetRows(log)),
    ],
  }
  const checkedCsv = namedCsv('站点数据_质控结果.csv', columns, allRows)
  const gapsCsv = namedCsv('站点数据_时间缺口.csv', gapColumns, gapRows)
  const qcSummary = namedCsv('站点数据_质控汇总.csv', SUMMARY_COLUMNS, summary)
  const qcWorkbook = {
    name: '站点数据_质控报告.xlsx',
    content: await createQcWorkbookFromModel(model, options),
  }
  const processingLog = { name: '站点数据_处理日志.json', content: JSON.stringify(log, null, 2) }
  const zip = {
    name: '站点数据_质控结果.zip',
    content: await createResultZip([checkedCsv, gapsCsv, qcSummary, qcWorkbook, processingLog], options),
  }
  return { checkedCsv, gapsCsv, qcSummary, qcWorkbook, processingLog, zip }
}

export async function buildMergedQcArtifacts(
  input: BuildMergedQcArtifactsInput,
  options: BuildResultArtifactsOptions = {},
): Promise<MergedQcArtifacts> {
  const variables = validateVariables(
    input.variables ?? input.mergeResult?.variables ?? input.userDataset?.variables ?? [],
  )
  const mapping = input.mapping ?? input.userDataset?.mapping
  const mappingVariables = mapping ? validateVariables(mapping.variables) : []
  if (mapping && (!Number.isInteger(mapping.timestampColumn) || mapping.timestampColumn < 0
    || mapping.timestampColumn >= MAX_WORKBOOK_COLUMNS)) {
    throw new Error('Invalid timestampColumn in user mapping')
  }
  const dynamic = dynamicColumns(variables)
  const columns = [...STATION_DATA_COLUMNS, ...dynamic, ...QC_COLUMNS]
  const cells = (row: DynamicCheckedRow) => [...stationCells(row), ...dynamicCells(row, variables), ...qcCells(row)]
  const allRows = input.qcResult.rows.map(cells)
  const keptRows = input.qcResult.keptRows.map(cells)
  const rejectedRows = input.qcResult.rejectedRows.map(cells)
  const unmatched = normalizedUnmatched(
    input.unmatched ?? input.unmatchedTimestamps ?? input.mergeResult?.unmatchedUserTimestamps ?? [],
  )
  const unmatchedColumns = [
    column('timestamp', 'timestamp', 'text', 22),
    column('details', 'details', 'text', 72),
  ]
  const unmatchedRows = unmatched.map(({ timestamp, details }): QcWorkbookCell[] => [
    assertBoundedString(timestamp, 'Unmatched timestamp'),
    assertBoundedString(details, 'Unmatched details'),
  ])
  const variableColumns = [
    column('key', 'key', 'text'), column('label', 'label', 'text'), column('unit', 'unit', 'text'),
    column('nonNegative', 'nonNegative', 'boolean'), column('sourceColumn', 'sourceColumn', 'number'),
  ]
  const variableRows = variables.map((variable): QcWorkbookCell[] => [
    variable.key,
    assertBoundedString(variable.label, 'Variable label'),
    assertBoundedString(variable.unit, 'Variable unit'),
    variable.nonNegative,
    variable.sourceColumn,
  ])
  const mappingColumns = [
    column('timestampColumn', 'timestampColumn', 'number'), column('key', 'key', 'text'),
    column('label', 'label', 'text'), column('unit', 'unit', 'text'),
    column('nonNegative', 'nonNegative', 'boolean'), column('sourceColumn', 'sourceColumn', 'number'),
  ]
  const mappingRows = mappingVariables.map((variable): QcWorkbookCell[] => [
    mapping!.timestampColumn,
    variable.key,
    assertBoundedString(variable.label, 'Mapping label'),
    assertBoundedString(variable.unit, 'Mapping unit'),
    variable.nonNegative,
    variable.sourceColumn,
  ])
  const summary = summaryRows(input.qcResult.counts)
  const counts = {
    all: input.qcResult.rows.length,
    kept: input.qcResult.keptRows.length,
    rejected: input.qcResult.rejectedRows.length,
    gaps: input.qcResult.gapCount,
    unmatched: unmatched.length,
  }
  const warningTotal = input.warningTotal ?? input.mergeResult?.warningTotal ?? input.qcResult.warnings.length
  if (!Number.isSafeInteger(warningTotal) || warningTotal < input.qcResult.warnings.length) {
    throw new Error('warningTotal must be a safe integer no smaller than the shown warning count')
  }
  const log = safeLog(input.metadata, 'merged', counts, input.qcResult.warnings, warningTotal)
  const logColumns = [column('item', '项目', 'text', 24), column('value', '内容', 'text', 72)]
  const model: QcWorkbookModel = {
    sheets: [
      sheet('合并质控结果', columns, allRows),
      sheet('质控保留', columns, keptRows),
      sheet('质控异常', columns, rejectedRows),
      sheet('未匹配时间', unmatchedColumns, unmatchedRows),
      sheet('变量说明', variableColumns, variableRows),
      sheet('映射说明', mappingColumns, mappingRows),
      sheet('质控汇总', SUMMARY_COLUMNS, summary),
      sheet('处理日志', logColumns, logSheetRows(log)),
    ],
  }
  const checkedCsv = namedCsv('合并数据_质控结果.csv', columns, allRows)
  const unmatchedCsv = namedCsv('合并数据_未匹配时间.csv', unmatchedColumns, unmatchedRows)
  const variablesCsv = namedCsv('合并数据_变量说明.csv', variableColumns, variableRows)
  const mappingCsv = namedCsv('合并数据_映射说明.csv', mappingColumns, mappingRows)
  const qcSummary = namedCsv('合并数据_质控汇总.csv', SUMMARY_COLUMNS, summary)
  const qcWorkbook = {
    name: '合并数据_质控报告.xlsx',
    content: await createQcWorkbookFromModel(model, options),
  }
  const processingLog = { name: '合并数据_处理日志.json', content: JSON.stringify(log, null, 2) }
  const zip = {
    name: '合并数据_质控结果.zip',
    content: await createResultZip(
      [checkedCsv, unmatchedCsv, variablesCsv, mappingCsv, qcSummary, qcWorkbook, processingLog],
      options,
    ),
  }
  return {
    checkedCsv, unmatchedCsv, variablesCsv, mappingCsv, qcSummary, qcWorkbook, processingLog, zip,
  }
}

export async function buildCombinedQcDownload(
  input: CombinedQcArtifactsInput,
  options: BuildResultArtifactsOptions = {},
): Promise<NamedArtifact<Blob>> {
  if (!input.station) throw new Error('station QC artifacts are required for the combined download')
  if (!input.merged) throw new Error('merged QC artifacts are required for the combined download')
  const station = input.station
  const merged = input.merged
  const files = [
    { name: `station-qc/${station.checkedCsv.name}`, content: station.checkedCsv.content },
    { name: `station-qc/${station.gapsCsv.name}`, content: station.gapsCsv.content },
    { name: `station-qc/${station.qcSummary.name}`, content: station.qcSummary.content },
    { name: `station-qc/${station.qcWorkbook.name}`, content: station.qcWorkbook.content },
    { name: `station-qc/${station.processingLog.name}`, content: station.processingLog.content },
    { name: `merged-qc/${merged.checkedCsv.name}`, content: merged.checkedCsv.content },
    { name: `merged-qc/${merged.unmatchedCsv.name}`, content: merged.unmatchedCsv.content },
    { name: `merged-qc/${merged.variablesCsv.name}`, content: merged.variablesCsv.content },
    { name: `merged-qc/${merged.mappingCsv.name}`, content: merged.mappingCsv.content },
    { name: `merged-qc/${merged.qcSummary.name}`, content: merged.qcSummary.content },
    { name: `merged-qc/${merged.qcWorkbook.name}`, content: merged.qcWorkbook.content },
    { name: `merged-qc/${merged.processingLog.name}`, content: merged.processingLog.content },
  ]
  return {
    name: '全部数据_质控结果.zip',
    content: await createResultZip(files, options),
  }
}
