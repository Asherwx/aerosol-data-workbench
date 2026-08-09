import type { HourlyStationDataRow, HourlyStationRow } from '../../src/core/types'

export interface StationDayResponse {
  date: string
  stationId: string
  sourceFilename: string
  rows: HourlyStationRow[]
  allRows: HourlyStationDataRow[]
  warnings: string[]
  warningTotal: number
}

export const STATION_ID_PATTERN = /^[0-9]{4}[A-Z]$/
export const MAX_UPSTREAM_CSV_BYTES = 8 * 1024 * 1024
export const STATION_DAY_WARNING_LIMIT = 100
export const MAX_STATION_DAY_CSV_COLUMNS = 2_048
export const MAX_STATION_DAY_CSV_LINE_CHARS = 64 * 1024
export const MAX_STATION_DAY_CSV_DATA_ROWS = 50_000
