import { boundedDisplay } from './display'

export interface IonRow {
  timestamp: string
  NO3?: number
  SO4?: number
  NH4?: number
}

export interface ParsedIonWorkbook {
  rows: IonRow[]
  sheetName: string
  warnings: string[]
}

export type IonWorkbookCell = string | number | boolean | Date | null

export interface IonWorkbookSheet {
  sheet: string
  data: IonWorkbookCell[][]
}

export interface IonWorkbookSheetInput {
  sheet: string
  data: readonly (readonly unknown[])[]
}

export const ION_WORKBOOK_MAX_ROWS = 100_000
export const ION_WORKBOOK_WARNING_CAP = 100

type Ion = 'NO3' | 'SO4' | 'NH4'
type HeaderMap = Record<'timestamp' | Ion, number>

const HEADER_SCAN_LIMIT = 20
const IONS: readonly Ion[] = ['NO3', 'SO4', 'NH4']

class WarningCollector {
  readonly warnings: string[] = []
  private count = 0
  private readonly filename: string
  private readonly sheetName: string

  constructor(filename: string, sheetName: string) {
    this.filename = boundedDisplay(filename, 160)
    this.sheetName = boundedDisplay(sheetName, 120)
  }

  add(message: string): void {
    this.count += 1
    if (this.count < ION_WORKBOOK_WARNING_CAP) {
      this.warnings.push(message)
    } else if (this.count === ION_WORKBOOK_WARNING_CAP) {
      this.warnings.push(
        `${this.filename}（工作表“${this.sheetName}”）：警告过多，仅显示前 ${ION_WORKBOOK_WARNING_CAP - 1} 条，其余已截断；请先检查源文件格式和数据质量`,
      )
    }
  }
}

function normalizedHeader(value: unknown): 'timestamp' | Ion | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .replace(/_x[0-9a-f]{4}_/gi, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[μµ]/g, 'u')
    .replace(/硝酸根/g, 'no3')
    .replace(/硫酸根/g, 'so4')
    .replace(/铵根/g, 'nh4')
    .replace(/[\s_·.\/\\^+\-−()（）\[\]]/g, '')

  if (['time', 'datetime', '日期时间', '时间'].includes(normalized)) return 'timestamp'
  if (/^no3(?:ugm?3)?$/.test(normalized)) return 'NO3'
  if (/^so4(?:2)?(?:ugm?3)?$/.test(normalized)) return 'SO4'
  if (/^nh4(?:ugm?3)?$/.test(normalized)) return 'NH4'
  return undefined
}

function findHeader(matrix: readonly (readonly unknown[])[]): {
  rowIndex: number
  columns: Partial<HeaderMap>
} | undefined {
  const rowColumns = matrix.slice(0, HEADER_SCAN_LIMIT).map((row) => {
    const columns: Partial<HeaderMap> = {}
    row.forEach((cell, columnIndex) => {
      const header = normalizedHeader(cell)
      if (header !== undefined && columns[header] === undefined) columns[header] = columnIndex
    })
    return columns
  })

  for (let rowIndex = 0; rowIndex < Math.min(HEADER_SCAN_LIMIT, matrix.length); rowIndex += 1) {
    const single = rowColumns[rowIndex]
    if (isCompleteDistinctHeader(single)) return { rowIndex, columns: single }

    if (rowIndex + 1 < rowColumns.length) {
      const next = rowColumns[rowIndex + 1]
      const combined: Partial<HeaderMap> = { ...single }
      for (const header of ['timestamp', ...IONS] as const) {
        if (combined[header] === undefined) combined[header] = next[header]
      }
      if (isCompleteDistinctHeader(combined)) return { rowIndex: rowIndex + 1, columns: combined }
    }
  }
  return undefined
}

function isCompleteDistinctHeader(columns: Partial<HeaderMap>): boolean {
  const indices = (['timestamp', ...IONS] as const).map((header) => columns[header])
  return indices.every((index) => index !== undefined) && new Set(indices).size === indices.length
}

function missingHeaders(matrix: readonly (readonly unknown[])[]): string[] {
  const found = new Set<'timestamp' | Ion>()
  for (const row of matrix.slice(0, HEADER_SCAN_LIMIT)) {
    for (const cell of row) {
      const header = normalizedHeader(cell)
      if (header) found.add(header)
    }
  }
  return (['timestamp', ...IONS] as const)
    .filter((header) => !found.has(header))
    .map((header) => (header === 'timestamp' ? 'timestamp（时间）' : header))
}

function context(filename: string, sheetName: string, rowNumber?: number): string {
  return `${boundedDisplay(filename, 160)}（工作表“${boundedDisplay(sheetName, 120)}”${rowNumber ? `，第 ${rowNumber} 行` : ''}）`
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

function unitKey(value: unknown): string {
  return typeof value === 'string'
    ? value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[μµ]/g, 'u')
        .replace(/[−‐‑‒–—﹣－]/g, '-')
        .replace(/[\s·.\/\\^]/g, '')
    : ''
}

function isExpectedUnit(value: unknown): boolean {
  const key = unitKey(value)
  return key === 'ugm3' || key === 'ugm-3'
}

function looksLikeExplicitUnit(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /(?:μ|µ|u|m)g\s*(?:\/|·|\.)?\s*m/i.test(value.normalize('NFKC'))
}

function isUnitRow(row: readonly unknown[], columns: HeaderMap): boolean {
  const label = row[columns.timestamp]
  if (typeof label === 'string' && /^(?:单位|unit)s?\s*[:：]?$/i.test(label.trim())) return true
  const ionValues = IONS.map((ion) => row[columns[ion]])
  return ionValues.some((value) => isExpectedUnit(value) || looksLikeExplicitUnit(value)) && ionValues.every((value) => {
    return isBlank(value) || isExpectedUnit(value) || looksLikeExplicitUnit(value)
  })
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function validatedTimestamp(
  parts: readonly [number, number, number, number, number, number],
): { timestamp?: string; reason?: 'invalid' | 'nonhour' } {
  const [year, month, day, hour, minute, second] = parts
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (
    year < 1000 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return { reason: 'invalid' }
  }
  if (minute !== 0 || second !== 0) return { reason: 'nonhour' }
  return { timestamp: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:00:00` }
}

function parseTimestamp(value: unknown): { timestamp?: string; reason?: 'invalid' | 'nonhour' } {
  // read-excel-file represents Excel serials as UTC-based Date objects. Treating
  // their UTC fields as workbook wall-clock fields avoids host-timezone shifts.
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return validatedTimestamp([
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
    ])
  }
  if (typeof value !== 'string') return { reason: 'invalid' }
  const normalized = value
    .trim()
    .replace(/[年\/]/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, ' ')
    .replace(/时/g, ':')
    .replace(/分/g, '')
    .replace(/秒/g, '')
    .replace(/\s+/g, ' ')
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(
    normalized,
  )
  if (!match) return { reason: 'invalid' }
  return validatedTimestamp([
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  ])
}

export function parseIonMatrix(
  matrix: readonly (readonly unknown[])[],
  filename: string,
  sheetName: string,
): ParsedIonWorkbook {
  const header = findHeader(matrix)
  if (!header) {
    const missing = missingHeaders(matrix)
    const detail = missing.length > 0 ? `缺少必要表头：${missing.join('、')}` : '未找到完整表头'
    throw new Error(
      `${context(filename, sheetName)}：${detail}；仅检查前 20 行。请确认时间、NO3、SO4、NH4 表头位于前 20 行后重试`,
    )
  }
  const columns = header.columns as HeaderMap
  const dataRowCount = matrix.length - header.rowIndex - 1
  if (dataRowCount > ION_WORKBOOK_MAX_ROWS) {
    throw new Error(
      `${context(filename, sheetName)}：数据行数 ${dataRowCount} 超过上限 ${ION_WORKBOOK_MAX_ROWS}；请拆分工作表后重试`,
    )
  }

  const warnings = new WarningCollector(filename, sheetName)
  const rowsByTimestamp = new Map<string, IonRow>()
  for (let rowIndex = header.rowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const sourceRow = matrix[rowIndex] ?? []
    const rowNumber = rowIndex + 1
    if (sourceRow.every(isBlank)) continue
    if (isUnitRow(sourceRow, columns)) {
      for (const ion of IONS) {
        const unit = sourceRow[columns[ion]]
        if (!isBlank(unit) && !isExpectedUnit(unit)) {
          warnings.add(
            `${context(filename, sheetName, rowNumber)}：${ion} 的显式单位“${boundedDisplay(unit)}”不是预期的 μg/m³；未自动换算，请核对源文件`,
          )
        }
      }
      continue
    }

    const rawTimestamp = sourceRow[columns.timestamp]
    const parsedTimestamp = parseTimestamp(rawTimestamp)
    if (!parsedTimestamp.timestamp) {
      warnings.add(
        parsedTimestamp.reason === 'nonhour'
          ? `${context(filename, sheetName, rowNumber)}：时间“${boundedDisplay(rawTimestamp)}”为非整点，已跳过；请提供分钟和秒均为 00 的小时数据`
          : `${context(filename, sheetName, rowNumber)}：时间“${boundedDisplay(rawTimestamp)}”无效，已跳过；请检查日期和时间格式`,
      )
      continue
    }

    let output = rowsByTimestamp.get(parsedTimestamp.timestamp)
    if (!output) {
      output = { timestamp: parsedTimestamp.timestamp }
      rowsByTimestamp.set(parsedTimestamp.timestamp, output)
    }
    for (const ion of IONS) {
      const raw = sourceRow[columns[ion]]
      if (isBlank(raw)) continue
      const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(numeric)) {
        warnings.add(
          `${context(filename, sheetName, rowNumber)}：${ion} 数值无效“${boundedDisplay(raw)}”，按缺测处理；请核对该单元格`,
        )
        continue
      }
      if (numeric < 0) {
        warnings.add(
          `${context(filename, sheetName, rowNumber)}：${ion} 出现负值 ${numeric}，已保留供后续质控；请核对仪器和源数据`,
        )
      }
      if (output[ion] === undefined) {
        output[ion] = numeric
      } else if (output[ion] !== numeric) {
        warnings.add(
          `${context(filename, sheetName, rowNumber)}：${parsedTimestamp.timestamp} 的 ${ion} 重复且冲突；已保留首次有限值 ${output[ion]}，忽略 ${numeric}`,
        )
      }
    }
  }

  return {
    rows: [...rowsByTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    sheetName,
    warnings: warnings.warnings,
  }
}

function appendPreferredSheetWarning(
  result: ParsedIonWorkbook,
  filename: string,
  fallbackSheet: string,
): ParsedIonWorkbook {
  const warning = `${boundedDisplay(filename, 160)}：首选工作表“站点数据”表头无效，已改用“${boundedDisplay(fallbackSheet, 120)}”；请核对工作簿结构`
  const warnings = [warning, ...result.warnings]
  if (warnings.length > ION_WORKBOOK_WARNING_CAP) {
    warnings.length = ION_WORKBOOK_WARNING_CAP
    warnings[ION_WORKBOOK_WARNING_CAP - 1] =
      `${boundedDisplay(filename, 160)}：警告过多，仅显示前 ${ION_WORKBOOK_WARNING_CAP - 1} 条，其余已截断；请先检查源文件格式和数据质量`
  }
  return { ...result, warnings }
}

export function parseIonWorkbookSheets(
  sheets: readonly IonWorkbookSheetInput[],
  filename: string,
): ParsedIonWorkbook {
  const preferred = sheets.find((sheet) => sheet.sheet.trim() === '站点数据')
  if (preferred && findHeader(preferred.data) !== undefined) {
    return parseIonMatrix(preferred.data, filename, preferred.sheet)
  }
  const selected = sheets.find(
    (sheet) => sheet !== preferred && findHeader(sheet.data) !== undefined,
  )
  if (!selected) {
    const shownNames = sheets
      .slice(0, 10)
      .map((sheet) => `“${boundedDisplay(sheet.sheet, 120)}”`)
      .join('、')
    const names = shownNames
      ? `${shownNames}${sheets.length > 10 ? ` 等 ${sheets.length} 个工作表` : ''}`
      : '（无工作表）'
    throw new Error(
      `${boundedDisplay(filename, 160)}：工作簿中的工作表 ${names} 均未在前 20 行找到完整的时间、NO3、SO4、NH4 表头；请检查表头后重试`,
    )
  }
  const result = parseIonMatrix(selected.data, filename, selected.sheet)
  return preferred
    ? appendPreferredSheetWarning(result, filename, selected.sheet)
    : result
}
