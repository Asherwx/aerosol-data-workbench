import Papa from 'papaparse'
import { boundedDisplay } from './display'

export interface UserVariableSpec {
  key: string
  label: string
  unit: string
  nonNegative: boolean
  sourceColumn: number
}

export interface UserDataMapping {
  timestampColumn: number
  variables: UserVariableSpec[]
}

export interface UserDataRow {
  timestamp: string
  values: Record<string, number | undefined>
}

export interface UserMappingColumn {
  sourceColumn: number
  label: string
}

export interface UserMappingRequired {
  reason: 'missing-time' | 'ambiguous-time'
  timeCandidates: number[]
  columns: UserMappingColumn[]
}

export interface ParsedUserData {
  rows: UserDataRow[]
  variables: UserVariableSpec[]
  mapping?: UserDataMapping
  mappingRequired?: UserMappingRequired
  warnings: string[]
  warningTotal: number
  sheetName: string
}

/** Stable public name used by pipeline consumers. */
export type ParsedUserDataset = ParsedUserData

export const USER_DATA_MAX_PHYSICAL_ROWS = 100_000
export const USER_DATA_MAX_ROWS = 8_784
export const USER_DATA_WARNING_CAP = 100
export const USER_CSV_MAX_BYTES = 25 * 1024 * 1024
export const MAX_USER_CELLS = 2_000_000
export const MAX_USER_CELL_CHARS = 32_768
export const MAX_USER_ROW_CELLS = 1_000
export const MAX_USER_SHEETS = 20

const HEADER_SCAN_LIMIT = 20
const MAX_COLUMNS = 1_000
const MAX_LABEL = 120
const MAX_UNIT = 48
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/

class WarningCollector {
  readonly warnings: string[] = []
  total = 0
  add(message: string): void {
    this.total += 1
    if (this.total < USER_DATA_WARNING_CAP) this.warnings.push(boundedDisplay(message, 1_000))
    else if (this.total === USER_DATA_WARNING_CAP) {
      this.warnings.push(`Warning limit reached; only the first ${USER_DATA_WARNING_CAP - 1} warnings are shown and the remainder are truncated.`)
    }
  }
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

function displayText(value: unknown, max = MAX_LABEL): string {
  const text = boundedDisplay(value, max)
  return /^[=+@-]/.test(text) ? boundedDisplay(`'${text}`, max) : text
}

function normalizedTimeAlias(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const key = value.normalize('NFKC').trim().toLowerCase().replace(/[\s_\-()（）]/g, '')
  return ['time', 'timestamp', 'datetime', 'dateandtime', '日期时间', '时间', '日期'].includes(key)
}

function safeKey(label: string, index: number, used: Set<string>): string {
  let key = label
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g, '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!/^[a-z]/.test(key)) key = `variable_${index + 1}${key ? `_${key}` : ''}`
  key = key.slice(0, 64).replace(/_+$/g, '')
  if (!key || PROTOTYPE_KEYS.has(key)) key = `variable_${index + 1}`
  const base = key
  let suffix = 2
  while (used.has(key) || PROTOTYPE_KEYS.has(key)) {
    const tail = `_${suffix++}`
    key = `${base.slice(0, 64 - tail.length)}${tail}`
  }
  used.add(key)
  return key
}

function isKnownUnit(unit: string): boolean {
  if (!unit) return true
  const key = unit.normalize('NFKC').toLowerCase()
    .replace(/[μµ]/g, 'u')
    .replace(/[−‐‑‒–—﹣－]/g, '-')
    .replace(/[\s·.\/\\^]/g, '')
  return /^(?:u|m|n)gm-?3$/.test(key) ||
    ['ppb', 'ppm', 'ppt', '%', 'c', '°c', 'k', 'ms', 'm/s', 'hpa', 'pa'].includes(key)
}

function looksLikeUnitRow(row: readonly unknown[], timestampColumn: number): boolean {
  const first = row[timestampColumn]
  if (typeof first === 'string' && /^(?:unit|units|单位)\s*[:：]?$/i.test(first.trim())) return true
  if (!isBlank(first)) return false
  return row.some((cell, index) => index !== timestampColumn && !isBlank(cell))
}

function validateMapping(mapping: UserDataMapping, columnCount: number): UserDataMapping {
  if (!Number.isInteger(mapping.timestampColumn) || mapping.timestampColumn < 0 || mapping.timestampColumn >= columnCount) {
    throw new Error('Timestamp source column is invalid.')
  }
  if (!Array.isArray(mapping.variables) || mapping.variables.length < 1) {
    throw new Error('Mapping must contain at least one variable.')
  }
  if (mapping.variables.length > MAX_COLUMNS) throw new Error(`Mapping exceeds ${MAX_COLUMNS} variables.`)
  const columns = new Set<number>([mapping.timestampColumn])
  const keys = new Set<string>()
  const variables = mapping.variables.map((variable) => {
    if (!Number.isInteger(variable.sourceColumn) || variable.sourceColumn < 0 || variable.sourceColumn >= columnCount) {
      throw new Error('Variable source column is invalid.')
    }
    if (columns.has(variable.sourceColumn)) throw new Error('Every source column must be unique, including the timestamp column.')
    columns.add(variable.sourceColumn)
    if (typeof variable.key !== 'string' || !SAFE_KEY.test(variable.key) || PROTOTYPE_KEYS.has(variable.key)) {
      throw new Error('Variable key must be a safe lowercase canonical key.')
    }
    if (keys.has(variable.key)) throw new Error('Variable keys must be unique.')
    keys.add(variable.key)
    if (typeof variable.label !== 'string' || !variable.label.trim()) throw new Error('Variable label is required.')
    if (typeof variable.unit !== 'string') throw new Error('Variable unit must be text.')
    if (typeof variable.nonNegative !== 'boolean') throw new Error('Variable nonNegative flag must be boolean.')
    const label = displayText(variable.label, MAX_LABEL)
    if (!label) throw new Error('Variable label is empty after sanitization.')
    return {
      key: variable.key,
      label,
      unit: displayText(variable.unit, MAX_UNIT),
      nonNegative: variable.nonNegative,
      sourceColumn: variable.sourceColumn,
    }
  })
  return { timestampColumn: mapping.timestampColumn, variables }
}

function discoverMapping(matrix: readonly (readonly unknown[])[]): {
  headerRow: number
  headerRows: 0 | 1 | 2
  unitRow?: number
  mapping?: UserDataMapping
  mappingRequired?: UserMappingRequired
} {
  for (let rowIndex = 0; rowIndex < Math.min(matrix.length, HEADER_SCAN_LIMIT); rowIndex += 1) {
    const row = matrix[rowIndex] ?? []
    const candidates: number[] = []
    row.slice(0, MAX_COLUMNS).forEach((cell, index) => {
      if (normalizedTimeAlias(cell)) candidates.push(index)
    })
    if (candidates.length === 0) continue
    const next = matrix[rowIndex + 1]
    const width = Math.min(MAX_COLUMNS, Math.max(row.length, next?.length ?? 0))
    const columns = Array.from({ length: width }, (_, sourceColumn) => ({
      sourceColumn,
      label: displayText(row[sourceColumn] || next?.[sourceColumn] || `Column ${sourceColumn + 1}`),
    }))
    if (candidates.length !== 1) {
      return { headerRow: rowIndex, headerRows: 1, mappingRequired: { reason: 'ambiguous-time', timeCandidates: candidates, columns } }
    }
    const timestampColumn = candidates[0]
    const unitRow = next && looksLikeUnitRow(next, timestampColumn) ? rowIndex + 1 : undefined
    const used = new Set<string>()
    const variables: UserVariableSpec[] = []
    Array.from({ length: width }).forEach((_, sourceColumn) => {
      const primary = row[sourceColumn]
      const secondary = unitRow === undefined ? undefined : next?.[sourceColumn]
      const labelCell = isBlank(primary) ? secondary : primary
      if (sourceColumn === timestampColumn || isBlank(labelCell) || normalizedTimeAlias(labelCell)) return
      const label = displayText(labelCell)
      variables.push({
        key: safeKey(label, sourceColumn, used),
        label,
        unit: unitRow === undefined || isBlank(primary) ? '' : displayText(secondary ?? '', MAX_UNIT),
        nonNegative: !/(?:temp|temperature|温度|anomaly|change|变化)/i.test(label),
        sourceColumn,
      })
    })
    if (variables.length === 0) {
      return { headerRow: rowIndex, headerRows: unitRow === undefined ? 1 : 2, unitRow, mappingRequired: { reason: 'missing-time', timeCandidates: candidates, columns } }
    }
    return { headerRow: rowIndex, headerRows: unitRow === undefined ? 1 : 2, unitRow, mapping: { timestampColumn, variables } }
  }
  const widest = matrix.slice(0, HEADER_SCAN_LIMIT).reduce<readonly unknown[]>((best, row) => row.length > best.length ? row : best, [])
  return {
    headerRow: 0,
    headerRows: 0,
    mappingRequired: {
      reason: 'missing-time',
      timeCandidates: [],
      columns: widest.slice(0, MAX_COLUMNS).map((cell, sourceColumn) => ({ sourceColumn, label: displayText(cell || `Column ${sourceColumn + 1}`) })),
    },
  }
}

function pad(value: number): string { return String(value).padStart(2, '0') }

function validateParts(parts: readonly number[]): { timestamp?: string; reason?: 'invalid' | 'nonhour' } {
  const [year, month, day, hour, minute, second] = parts
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    return { reason: 'invalid' }
  }
  if (minute !== 0 || second !== 0) return { reason: 'nonhour' }
  return { timestamp: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:00:00` }
}

function parseTimestamp(value: unknown): { timestamp?: string; reason?: 'invalid' | 'nonhour' } {
  // Date and Excel serial cells are interpreted using UTC fields as workbook
  // wall-clock components. No host timezone shift is applied.
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return validateParts([value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds()])
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const wholeDays = Math.floor(value)
    if (wholeDays === 60) return { reason: 'invalid' }
    const fractionMilliseconds = Math.round((value - wholeDays) * 86_400_000)
    const epoch = wholeDays < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)
    const date = new Date(epoch + wholeDays * 86_400_000 + fractionMilliseconds)
    return validateParts([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()])
  }
  if (typeof value !== 'string') return { reason: 'invalid' }
  const normalized = value.trim().replace(/[年\/]/g, '-').replace(/月/g, '-').replace(/日/g, ' ')
    .replace(/时/g, ':').replace(/[分秒]/g, '').replace(/\s+/g, ' ')
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):?(\d{1,2})?(?::(\d{1,2}))?$/.exec(normalized)
  if (!match) return { reason: 'invalid' }
  return validateParts([Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5] ?? 0), Number(match[6] ?? 0)])
}

function emptyResult(sheetName: string, mappingRequired: UserMappingRequired): ParsedUserData {
  return { rows: [], variables: [], warnings: [], warningTotal: 0, sheetName: boundedDisplay(sheetName, MAX_LABEL), mappingRequired }
}

export function parseUserMatrix(
  matrix: readonly (readonly unknown[])[],
  filename: string,
  sheetName = 'Data',
  explicitMapping?: UserDataMapping,
): ParsedUserData {
  assertUserMatrixBudgets(matrix, filename)
  // At most two adjacent rows can be structural headers. This cheap outer
  // bound runs before header discovery, while the exact bound below subtracts
  // only the 0, 1, or 2 header rows that were actually detected.
  if (matrix.length > USER_DATA_MAX_PHYSICAL_ROWS + 2) {
    throw new Error(`${boundedDisplay(filename, 160)} exceeds the ${USER_DATA_MAX_PHYSICAL_ROWS} physical-row limit.`)
  }
  const columnCount = Math.min(MAX_COLUMNS, matrix.reduce((max, row) => Math.max(max, row.length), 0))
  const discovered = explicitMapping ? { headerRow: 0, headerRows: 1 as const } : discoverMapping(matrix)
  const physicalRows = matrix.length - discovered.headerRows
  if (physicalRows > USER_DATA_MAX_PHYSICAL_ROWS) {
    throw new Error(`${boundedDisplay(filename, 160)} exceeds the ${USER_DATA_MAX_PHYSICAL_ROWS} physical-row limit (${physicalRows} rows after detected headers).`)
  }
  if (!explicitMapping && discovered.mappingRequired) return emptyResult(sheetName, discovered.mappingRequired)
  const mapping = validateMapping(explicitMapping ?? discovered.mapping as UserDataMapping, columnCount)
  const dataStart = explicitMapping ? 1 : (discovered.unitRow ?? discovered.headerRow) + 1
  const collector = new WarningCollector()
  for (const variable of mapping.variables) {
    if (variable.unit && !isKnownUnit(variable.unit)) collector.add(`Unknown unit "${variable.unit}" for ${variable.label}; values were not converted.`)
  }
  const rows = new Map<string, UserDataRow>()
  for (let index = dataStart; index < matrix.length; index += 1) {
    const source = matrix[index] ?? []
    if (source.every(isBlank)) continue
    const parsed = parseTimestamp(source[mapping.timestampColumn])
    if (!parsed.timestamp) {
      collector.add(`Row ${index + 1}: ${parsed.reason === 'nonhour' ? 'non-hour timestamp' : 'invalid timestamp'} "${boundedDisplay(source[mapping.timestampColumn])}" was skipped.`)
      continue
    }
    let row = rows.get(parsed.timestamp)
    if (!row) {
      row = { timestamp: parsed.timestamp, values: {} }
      rows.set(parsed.timestamp, row)
    }
    for (const variable of mapping.variables) {
      const raw = source[variable.sourceColumn]
      if (isBlank(raw)) continue
      const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(numeric)) {
        collector.add(`Row ${index + 1}: invalid or non-finite ${variable.key} value "${boundedDisplay(raw)}" was treated as missing.`)
        continue
      }
      if (variable.nonNegative && numeric < 0) collector.add(`Row ${index + 1}: ${variable.key} is negative (${numeric}); it was retained for downstream quality control.`)
      const existing = row.values[variable.key]
      if (existing === undefined) row.values[variable.key] = numeric
      else if (existing !== numeric) collector.add(`Row ${index + 1}: duplicate timestamp conflict for ${variable.key}; first finite value ${existing} was retained and ${numeric} ignored.`)
    }
  }
  const outputRows = [...rows.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  if (outputRows.length > USER_DATA_MAX_ROWS) throw new Error(`Canonical data exceeds the ${USER_DATA_MAX_ROWS}-hour limit.`)
  if (outputRows.length > 1) {
    const first = Date.parse(`${outputRows[0].timestamp.replace(' ', 'T')}Z`)
    const last = Date.parse(`${outputRows.at(-1)?.timestamp.replace(' ', 'T')}Z`)
    if ((last - first) / 3_600_000 + 1 > USER_DATA_MAX_ROWS) throw new Error(`Canonical time range exceeds the ${USER_DATA_MAX_ROWS}-hour limit.`)
  }
  const variables = mapping.variables.map((item) => ({ ...item }))
  return {
    rows: outputRows,
    variables,
    mapping: { timestampColumn: mapping.timestampColumn, variables: variables.map((item) => ({ ...item })) },
    warnings: collector.warnings,
    warningTotal: collector.total,
    sheetName: boundedDisplay(sheetName, MAX_LABEL),
  }
}

export function parseUserCsv(text: string, filename: string, mapping?: UserDataMapping): ParsedUserData {
  if (utf8BytesExceed(text, USER_CSV_MAX_BYTES)) throw new Error('CSV exceeds the 25 MiB limit.')
  const rows: unknown[][] = []
  let cells = 0
  let failure: Error | undefined
  Papa.parse<unknown[]>(text, {
    delimiter: ',',
    skipEmptyLines: false,
    step(result, parser) {
      if (failure) { parser.abort(); return }
      if (result.errors.length > 0) {
        failure = new Error(`${boundedDisplay(filename, 160)} is not valid CSV: ${boundedDisplay(result.errors[0]?.message, 200)}`)
        parser.abort(); return
      }
      const row = result.data
      if (rows.length >= USER_DATA_MAX_PHYSICAL_ROWS + 2) {
        failure = new Error(`${boundedDisplay(filename, 160)} exceeds the ${USER_DATA_MAX_PHYSICAL_ROWS} physical-row limit during CSV decoding.`)
        parser.abort(); return
      }
      try { assertUserRowBudget(row, filename, cells) }
      catch (error) { failure = error instanceof Error ? error : new Error(String(error)); parser.abort(); return }
      cells += row.length
      rows.push(row.slice())
    },
  })
  if (failure) throw failure
  return parseUserMatrix(rows, filename, 'CSV', mapping)
}

function utf8BytesExceed(value: string, limit: number): boolean {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index += 1
    } else bytes += 3
    if (bytes > limit) return true
  }
  return false
}

function assertUserRowBudget(row: readonly unknown[], filename: string, cellsBefore: number): void {
  if (row.length > MAX_USER_ROW_CELLS) throw new Error(`${boundedDisplay(filename, 160)} has a logical row longer than the ${MAX_USER_ROW_CELLS}-cell limit.`)
  if (cellsBefore + row.length > MAX_USER_CELLS) throw new Error(`${boundedDisplay(filename, 160)} exceeds the ${MAX_USER_CELLS} total cell limit.`)
  for (const cell of row) {
    if (typeof cell === 'string' && cell.length > MAX_USER_CELL_CHARS) {
      throw new Error(`${boundedDisplay(filename, 160)} contains a cell exceeding the ${MAX_USER_CELL_CHARS} character limit.`)
    }
  }
}

export function assertUserMatrixBudgets(
  matrix: readonly (readonly unknown[])[],
  filename: string,
): void {
  let cells = 0
  if (matrix.length > USER_DATA_MAX_PHYSICAL_ROWS + 2) {
    throw new Error(`${boundedDisplay(filename, 160)} exceeds the ${USER_DATA_MAX_PHYSICAL_ROWS} physical-row limit.`)
  }
  for (const row of matrix) {
    assertUserRowBudget(row, filename, cells)
    cells += row.length
  }
}
