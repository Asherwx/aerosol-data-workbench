export const EXPORT_HEADERS = [
  '时间',
  'SO2_μg_m3',
  'NO2_μg_m3',
  'O3_μg_m3',
  'CO_mg_m3',
  'PM10_μg_m3',
  'PM2.5_μg_m3',
  '缺测项目',
  '数据状态',
  'NO3_μg_m3',
  'SO4_μg_m3',
  'NH4_μg_m3',
  'QC_flag',
  'QC_keep',
] as const

export interface QcWorkbookMetadata {
  processingTime: string
  stationId: string
  inputFiles: readonly string[]
  inputCounts: Readonly<Record<string, string | number | boolean | null>>
  rowCounts: Readonly<Record<string, string | number | boolean | null>>
  warnings: readonly string[]
  version: string
  logicNotes: readonly string[]
}

export const MAX_WORKBOOK_SHEETS = 16
export const MAX_WORKBOOK_COLUMNS = 1_000
export const MAX_WORKBOOK_ROWS = 366 * 24
export const MAX_WORKBOOK_CELLS = 2_000_000
export const MAX_WORKBOOK_STRING_LENGTH = 32_768
export const MAX_WORKBOOK_ESTIMATED_BYTES = 16 * 1024 * 1024

export type QcWorkbookCell = string | number | boolean | null
export type QcWorkbookColumnKind = 'text' | 'number' | 'boolean' | 'auto'

export interface QcWorkbookColumnDescriptor {
  id: string
  header: string
  kind: QcWorkbookColumnKind
  width?: number
}

export interface QcWorkbookSheetModel {
  name: string
  columns: readonly QcWorkbookColumnDescriptor[]
  rows: readonly (readonly QcWorkbookCell[])[]
}

export interface QcWorkbookModel {
  sheets: readonly QcWorkbookSheetModel[]
}

export const QC_WORKBOOK_PROTOCOL_VERSION = 1 as const
export interface QcWorkbookWorkerRequest {
  version: typeof QC_WORKBOOK_PROTOCOL_VERSION
  model: QcWorkbookModel
}
export type QcWorkbookWorkerResponse =
  | { ok: true; buffer: ArrayBuffer }
  | { ok: false; message: string }

export function safeSpreadsheetString(value: string): string {
  return /^[\s]*[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

const MAX_METADATA_ITEMS = 100
const MAX_METADATA_TEXT_LENGTH = 500
const MAX_METADATA_KEY_LENGTH = 120
const MAX_METADATA_DEPTH = 8
const UNSAFE_DIRECTIONAL_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
// A path token starts at the beginning of text or after any non-word
// character. Excluding slash from the POSIX boundary preserves the second
// slash in normal protocol URLs such as https://host/path.
const FILE_URL_PATH = /(^|[^\p{L}\p{N}_])file:\/\/[^,;，；|<>"'\[\]{}\n\r]+/giu
const WINDOWS_ABSOLUTE_PATH = /(^|[^\p{L}\p{N}_])(?:[A-Za-z]:[\\/]|\\\\)[^,;，；|<>"'\[\]{}\n\r]+/gu
const POSIX_ABSOLUTE_PATH = /(^|[^\p{L}\p{N}_/])\/(?!\/)[^,;，；|<>"'\[\]{}\n\r]+/gu

export function sanitizeLogText(value: string, limit = MAX_METADATA_TEXT_LENGTH): string {
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.min(MAX_METADATA_TEXT_LENGTH, Math.floor(limit)))
    : MAX_METADATA_TEXT_LENGTH
  return value
    .replace(UNSAFE_DIRECTIONAL_OR_CONTROL, '')
    .replace(FILE_URL_PATH, '$1[已移除本地路径]')
    .replace(WINDOWS_ABSOLUTE_PATH, '$1[已移除本地路径]')
    .replace(POSIX_ABSOLUTE_PATH, '$1[已移除本地路径]')
    .slice(0, boundedLimit)
}

function uniqueSanitizedKey(
  rawKey: string,
  target: Record<string, unknown>,
  index: number,
): string {
  const cleaned = sanitizeLogText(rawKey, MAX_METADATA_KEY_LENGTH) || `字段_${index + 1}`
  const safe = cleaned === '__proto__' || cleaned === 'constructor' || cleaned === 'prototype'
    ? `_${cleaned}`
    : cleaned
  if (!Object.prototype.hasOwnProperty.call(target, safe)) return safe
  for (let suffix = 2; suffix <= MAX_METADATA_ITEMS; suffix += 1) {
    const candidate = `${safe.slice(0, MAX_METADATA_KEY_LENGTH - String(suffix).length - 1)}_${suffix}`
    if (!Object.prototype.hasOwnProperty.call(target, candidate)) return candidate
  }
  return `字段_${index + 1}`
}

function sanitizeMetadataValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeLogText(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (depth >= MAX_METADATA_DEPTH) return '[内容层级过深]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_METADATA_ITEMS).map((item) => sanitizeMetadataValue(item, depth + 1))
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = Object.create(null)
    Object.entries(value).slice(0, MAX_METADATA_ITEMS).forEach(([key, item], index) => {
      result[uniqueSanitizedKey(key, result, index)] = sanitizeMetadataValue(item, depth + 1)
    })
    return result
  }
  return null
}

export function sanitizeExportValue(value: unknown): unknown {
  return sanitizeMetadataValue(value)
}

export function sanitizeQcWorkbookMetadata(metadata: QcWorkbookMetadata): QcWorkbookMetadata {
  return sanitizeMetadataValue(metadata) as QcWorkbookMetadata
}

const SAFE_COLUMN_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const INVALID_SHEET_NAME = /[\\/?*:[\]]/g

function normalizedWorkbookString(value: string, context: string): string {
  if (value.length > MAX_WORKBOOK_STRING_LENGTH) {
    throw new Error(`${context} string length exceeds safe limit ${MAX_WORKBOOK_STRING_LENGTH}`)
  }
  return safeSpreadsheetString(value.replace(UNSAFE_DIRECTIONAL_OR_CONTROL, ''))
}

function uniqueWorkbookHeader(value: string, seen: Set<string>): string {
  const safe = normalizedWorkbookString(value, 'Workbook header') || '字段'
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
  throw new Error('Workbook headers cannot be made unique')
}

function uniqueSheetName(value: string, seen: Set<string>): string {
  const safe = value.replace(UNSAFE_DIRECTIONAL_OR_CONTROL, '').replace(INVALID_SHEET_NAME, '_').trim()
  if (!safe) throw new Error('Workbook sheet name must not be empty')
  const base = safe.slice(0, 31)
  if (!seen.has(base)) {
    seen.add(base)
    return base
  }
  for (let suffix = 2; suffix <= MAX_WORKBOOK_SHEETS; suffix += 1) {
    const tail = `_${suffix}`
    const candidate = `${base.slice(0, 31 - tail.length)}${tail}`
    if (!seen.has(candidate)) {
      seen.add(candidate)
      return candidate
    }
  }
  throw new Error('Workbook sheet names cannot be made unique')
}

function normalizeWorkbookCell(
  value: unknown,
  kind: QcWorkbookColumnKind,
  context: string,
): QcWorkbookCell {
  if (value === null || value === undefined) return null
  if (kind === 'number') {
    if (typeof value !== 'number') throw new Error(`${context} must be numeric or blank`)
    return Number.isFinite(value) ? value : null
  }
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${context} must be boolean or blank`)
    return value
  }
  if (kind === 'auto') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') return normalizedWorkbookString(value, context)
    throw new Error(`${context} has an unsupported value type`)
  }
  if (typeof value !== 'string') throw new Error(`${context} must be text or blank`)
  return normalizedWorkbookString(value, context)
}

export function normalizeQcWorkbookModel(value: unknown): QcWorkbookModel {
  if (typeof value !== 'object' || value === null
    || !Object.prototype.hasOwnProperty.call(value, 'sheets')
    || !Array.isArray((value as { sheets?: unknown }).sheets)) {
    throw new Error('Workbook request envelope is invalid')
  }
  const inputSheets = (value as { sheets: unknown[] }).sheets
  if (inputSheets.length < 1 || inputSheets.length > MAX_WORKBOOK_SHEETS) {
    throw new Error(`Workbook sheet count exceeds safe limit ${MAX_WORKBOOK_SHEETS}`)
  }

  let totalCells = 0
  let estimatedBytes = 0
  const sheetNames = new Set<string>()
  const sheets = inputSheets.map((candidate, sheetIndex): QcWorkbookSheetModel => {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new Error(`Workbook sheet ${sheetIndex + 1} is invalid`)
    }
    const record = candidate as Record<string, unknown>
    if (typeof record.name !== 'string' || !Array.isArray(record.columns) || !Array.isArray(record.rows)) {
      throw new Error(`Workbook sheet ${sheetIndex + 1} envelope is invalid`)
    }
    if (record.columns.length < 1 || record.columns.length > MAX_WORKBOOK_COLUMNS) {
      throw new Error(`Workbook column count exceeds safe limit ${MAX_WORKBOOK_COLUMNS}`)
    }
    if (record.rows.length > MAX_WORKBOOK_ROWS) {
      throw new Error(`Workbook row count exceeds safe limit ${MAX_WORKBOOK_ROWS}`)
    }

    const ids = new Set<string>()
    const headers = new Set<string>()
    const columns = record.columns.map((column, columnIndex): QcWorkbookColumnDescriptor => {
      if (typeof column !== 'object' || column === null) {
        throw new Error(`Workbook column ${columnIndex + 1} is invalid`)
      }
      const descriptor = column as Record<string, unknown>
      if (typeof descriptor.id !== 'string' || !SAFE_COLUMN_ID.test(descriptor.id)
        || PROTOTYPE_KEYS.has(descriptor.id) || ids.has(descriptor.id)) {
        throw new Error(`Workbook column id is invalid or duplicate: ${String(descriptor.id)}`)
      }
      if (typeof descriptor.header !== 'string'
        || (descriptor.kind !== 'text' && descriptor.kind !== 'number'
          && descriptor.kind !== 'boolean' && descriptor.kind !== 'auto')) {
        throw new Error(`Workbook column descriptor ${columnIndex + 1} is invalid`)
      }
      const width = descriptor.width === undefined ? undefined : Number(descriptor.width)
      if (width !== undefined && (!Number.isFinite(width) || width < 1 || width > 120)) {
        throw new Error(`Workbook column width is invalid: ${String(descriptor.width)}`)
      }
      ids.add(descriptor.id)
      return {
        id: descriptor.id,
        header: uniqueWorkbookHeader(descriptor.header, headers),
        kind: descriptor.kind,
        ...(width === undefined ? {} : { width }),
      }
    })

    const rows = record.rows.map((row, rowIndex): QcWorkbookCell[] => {
      if (!Array.isArray(row) || row.length !== columns.length) {
        throw new Error(`Workbook row ${rowIndex + 1} has an invalid column count`)
      }
      totalCells += row.length
      if (totalCells > MAX_WORKBOOK_CELLS) {
        throw new Error(`Workbook cell count exceeds safe limit ${MAX_WORKBOOK_CELLS}`)
      }
      return row.map((cell, columnIndex) => {
        const normalized = normalizeWorkbookCell(
          cell,
          columns[columnIndex].kind,
          `Workbook cell ${rowIndex + 1}:${columnIndex + 1}`,
        )
        estimatedBytes += typeof normalized === 'string' ? normalized.length * 2 : 8
        if (estimatedBytes > MAX_WORKBOOK_ESTIMATED_BYTES) {
          throw new Error(`Workbook estimated file size exceeds safe limit ${MAX_WORKBOOK_ESTIMATED_BYTES}`)
        }
        return normalized
      })
    })

    return {
      name: uniqueSheetName(record.name, sheetNames),
      columns,
      rows,
    }
  })
  return { sheets }
}
