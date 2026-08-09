import type { IonRow } from './ionMatrix'
import type { StationSeriesRow } from './stationSeries'
import { boundedDisplay } from './display'
import type { ParsedUserDataset, UserVariableSpec } from './userDataset'

export type MergedRow = StationSeriesRow & Omit<IonRow, 'timestamp'>

export interface HourlyMergeResult {
  rows: MergedRow[]
  warnings: string[]
  unmatchedIonTimestamps: string[]
}

export type UserMergedRow = StationSeriesRow & {
  userValues: Record<string, number | undefined>
}

export interface UserHourlyMergeResult {
  rows: UserMergedRow[]
  variables: UserVariableSpec[]
  warnings: string[]
  warningTotal: number
  unmatchedUserTimestamps: string[]
  unmatchedUserTimestampCount: number
}

export const MAX_MERGE_HOURS = 366 * 24
export const MAX_MERGE_ROWS = MAX_MERGE_HOURS
export const MERGE_WARNING_LIMIT = 100
export const UNMATCHED_TIMESTAMP_SAMPLE_LIMIT = 10

const IONS = ['NO3', 'SO4', 'NH4'] as const
const CANONICAL_HOUR_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):00:00$/
const HOUR_MS = 60 * 60 * 1000
const SAFE_USER_KEY = /^[a-z][a-z0-9_]{0,63}$/
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isValidCanonicalHour(timestamp: string): boolean {
  const match = CANONICAL_HOUR_PATTERN.exec(timestamp)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const date = new Date(Date.UTC(year, month - 1, day, hour))
  return year >= 1000 && hour <= 23
    && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
}

function canonicalHourTime(timestamp: string): number {
  if (!isValidCanonicalHour(timestamp)) throw new Error(`Invalid canonical hourly timestamp: ${boundedDisplay(timestamp)}`)
  return Date.parse(`${timestamp.replace(' ', 'T')}Z`)
}

function assertBoundedTimeline(times: readonly number[], source: string): void {
  if (times.length < 2) return
  const min = Math.min(...times)
  const max = Math.max(...times)
  if ((max - min) / HOUR_MS + 1 > MAX_MERGE_ROWS) {
    throw new Error(`${source} time range exceeds safe limit ${MAX_MERGE_ROWS}`)
  }
}

function safeVariable(variable: UserVariableSpec): UserVariableSpec | undefined {
  if (!SAFE_USER_KEY.test(variable.key) || PROTOTYPE_KEYS.has(variable.key)) return undefined
  return {
    key: variable.key,
    label: boundedDisplay(variable.label, 120),
    unit: boundedDisplay(variable.unit, 48),
    nonNegative: variable.nonNegative === true,
    sourceColumn: variable.sourceColumn,
  }
}

function ionDisplayName(ion: (typeof IONS)[number]): string {
  return `${ion} (μg/m³)`
}

function shownValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  if (Object.is(value, -0)) return '-0'
  return String(value)
}

class MergeWarningCollector {
  private readonly shown: string[] = []
  private total = 0

  add(warning: string): void {
    this.total += 1
    if (this.shown.length < MERGE_WARNING_LIMIT - 1) this.shown.push(warning)
  }

  finish(): string[] {
    if (this.total < MERGE_WARNING_LIMIT) return [...this.shown]
    const shownCount = MERGE_WARNING_LIMIT - 1
    return [
      ...this.shown,
      `合并警告共 ${this.total} 条，仅显示前 ${shownCount} 条；已省略 ${this.total - shownCount} 条`,
    ]
  }

  count(): number {
    return this.total
  }
}

export function mergeHourly(
  stationRows: readonly StationSeriesRow[],
  ionRows: readonly IonRow[],
): HourlyMergeResult {
  if (stationRows.length > MAX_MERGE_ROWS) {
    throw new Error(
      `站点小时数据行数 ${stationRows.length} 超过安全上限 ${MAX_MERGE_ROWS}；请缩小日期范围后重试`,
    )
  }
  if (ionRows.length > MAX_MERGE_ROWS) {
    throw new Error(
      `离子小时数据行数 ${ionRows.length} 超过安全上限 ${MAX_MERGE_ROWS}；请缩小日期范围或拆分文件后重试`,
    )
  }

  const stationTimestamps = new Set<string>()
  for (const row of stationRows) {
    if (!isValidCanonicalHour(row.timestamp)) {
      throw new Error(
        `站点小时数据时间无效：${row.timestamp}；应为 YYYY-MM-DD HH:00:00 的有效整点`,
      )
    }
    stationTimestamps.add(row.timestamp)
  }

  const warnings = new MergeWarningCollector()
  const ionsByTimestamp = new Map<string, IonRow>()
  for (const input of ionRows) {
    if (!isValidCanonicalHour(input.timestamp)) {
      warnings.add(
        `离子小时数据时间无效：${input.timestamp}；已跳过，请改为 YYYY-MM-DD HH:00:00 的有效整点`,
      )
      continue
    }
    let combined = ionsByTimestamp.get(input.timestamp)
    if (!combined) {
      combined = { timestamp: input.timestamp }
      ionsByTimestamp.set(input.timestamp, combined)
    }

    for (const ion of IONS) {
      if (!Object.prototype.hasOwnProperty.call(input, ion)) continue
      const next = input[ion]
      if (next === undefined) continue
      const current = combined[ion]
      const currentIsSupplied = Object.prototype.hasOwnProperty.call(combined, ion)
        && current !== undefined
      if (!currentIsSupplied) {
        combined[ion] = next
        continue
      }

      if (Object.is(current, next)) continue
      const currentValue = current as number
      const currentIsFinite = Number.isFinite(currentValue)
      const nextIsFinite = Number.isFinite(next)
      let resolution: string
      if (currentIsFinite && nextIsFinite) {
        resolution = `保留首个有限值 ${shownValue(currentValue)}，忽略 ${shownValue(next)}`
      } else if (!currentIsFinite && nextIsFinite) {
        resolution = `有限值优先，采用 ${shownValue(next)}，忽略 ${shownValue(currentValue)}`
        combined[ion] = next
      } else if (currentIsFinite) {
        resolution = `有限值优先，保留 ${shownValue(currentValue)}，忽略 ${shownValue(next)}`
      } else {
        resolution = `均为非有限值，保留首次值 ${shownValue(currentValue)}，忽略 ${shownValue(next)}`
      }
      warnings.add(
        `离子时间 ${input.timestamp} 的 ${ionDisplayName(ion)} 重复且冲突；${resolution}`,
      )
    }
  }

  const unmatchedIonTimestamps = [...ionsByTimestamp.keys()].filter(
    (timestamp) => !stationTimestamps.has(timestamp),
  )
  if (unmatchedIonTimestamps.length > 0) {
    const sample = unmatchedIonTimestamps.slice(0, UNMATCHED_TIMESTAMP_SAMPLE_LIMIT)
    const sampleSuffix = unmatchedIonTimestamps.length > sample.length
      ? `（仅显示前 ${sample.length} 个时间）`
      : ''
    warnings.add(
      `有 ${unmatchedIonTimestamps.length} 个离子小时未匹配站点时间线，未加入合并结果：${sample.join('、')}${sampleSuffix}`,
    )
  }

  const rows = stationRows.map((stationRow): MergedRow => {
    const merged: MergedRow = {
      ...stationRow,
      missing: [...stationRow.missing],
    }
    const ionRow = ionsByTimestamp.get(stationRow.timestamp)
    if (ionRow) {
      for (const ion of IONS) {
        const value = ionRow[ion]
        if (value !== undefined) merged[ion] = value
      }
    }
    return merged
  })

  return { rows, warnings: warnings.finish(), unmatchedIonTimestamps }
}

export function mergeUserHourly(
  stationRows: readonly StationSeriesRow[],
  parsedUserDataset: ParsedUserDataset,
): UserHourlyMergeResult {
  if (stationRows.length > MAX_MERGE_ROWS) throw new Error(`Station hourly row count exceeds safe limit ${MAX_MERGE_ROWS}`)
  if (parsedUserDataset.rows.length > MAX_MERGE_ROWS) throw new Error(`User hourly row count exceeds safe limit ${MAX_MERGE_ROWS}`)

  const stationTimes: number[] = []
  const stationTimestamps = new Set<string>()
  for (const row of stationRows) {
    const time = canonicalHourTime(row.timestamp)
    if (stationTimestamps.has(row.timestamp)) throw new Error(`Duplicate station timestamp: ${row.timestamp}`)
    stationTimestamps.add(row.timestamp)
    stationTimes.push(time)
  }
  assertBoundedTimeline(stationTimes, 'Station')

  const variables: UserVariableSpec[] = []
  const variableByKey = new Map<string, UserVariableSpec>()
  for (const candidate of parsedUserDataset.variables) {
    const variable = safeVariable(candidate)
    if (!variable || variableByKey.has(variable.key)) continue
    variableByKey.set(variable.key, variable)
    variables.push(variable)
  }

  const warnings = new MergeWarningCollector()
  const userByTimestamp = new Map<string, Record<string, number | undefined>>()
  const userTimes = new Set<number>()
  for (const row of parsedUserDataset.rows) {
    if (!isValidCanonicalHour(row.timestamp)) {
      warnings.add(`Invalid user timestamp ${boundedDisplay(row.timestamp)} was skipped; expected YYYY-MM-DD HH:00:00.`)
      continue
    }
    userTimes.add(canonicalHourTime(row.timestamp))
    let combined = userByTimestamp.get(row.timestamp)
    if (!combined) {
      combined = {}
      userByTimestamp.set(row.timestamp, combined)
    }
    for (const variable of variables) {
      if (!Object.prototype.hasOwnProperty.call(row.values, variable.key)) continue
      const next = row.values[variable.key]
      if (next === undefined) continue
      const supplied = Object.prototype.hasOwnProperty.call(combined, variable.key)
        && combined[variable.key] !== undefined
      if (!supplied) {
        combined[variable.key] = next
        continue
      }
      const current = combined[variable.key] as number
      if (Object.is(current, next)) continue
      const currentFinite = Number.isFinite(current)
      const nextFinite = Number.isFinite(next)
      const descriptor = `${variable.key} (${variable.label}${variable.unit ? `; ${variable.unit}` : ''}; source column ${variable.sourceColumn})`
      if (!currentFinite && nextFinite) {
        combined[variable.key] = next
        warnings.add(`User timestamp ${row.timestamp} duplicate conflict for ${descriptor}; finite value ${shownValue(next)} replaced non-finite value ${shownValue(current)}.`)
        continue
      }
      if (currentFinite && !nextFinite) {
        warnings.add(`User timestamp ${row.timestamp} duplicate conflict for ${descriptor}; finite value ${shownValue(current)} retained over non-finite value ${shownValue(next)}.`)
        continue
      }
      if (currentFinite && nextFinite) {
        warnings.add(`User timestamp ${row.timestamp} duplicate conflict for ${descriptor}; first finite value ${shownValue(current)} retained over ${shownValue(next)}.`)
      } else {
        warnings.add(`User timestamp ${row.timestamp} duplicate conflict for ${descriptor}; first non-finite value ${shownValue(current)} retained over ${shownValue(next)}.`)
      }
    }
  }
  assertBoundedTimeline([...userTimes], 'User')

  const unmatchedUserTimestamps = [...userByTimestamp.keys()].filter((timestamp) => !stationTimestamps.has(timestamp))
  if (unmatchedUserTimestamps.length > 0) {
    const sample = unmatchedUserTimestamps.slice(0, UNMATCHED_TIMESTAMP_SAMPLE_LIMIT)
    warnings.add(`${unmatchedUserTimestamps.length} unmatched user timestamp(s) were not inserted: ${sample.join(', ')}${unmatchedUserTimestamps.length > sample.length ? ', ...' : ''}`)
  }

  const rows = stationRows.map((stationRow): UserMergedRow => {
    const values = userByTimestamp.get(stationRow.timestamp)
    const userValues: Record<string, number | undefined> = {}
    if (values) {
      for (const variable of variables) {
        if (Object.prototype.hasOwnProperty.call(values, variable.key)) userValues[variable.key] = values[variable.key]
      }
    }
    return { ...stationRow, missing: [...stationRow.missing], userValues }
  })
  return {
    rows,
    variables: variables.map((variable) => ({ ...variable })),
    warnings: warnings.finish(),
    warningTotal: warnings.count(),
    unmatchedUserTimestamps: [...unmatchedUserTimestamps],
    unmatchedUserTimestampCount: unmatchedUserTimestamps.length,
  }
}
