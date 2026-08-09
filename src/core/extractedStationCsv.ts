import Papa from 'papaparse'

import { parseIsoDateStrict } from './dates'
import {
  assertCanonicalStationId,
  POLLUTANTS,
  type HourlyStationDataRow,
  type HourlyStationRow,
  type Pollutant,
} from './types'

export const EXTRACTED_STATION_CSV_WARNING_CAP = 100

const UTF8_BOM = '\uFEFF'
const HEADERS = [
  'station_id',
  'timestamp',
  'SO2(μg/m³)',
  'NO2(μg/m³)',
  'O3(μg/m³)',
  'CO(mg/m³)',
  'PM10(μg/m³)',
  'PM2.5(μg/m³)',
] as const
const POLLUTANT_HEADERS: Record<Pollutant, string> = {
  SO2: 'SO2(μg/m³)',
  NO2: 'NO2(μg/m³)',
  O3: 'O3(μg/m³)',
  CO: 'CO(mg/m³)',
  PM10: 'PM10(μg/m³)',
  'PM2.5': 'PM2.5(μg/m³)',
}
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):00:00$/

export interface ExtractedStationCsvInput {
  stationId: string
  rows: readonly HourlyStationRow[]
  allRows?: readonly HourlyStationDataRow[]
}

const DATA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface ParsedExtractedStationCsv {
  stationId: string
  rows: HourlyStationRow[]
  warnings: string[]
  warningTotal: number
}

function assertTimestamp(value: string): void {
  const match = TIMESTAMP_PATTERN.exec(value)
  if (!match) throw new Error(`invalid station timestamp: ${value}`)
  parseIsoDateStrict(match[1])
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
  const position = integer.length + exponent
  const result = position <= 0
    ? `0.${'0'.repeat(-position)}${digits}`
    : position >= digits.length
      ? `${digits}${'0'.repeat(position - digits.length)}`
      : `${digits.slice(0, position)}.${digits.slice(position)}`
  return negative ? `-${result}` : result
}

function safeMetadata(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value
}

function unsafeMetadata(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value
}

class Warnings {
  readonly warnings: string[] = []
  total = 0

  add(message: string): void {
    this.total += 1
    if (this.warnings.length < EXTRACTED_STATION_CSV_WARNING_CAP) this.warnings.push(message)
    if (this.total === EXTRACTED_STATION_CSV_WARNING_CAP + 1) {
      this.warnings[EXTRACTED_STATION_CSV_WARNING_CAP - 1] =
        `Warnings truncated after ${EXTRACTED_STATION_CSV_WARNING_CAP - 1} entries.`
    }
  }
}

export function serializeExtractedStationCsv(input: ExtractedStationCsvInput): string {
  const stationId = assertCanonicalStationId(input.stationId)
  const rows = input.rows.map((row) => ({ ...row })).sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const allRowsByTime = new Map(
    (input.allRows ?? []).map((row) => [row.timestamp, { ...row.values }]),
  )
  const extraTypes = [...new Set(
    [...allRowsByTime.values()].flatMap((values) => Object.keys(values)),
  )]
    .filter((type) => !POLLUTANTS.includes(type as Pollutant))
    .map((type) => {
      if (!DATA_TYPE_PATTERN.test(type)) throw new Error(`invalid station data type: ${type}`)
      return type
    })
  if (extraTypes.length > 64) throw new Error('station data types exceed the 64-column safety limit')
  const output = rows.map((row) => {
    assertTimestamp(row.timestamp)
    const cells = [safeMetadata(stationId), row.timestamp]
    for (const pollutant of POLLUTANTS) cells.push(plainNumber(row[pollutant] ?? Number.NaN))
    const allValues = allRowsByTime.get(row.timestamp) ?? {}
    for (const type of extraTypes) cells.push(plainNumber(allValues[type] ?? Number.NaN))
    return cells
  })
  return `${UTF8_BOM}${Papa.unparse({ fields: [...HEADERS, ...extraTypes], data: output }, { newline: '\r\n' })}\r\n`
}

export function parseExtractedStationCsv(text: string): ParsedExtractedStationCsv {
  if (text.length > 5 * 1024 * 1024) throw new Error('station CSV exceeds the 5 MiB safety limit')
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: true,
  })
  if (parsed.errors.length > 0) throw new Error('station CSV is malformed')
  const fields = parsed.meta.fields ?? []
  const fixedPrefix = fields.slice(0, HEADERS.length)
  const extras = fields.slice(HEADERS.length)
  if (fixedPrefix.join('\u0000') !== HEADERS.join('\u0000')
    || new Set(fields).size !== fields.length
    || extras.some((field) => !DATA_TYPE_PATTERN.test(field))) {
    throw new Error('station CSV header does not match the fixed station-wide schema')
  }
  const warnings = new Warnings()
  let stationId: string | undefined
  const rowsByTime = new Map<string, HourlyStationRow>()
  for (const [index, record] of parsed.data.entries()) {
    const rowStationId = assertCanonicalStationId(unsafeMetadata(String(record.station_id ?? '')))
    if (stationId === undefined) stationId = rowStationId
    if (stationId !== rowStationId) throw new Error('station CSV contains more than one station ID')
    const timestamp = String(record.timestamp ?? '').trim()
    assertTimestamp(timestamp)
    let row = rowsByTime.get(timestamp)
    if (!row) {
      row = { timestamp }
      rowsByTime.set(timestamp, row)
    }
    for (const pollutant of POLLUTANTS) {
      const raw = String(record[POLLUTANT_HEADERS[pollutant]] ?? '').trim()
      if (!raw) continue
      const value = Number(raw)
      if (!Number.isFinite(value)) {
        warnings.add(`Row ${index + 2}: ${pollutant} is not a finite number and was ignored.`)
        continue
      }
      if (Number.isFinite(row[pollutant])) {
        warnings.add(`Row ${index + 2}: duplicate ${timestamp} ${pollutant}; kept the first finite value.`)
      } else {
        row[pollutant] = value
      }
    }
  }
  if (!stationId) throw new Error('station CSV has no data rows')
  return {
    stationId,
    rows: [...rowsByTime.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    warnings: warnings.warnings,
    warningTotal: warnings.total,
  }
}
