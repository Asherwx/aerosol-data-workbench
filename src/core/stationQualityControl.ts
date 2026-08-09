import type { StationSeriesRow } from './stationSeries'
import type { Pollutant } from './types'

export const STATION_QC_VARIABLES = [
  { key: 'SO2', displayName: 'SO2 (\u03bcg/m\u00b3)' },
  { key: 'NO2', displayName: 'NO2 (\u03bcg/m\u00b3)' },
  { key: 'O3', displayName: 'O3 (\u03bcg/m\u00b3)' },
  { key: 'CO', displayName: 'CO (mg/m\u00b3)' },
  { key: 'PM10', displayName: 'PM10 (\u03bcg/m\u00b3)' },
  { key: 'PM2.5', displayName: 'PM2.5 (\u03bcg/m\u00b3)' },
] as const

export type StationQcVariable = (typeof STATION_QC_VARIABLES)[number]['key']
export type QcFlagCode =
  | 'missing'
  | 'nonfinite'
  | 'negative'
  | 'all-station-zero'
  | 'station-missing-omitted'
  | 'station-finite-declared-missing'
  | 'station-status-mismatch'

export interface StructuredQcFlag {
  code: QcFlagCode
  variable?: StationQcVariable
  message: string
}

type StationQcSource = Pick<StationSeriesRow, 'missing' | 'status'> & Partial<Record<StationQcVariable, number>>

const COMPLETE_STATUSES = new Set(['\u5b8c\u6574'])
const CANONICAL_HOUR_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):00:00$/
const HOUR_MS = 60 * 60 * 1000
export const MAX_STATION_QC_ROWS = 8784
const GAP_SAMPLE_LIMIT = 20

function parseCanonicalHour(timestamp: string): number {
  const match = CANONICAL_HOUR_PATTERN.exec(timestamp)
  if (!match) throw new Error(`Invalid station timestamp ${timestamp}; expected YYYY-MM-DD HH:00:00`)
  const [, yearText, monthText, dayText, hourText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const time = Date.UTC(year, month - 1, day, hour)
  const date = new Date(time)
  if (year < 1000 || hour > 23 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid station timestamp ${timestamp}; expected YYYY-MM-DD HH:00:00`)
  }
  return time
}

function formatCanonicalHour(time: number): string {
  const date = new Date(time)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:00:00`
}

export function collectStationMeasurementFlags(source: StationQcSource): StructuredQcFlag[] {
  const flags: StructuredQcFlag[] = []
  for (const variable of STATION_QC_VARIABLES) {
    const value = source[variable.key]
    if (value === undefined) flags.push({ code: 'missing', variable: variable.key, message: `\u7f3a\u5931\uff1a${variable.displayName}` })
    else if (!Number.isFinite(value)) flags.push({ code: 'nonfinite', variable: variable.key, message: `\u975e\u6709\u9650\u503c\uff1a${variable.displayName}` })
    else if (value < 0) flags.push({ code: 'negative', variable: variable.key, message: `\u8d1f\u503c\uff1a${variable.displayName}` })
  }
  return flags
}

export function collectStationConsistencyFlags(source: StationQcSource): StructuredQcFlag[] {
  const flags: StructuredQcFlag[] = []
  if (STATION_QC_VARIABLES.every((variable) => source[variable.key] === 0)) {
    flags.push({ code: 'all-station-zero', message: '\u516d\u9879\u6c61\u67d3\u7269\u540c\u65f6\u4e3a0' })
  }
  const declaredMissing = new Set<Pollutant>(source.missing)
  for (const variable of STATION_QC_VARIABLES) {
    const actualMissing = !Number.isFinite(source[variable.key])
    const isDeclaredMissing = declaredMissing.has(variable.key)
    if (actualMissing && !isDeclaredMissing) flags.push({ code: 'station-missing-omitted', variable: variable.key, message: `\u7ad9\u70b9\u7f3a\u6d4b\u6807\u8bb0\u9057\u6f0f\uff1a${variable.displayName}` })
    else if (!actualMissing && isDeclaredMissing) flags.push({ code: 'station-finite-declared-missing', variable: variable.key, message: `\u7ad9\u70b9\u6709\u9650\u503c\u88ab\u6807\u4e3a\u7f3a\u6d4b\uff1a${variable.displayName}` })
  }
  const hasStationMissing = STATION_QC_VARIABLES.some((variable) => !Number.isFinite(source[variable.key]))
  if (hasStationMissing ? source.status !== '\u5b58\u5728\u7f3a\u6d4b' : !COMPLETE_STATUSES.has(source.status)) {
    flags.push({ code: 'station-status-mismatch', message: '\u7ad9\u70b9\u72b6\u6001\u4e0e\u7f3a\u6d4b\u5b57\u6bb5\u4e0d\u4e00\u81f4' })
  }
  return flags
}

export function collectStationQcFlags(source: StationQcSource): StructuredQcFlag[] {
  return [...collectStationMeasurementFlags(source), ...collectStationConsistencyFlags(source)]
}

export type StationCheckedRow = StationSeriesRow & { QC_flag: string; QC_flags: StructuredQcFlag[]; QC_keep: boolean }
export interface StationQualityControlResult {
  rows: StationCheckedRow[]
  counts: Record<string, number>
  keptRows: StationCheckedRow[]
  rejectedRows: StationCheckedRow[]
  gaps: string[]
  gapCount: number
  warnings: string[]
}

function clone(row: StationCheckedRow): StationCheckedRow {
  return { ...row, missing: [...row.missing], QC_flags: row.QC_flags.map((flag) => ({ ...flag })) }
}

export function qualityControlStation(input: readonly StationSeriesRow[]): StationQualityControlResult {
  if (input.length > MAX_STATION_QC_ROWS) throw new Error(`Station quality control row count exceeds safe limit ${MAX_STATION_QC_ROWS}`)
  const times = new Set<number>()
  let min = Infinity
  let max = -Infinity
  for (const row of input) {
    const time = parseCanonicalHour(row.timestamp)
    if (times.has(time)) throw new Error(`Duplicate station timestamp: ${row.timestamp}`)
    times.add(time); min = Math.min(min, time); max = Math.max(max, time)
  }
  if (input.length > 0 && ((max - min) / HOUR_MS + 1) > MAX_STATION_QC_ROWS) throw new Error(`Station time range exceeds safe limit ${MAX_STATION_QC_ROWS}`)
  const gaps: string[] = []
  if (input.length > 0) for (let time = min; time <= max; time += HOUR_MS) if (!times.has(time)) gaps.push(formatCanonicalHour(time))
  const counts: Record<string, number> = { '\u6b63\u5e38': 0 }
  const rows = input.map((source) => {
    const flags = collectStationQcFlags(source)
    const QC_flag = flags.length === 0 ? '\u6b63\u5e38' : flags.map((flag) => flag.message).join('\uff1b')
    if (flags.length === 0) counts['\u6b63\u5e38'] += 1
    else for (const flag of flags) counts[flag.message] = (counts[flag.message] ?? 0) + 1
    return { ...source, missing: [...source.missing], QC_flag, QC_flags: flags.map((flag) => ({ ...flag })), QC_keep: flags.length === 0 }
  })
  const warnings = gaps.length === 0 ? [] : [`Station series has ${gaps.length} absent hour(s): ${gaps.slice(0, GAP_SAMPLE_LIMIT).join(', ')}${gaps.length > GAP_SAMPLE_LIMIT ? ', ...' : ''}`]
  return { rows, counts, keptRows: rows.filter((row) => row.QC_keep).map(clone), rejectedRows: rows.filter((row) => !row.QC_keep).map(clone), gaps, gapCount: gaps.length, warnings }
}
