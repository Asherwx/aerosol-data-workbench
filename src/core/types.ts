export const POLLUTANTS = ['SO2', 'NO2', 'O3', 'CO', 'PM10', 'PM2.5'] as const

export type Pollutant = (typeof POLLUTANTS)[number]

export const STATION_ID_PATTERN = /^[0-9]{4}[A-Z]$/

export function assertCanonicalStationId(value: string): string {
  if (!STATION_ID_PATTERN.test(value)) throw new Error('站点编号格式无效')
  return value
}

export const POLLUTANT_SET: ReadonlySet<Pollutant> = new Set(POLLUTANTS)

export function isPollutant(value: string): value is Pollutant {
  return POLLUTANT_SET.has(value as Pollutant)
}

export interface DownloadLink {
  date: string
  filename: string
  url: string
}

export type HourlyStationRow = {
  timestamp: string
} & Partial<Record<Pollutant, number>>

export interface HourlyStationDataRow {
  timestamp: string
  values: Record<string, number>
}

export interface DownloadStationRangeOptions {
  startDate: string
  endDate: string
  stationId: string
  endpoint: string
  concurrency?: number
  signal: AbortSignal
  fetcher?: typeof fetch
  onProgress?: (progress: DownloadStationRangeProgress) => void
}

export interface DownloadStationRangeProgress {
  completed: number
  total: number
  failed: number
}

export interface DownloadedStationRange {
  filename: string
  csvText: string
  rows: HourlyStationRow[]
  allRows: HourlyStationDataRow[]
  failedDates: string[]
  warnings: string[]
  warningTotal: number
}

export type QcSeverity = 'warning' | 'blocking'

export interface QcIssue {
  code: string
  severity: QcSeverity
  message: string
  timestamp?: string
  file?: string
}
