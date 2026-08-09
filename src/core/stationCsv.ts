import Papa, { type ParseError, type ParseStepResult } from 'papaparse'
import { assertCanonicalStationId, POLLUTANTS, type HourlyStationRow, type Pollutant } from './types'

type CsvRecord = Record<string, string | string[] | undefined> & {
  date?: string
  hour?: string
  type?: string
}

type Measurement =
  | { kind: 'missing' }
  | { kind: 'invalid'; value: string }
  | { kind: 'finite'; value: number }

type SeenMeasurement = {
  hasFinite: boolean
  initialKind: 'missing' | 'invalid' | 'finite'
}

export interface ParsedStationFile {
  filename: string
  rows: HourlyStationRow[]
  warnings: string[]
}

export const STATION_CSV_WARNING_CAP = 100

const POLLUTANT_SET: ReadonlySet<string> = new Set(POLLUTANTS)
const COMPACT_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/
const HOUR_PATTERN = /^(?:[01]?\d|2[0-3])$/
const STATION_FILENAME_PATTERN = /^china_sites_(\d{8})\.csv$/i
const RECOVERABLE_FIELD_ERRORS = new Set(['TooFewFields', 'TooManyFields'])

class WarningCollector {
  readonly warnings: string[] = []
  private count = 0

  constructor(private readonly filename: string) {}

  add(message: string): void {
    this.count += 1

    if (this.count <= STATION_CSV_WARNING_CAP) {
      this.warnings.push(message)
      return
    }

    if (this.count === STATION_CSV_WARNING_CAP + 1) {
      this.warnings[STATION_CSV_WARNING_CAP - 1] =
        `${this.filename}：警告过多，仅显示前 ${STATION_CSV_WARNING_CAP - 1} 条，其余已截断`
    }
  }
}

function parseDate(value: string): string | undefined {
  const match = COMPACT_DATE_PATTERN.exec(value.trim())
  if (!match) return undefined

  const [, yearPart, monthPart, dayPart] = match
  const year = Number(yearPart)
  const month = Number(monthPart)
  const day = Number(dayPart)
  const date = new Date(Date.UTC(year, month - 1, day))

  if (
    year < 1000 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined
  }

  return `${yearPart}-${monthPart}-${dayPart}`
}

function parseHour(value: string): string | undefined {
  const trimmed = value.trim()
  return HOUR_PATTERN.test(trimmed) ? trimmed.padStart(2, '0') : undefined
}

function parseMeasurement(value: string | string[] | undefined): Measurement {
  if (value === undefined || Array.isArray(value) || value.trim() === '') {
    return { kind: 'missing' }
  }

  const trimmed = value.trim()
  const measurement = Number(trimmed)
  return Number.isFinite(measurement)
    ? { kind: 'finite', value: measurement }
    : { kind: 'invalid', value: trimmed }
}

function isRecoverableFieldError(error: ParseError): boolean {
  return error.type === 'FieldMismatch' && RECOVERABLE_FIELD_ERRORS.has(error.code)
}

function blockingCsvError(
  filename: string,
  diagnostics: Array<{ error: ParseError; csvRow?: number }> | string[],
): Error {
  const details = diagnostics.map((diagnostic) => {
    if (typeof diagnostic === 'string') return diagnostic
    const row = diagnostic.csvRow === undefined ? '' : `（第${diagnostic.csvRow}行）`
    return `${diagnostic.error.code}${row}：${diagnostic.error.message}`
  })

  return new Error(
    `CSV解析失败：${filename}：${details.join('；')}；影响：无法可靠读取文件；操作：请检查文件表头、分隔符、引号和字段数量后重试`,
  )
}

function fieldMismatchWarning(filename: string, csvRow: number, error: ParseError): string {
  const counts = /expected (\d+) fields but parsed (\d+)/i.exec(error.message)
  const expected = counts?.[1] ?? '?'
  const actual = counts?.[2] ?? '?'
  const mismatch = error.code === 'TooFewFields' ? '字段数不足' : '字段数过多'
  return `${filename}：第${csvRow}行${mismatch}（应为 ${expected}，实际为 ${actual}）；已跳过该行`
}

function expectedDateFromFilename(filename: string): string | undefined {
  return STATION_FILENAME_PATTERN.exec(filename)?.[1]
}

export function parseStationCsvText(
  text: string,
  filename: string,
  station: string,
): ParsedStationFile {
  const selectedStation = station.trim()
  if (!selectedStation) throw new Error('站点编号不能为空')

  assertCanonicalStationId(selectedStation)
  const csvText = text.replace(/^\uFEFF/, '')
  const headerProbe = Papa.parse<CsvRecord>(csvText, {
    header: true,
    skipEmptyLines: true,
    preview: 1,
  })
  const blockingProbeErrors = headerProbe.errors.filter(
    (error) => !isRecoverableFieldError(error),
  )
  if (blockingProbeErrors.length > 0) {
    throw blockingCsvError(
      filename,
      blockingProbeErrors.map((error) => ({
        error,
        csvRow: error.row === undefined ? undefined : error.row + 2,
      })),
    )
  }

  const fields = headerProbe.meta.fields ?? []
  for (const field of ['date', 'hour', 'type']) {
    if (!fields.includes(field)) {
      throw blockingCsvError(filename, [`必要列不存在：${field}`])
    }
  }
  if (!fields.includes(selectedStation)) {
    throw blockingCsvError(filename, [`站点列不存在：${selectedStation}`])
  }

  const expectedDate = expectedDateFromFilename(filename)
  const rowsByTimestamp = new Map<string, HourlyStationRow>()
  const seenMeasurements = new Map<string, SeenMeasurement>()
  const warningCollector = new WarningCollector(filename)
  const blockingErrors: Array<{ error: ParseError; csvRow: number }> = []
  let dataRowIndex = 0

  Papa.parse<CsvRecord>(csvText, {
    header: true,
    skipEmptyLines: true,
    step: (result: ParseStepResult<CsvRecord>) => {
      const csvRow = dataRowIndex + 2
      dataRowIndex += 1

      const recoverableErrors = result.errors.filter(isRecoverableFieldError)
      for (const error of recoverableErrors) {
        warningCollector.add(fieldMismatchWarning(filename, csvRow, error))
      }
      if (recoverableErrors.length > 0) return

      const fatalErrors = result.errors.filter((error) => !isRecoverableFieldError(error))
      for (const error of fatalErrors) blockingErrors.push({ error, csvRow })
      if (fatalErrors.length > 0) return

      const record = result.data
      const dateValue = record.date
      const rawDate = typeof dateValue === 'string' ? dateValue.trim() : ''
      if (expectedDate && rawDate !== expectedDate) {
        warningCollector.add(
          `${filename}：第${csvRow}行日期与文件名不一致；预期 ${expectedDate}，实际 ${rawDate}；已跳过该行`,
        )
        return
      }

      const typeValue = record.type
      const type = typeof typeValue === 'string' ? typeValue.trim() : ''
      if (!POLLUTANT_SET.has(type)) return

      const date = parseDate(rawDate)
      if (!date) {
        warningCollector.add(`${filename}：第${csvRow}行日期无效：${rawDate}`)
        return
      }

      const hourValue = record.hour
      const rawHour = typeof hourValue === 'string' ? hourValue.trim() : ''
      const hour = parseHour(rawHour)
      if (!hour) {
        warningCollector.add(`${filename}：第${csvRow}行小时无效：${rawHour}`)
        return
      }

      const pollutant = type as Pollutant
      const timestamp = `${date} ${hour}:00:00`
      const measurementKey = `${timestamp}\u0000${pollutant}`
      const measurement = parseMeasurement(record[selectedStation])

      if (measurement.kind === 'invalid') {
        warningCollector.add(
          `${filename}：第${csvRow}行站点 ${selectedStation} 在 ${timestamp} 的 ${pollutant} 数值无效：${measurement.value}；按缺测处理`,
        )
      }

      let row = rowsByTimestamp.get(timestamp)
      if (!row) {
        row = { timestamp }
        rowsByTimestamp.set(timestamp, row)
      }

      const seen = seenMeasurements.get(measurementKey)
      if (!seen) {
        seenMeasurements.set(measurementKey, {
          hasFinite: measurement.kind === 'finite',
          initialKind: measurement.kind,
        })
        if (measurement.kind === 'finite') row[pollutant] = measurement.value
        return
      }

      if (!seen.hasFinite && measurement.kind === 'finite') {
        row[pollutant] = measurement.value
        seen.hasFinite = true
        const priorState = seen.initialKind === 'missing' ? '先前缺失' : '先前无效'
        warningCollector.add(
          `${filename}：第${csvRow}行 ${timestamp} 的 ${pollutant} 重复；已替换${priorState}值`,
        )
        return
      }

      warningCollector.add(
        seen.hasFinite
          ? `${filename}：第${csvRow}行 ${timestamp} 的 ${pollutant} 重复；已忽略，保留首次有效值`
          : `${filename}：第${csvRow}行 ${timestamp} 的 ${pollutant} 重复；已忽略，仍无有效值`,
      )
    },
  })

  if (blockingErrors.length > 0) throw blockingCsvError(filename, blockingErrors)

  return {
    filename,
    rows: [...rowsByTimestamp.values()].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    ),
    warnings: warningCollector.warnings,
  }
}
