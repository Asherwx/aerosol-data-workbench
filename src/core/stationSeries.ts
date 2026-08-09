import {
  POLLUTANTS,
  type HourlyStationRow,
  type Pollutant,
} from './types'

export const MAX_HOURLY_SERIES_HOURS = 366 * 24

export type StationSeriesRow = HourlyStationRow & {
  missing: Pollutant[]
  status: '完整' | '存在缺测'
}

export interface HourlySeriesResult {
  rows: StationSeriesRow[]
  duplicateTimes: string[]
  warnings: string[]
}

const CANONICAL_HOUR_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):00:00$/
const HOUR_IN_MILLISECONDS = 60 * 60 * 1000

function parseBeijingHour(timestamp: string): number {
  const match = CANONICAL_HOUR_PATTERN.exec(timestamp)
  if (!match) throw new Error(`无效小时数据时间：${timestamp}`)

  const [, yearPart, monthPart, dayPart, hourPart] = match
  const year = Number(yearPart)
  const month = Number(monthPart)
  const day = Number(dayPart)
  const hour = Number(hourPart)
  const calendarValue = new Date(0)
  calendarValue.setUTCHours(0, 0, 0, 0)
  calendarValue.setUTCFullYear(year, month - 1, day)
  calendarValue.setUTCHours(hour)

  if (
    year < 1000 ||
    hour > 23 ||
    calendarValue.getUTCFullYear() !== year ||
    calendarValue.getUTCMonth() !== month - 1 ||
    calendarValue.getUTCDate() !== day ||
    calendarValue.getUTCHours() !== hour
  ) {
    throw new Error(`无效小时数据时间：${timestamp}`)
  }

  return calendarValue.getTime()
}

function formatBeijingHour(time: number): string {
  const date = new Date(time)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:00:00`
}

function isFiniteMeasurement(value: number | undefined): value is number {
  return Number.isFinite(value)
}

export function buildHourlySeries(
  input: readonly HourlyStationRow[],
): HourlySeriesResult {
  if (input.length === 0) {
    return { rows: [], duplicateTimes: [], warnings: [] }
  }

  const rowsByTime = new Map<number, HourlyStationRow>()
  const duplicateTimeValues = new Set<number>()
  const warnings: string[] = []
  let minimumTime = Number.POSITIVE_INFINITY
  let maximumTime = Number.NEGATIVE_INFINITY

  for (const inputRow of input) {
    const time = parseBeijingHour(inputRow.timestamp)
    minimumTime = Math.min(minimumTime, time)
    maximumTime = Math.max(maximumTime, time)

    let combinedRow = rowsByTime.get(time)
    if (!combinedRow) {
      combinedRow = { timestamp: inputRow.timestamp }
      rowsByTime.set(time, combinedRow)
    } else {
      duplicateTimeValues.add(time)
    }

    for (const pollutant of POLLUTANTS) {
      const nextValue = inputRow[pollutant]
      if (!isFiniteMeasurement(nextValue)) continue

      const firstValue = combinedRow[pollutant]
      if (isFiniteMeasurement(firstValue)) {
        if (firstValue !== nextValue) {
          warnings.push(
            `时间 ${inputRow.timestamp} 的 ${pollutant} 存在重复有效值；已保留首次值 ${firstValue}，忽略后续值 ${nextValue}`,
          )
        }
      } else {
        combinedRow[pollutant] = nextValue
      }
    }
  }

  const hourCount = (maximumTime - minimumTime) / HOUR_IN_MILLISECONDS + 1
  if (hourCount > MAX_HOURLY_SERIES_HOURS) {
    throw new Error(
      `小时序列超过安全上限 ${MAX_HOURLY_SERIES_HOURS}；请缩小日期范围后重试`,
    )
  }

  const rows: StationSeriesRow[] = []
  for (let time = minimumTime; time <= maximumTime; time += HOUR_IN_MILLISECONDS) {
    const source = rowsByTime.get(time)
    const row: HourlyStationRow = { timestamp: formatBeijingHour(time) }

    if (source) {
      for (const pollutant of POLLUTANTS) {
        const value = source[pollutant]
        if (isFiniteMeasurement(value)) row[pollutant] = value
      }
    }

    const missing = POLLUTANTS.filter(
      (pollutant) => !isFiniteMeasurement(row[pollutant]),
    )
    rows.push({
      ...row,
      missing: [...missing],
      status: missing.length === 0 ? '完整' : '存在缺测',
    })
  }

  return {
    rows,
    duplicateTimes: [...duplicateTimeValues]
      .sort((left, right) => left - right)
      .map(formatBeijingHour),
    warnings: [...warnings],
  }
}
