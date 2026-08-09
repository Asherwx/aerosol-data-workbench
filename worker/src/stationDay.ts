import Papa, { type ParseError, type ParseStepResult } from 'papaparse'
import { formatUtcDate, parseIsoDateStrict } from '../../src/core/dates'
import {
  isPollutant,
  type HourlyStationDataRow,
  type HourlyStationRow,
  type Pollutant,
} from '../../src/core/types'
import {
  MAX_STATION_DAY_CSV_COLUMNS,
  MAX_STATION_DAY_CSV_DATA_ROWS,
  MAX_STATION_DAY_CSV_LINE_CHARS,
  MAX_UPSTREAM_CSV_BYTES,
  STATION_DAY_WARNING_LIMIT,
  STATION_ID_PATTERN,
  type StationDayResponse,
} from './protocol'

export { STATION_DAY_WARNING_LIMIT } from './protocol'

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
  initialKind: Measurement['kind']
}

const COMPACT_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/
const HOUR_PATTERN = /^(?:[01]?\d|2[0-3])$/
const RECOVERABLE_FIELD_ERRORS = new Set(['TooFewFields', 'TooManyFields'])
const WARNING_VALUE_LIMIT = 160
const DATA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

class WarningCollector {
  readonly warnings: string[] = []
  warningTotal = 0

  add(message: string): void {
    this.warningTotal += 1
    if (this.warnings.length < STATION_DAY_WARNING_LIMIT) {
      this.warnings.push(sanitizeWarning(message))
    }
  }
}

function sanitizeWarning(value: string): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
  return normalized.length <= WARNING_VALUE_LIMIT
    ? normalized
    : `${normalized.slice(0, WARNING_VALUE_LIMIT - 1)}…`
}

function parseCompactDate(value: string): string | undefined {
  const match = COMPACT_DATE_PATTERN.exec(value.trim())
  if (!match) return undefined

  const [, yearPart, monthPart, dayPart] = match
  const isoDate = `${yearPart}-${monthPart}-${dayPart}`
  try {
    return formatUtcDate(parseIsoDateStrict(isoDate))
  } catch {
    return undefined
  }
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

function assertBoundedRawCsv(csvText: string): void {
  let recordLength = 0
  let dataRows = 0
  let inHeader = true
  let inQuotes = false
  let afterClosingQuote = false
  let atFieldStart = true
  let recordHasData = false
  let headerField = ''
  let headerColumns = 0
  const seenHeaders = new Set<string>()

  const assertRecordLength = (): void => {
    if (recordLength > MAX_STATION_DAY_CSV_LINE_CHARS) {
      throw new Error('CSV 行长度（逻辑记录）超过限制，请检查上游文件格式')
    }
  }

  const finishHeaderField = (): void => {
    const headerName = headerField.trim()
    if (!headerName) throw new Error('CSV 表头包含空列名，请检查上游文件格式')
    if (seenHeaders.has(headerName)) {
      throw new Error(`CSV 表头包含重复列名：${headerName}`)
    }
    headerColumns += 1
    if (headerColumns > MAX_STATION_DAY_CSV_COLUMNS) {
      throw new Error('CSV 表头列数超过限制，请检查上游文件格式')
    }
    seenHeaders.add(headerName)
    headerField = ''
  }

  const finishRecord = (): void => {
    if (inHeader) {
      finishHeaderField()
      inHeader = false
    } else if (recordHasData) {
      dataRows += 1
      if (dataRows > MAX_STATION_DAY_CSV_DATA_ROWS) {
        throw new Error('CSV 数据行数超过限制，请缩小单次请求范围')
      }
    }
    recordLength = 0
    recordHasData = false
    atFieldStart = true
    afterClosingQuote = false
  }

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index]

    if (inQuotes) {
      recordHasData = true
      recordLength += 1
      assertRecordLength()
      if (character === '"') {
        if (csvText[index + 1] === '"') {
          recordLength += 1
          assertRecordLength()
          if (inHeader) headerField += '"'
          index += 1
          continue
        }
        inQuotes = false
        afterClosingQuote = true
        continue
      }
      if (inHeader) headerField += character
      continue
    }

    if (character === '\r' || character === '\n') {
      if (character === '\r' && csvText[index + 1] === '\n') index += 1
      finishRecord()
      continue
    }

    recordHasData = true
    recordLength += 1
    assertRecordLength()

    if (character === ',') {
      if (inHeader) finishHeaderField()
      atFieldStart = true
      afterClosingQuote = false
      continue
    }

    if (character === '"') {
      if (!atFieldStart) {
        throw new Error('CSV 引号格式无效，请检查上游文件格式')
      }
      inQuotes = true
      continue
    }

    if (afterClosingQuote) {
      throw new Error('CSV 引号格式无效，请检查上游文件格式')
    }

    atFieldStart = false
    if (inHeader) headerField += character
  }

  if (inQuotes) {
    throw new Error('CSV 引号未闭合，请检查上游文件格式')
  }
  if (inHeader || recordHasData) {
    finishRecord()
  }
}

function assertCsvStructure(csvText: string, stationId: string): void {
  const probe = Papa.parse<CsvRecord>(csvText, {
    header: true,
    skipEmptyLines: true,
    preview: 1,
  })
  const fatalErrors = probe.errors.filter((error) => !isRecoverableFieldError(error))
  if (fatalErrors.length > 0) throw new Error('CSV 解析失败')
  if (Object.keys(probe.meta.renamedHeaders ?? {}).length > 0) {
    throw new Error('CSV 表头包含重复列名，请检查上游文件格式')
  }

  const fields = probe.meta.fields ?? []
  for (const field of ['date', 'hour', 'type', stationId]) {
    if (!fields.includes(field)) throw new Error(`CSV 缺少必要列：${field}`)
  }
}

/** Extracts one station's requested UTC calendar day without network or Worker APIs. */
export function extractStationDay(
  text: string,
  isoDate: string,
  stationId: string,
): StationDayResponse {
  if (!STATION_ID_PATTERN.test(stationId)) {
    throw new Error('站点编号格式无效')
  }
  if (new TextEncoder().encode(text).byteLength > MAX_UPSTREAM_CSV_BYTES) {
    throw new Error('上游 CSV 文件大小超过限制')
  }

  const requestedDate = formatUtcDate(parseIsoDateStrict(isoDate))
  const sourceFilename = `china_sites_${requestedDate.replaceAll('-', '')}.csv`
  const csvText = text.replace(/^\uFEFF/, '')
  assertBoundedRawCsv(csvText)
  assertCsvStructure(csvText, stationId)

  const rowsByTimestamp = new Map<string, HourlyStationRow>()
  const allRowsByTimestamp = new Map<string, HourlyStationDataRow>()
  const seenMeasurements = new Map<string, SeenMeasurement>()
  const warnings = new WarningCollector()

  Papa.parse<CsvRecord>(csvText, {
    header: true,
    skipEmptyLines: true,
    step: (result: ParseStepResult<CsvRecord>) => {
      if (result.errors.some((error) => !isRecoverableFieldError(error))) {
        throw new Error('CSV 解析失败')
      }
      if (result.errors.length > 0) {
        warnings.add('CSV 行字段数量不匹配，已跳过')
        return
      }

      const record = result.data
      const rawDate = typeof record.date === 'string' ? record.date.trim() : ''
      const rowDate = parseCompactDate(rawDate)
      if (rowDate !== requestedDate) {
        warnings.add(`行日期与请求日期不一致：${rawDate}`)
        return
      }

      const type = typeof record.type === 'string' ? record.type.trim() : ''
      if (!DATA_TYPE_PATTERN.test(type)) {
        warnings.add(`数据类型无效，已跳过：${type}`)
        return
      }

      const rawHour = typeof record.hour === 'string' ? record.hour.trim() : ''
      const hour = parseHour(rawHour)
      if (!hour) {
        warnings.add(`小时无效：${rawHour}`)
        return
      }

      const timestamp = `${requestedDate} ${hour}:00:00`
      const measurementKey = `${timestamp}\u0000${type}`
      const measurement = parseMeasurement(record[stationId])
      if (measurement.kind === 'invalid') {
        warnings.add(`测量值无效：${measurement.value}`)
      }

      let row = rowsByTimestamp.get(timestamp)
      if (!row) {
        row = { timestamp }
        rowsByTimestamp.set(timestamp, row)
      }
      let allRow = allRowsByTimestamp.get(timestamp)
      if (!allRow) {
        allRow = { timestamp, values: {} }
        allRowsByTimestamp.set(timestamp, allRow)
      }

      const pollutant: Pollutant | undefined = isPollutant(type) ? type : undefined

      const seen = seenMeasurements.get(measurementKey)
      if (!seen) {
        seenMeasurements.set(measurementKey, {
          hasFinite: measurement.kind === 'finite',
          initialKind: measurement.kind,
        })
        if (measurement.kind === 'finite') {
          allRow.values[type] = measurement.value
          if (pollutant) row[pollutant] = measurement.value
        }
        return
      }

      if (!seen.hasFinite && measurement.kind === 'finite') {
        allRow.values[type] = measurement.value
        if (pollutant) row[pollutant] = measurement.value
        seen.hasFinite = true
        warnings.add(`重复测量值已替换先前${seen.initialKind === 'missing' ? '缺失' : '无效'}值`)
        return
      }

      warnings.add(seen.hasFinite ? '重复测量值已忽略，保留首次有效值' : '重复测量值已忽略')
    },
  })

  return {
    date: requestedDate,
    stationId,
    sourceFilename,
    rows: [...rowsByTimestamp.values()].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    ),
    allRows: [...allRowsByTimestamp.values()]
      .map((row) => ({ timestamp: row.timestamp, values: { ...row.values } }))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    warnings: warnings.warnings,
    warningTotal: warnings.warningTotal,
  }
}
