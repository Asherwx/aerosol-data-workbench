import Papa from 'papaparse'

import { serializeExtractedStationCsv } from './extractedStationCsv'
import { STATION_ID_PATTERN, type HourlyStationRow } from './types'

export type StationFileKind = 'national-daily' | 'station-wide'
export const MAX_NATIONAL_DAILY_FILE_BYTES = 8 * 1024 * 1024
export const MAX_STATION_WIDE_FILE_BYTES = 5 * 1024 * 1024
export const MAX_STATION_INPUT_BATCH_BYTES = 32 * 1024 * 1024
export const MAX_STATION_INPUT_FILES = 20

export type StationWideFilenameIdentity = {
  stationId: string
  startDate: string
  endDate: string
}

const STATION_WIDE_HEADERS = Papa.parse<string[]>(
  serializeExtractedStationCsv({ stationId: '0000A', rows: [] }).replace(/^\uFEFF/, ''),
  { preview: 1 },
).data[0] ?? []

function compactDateToIso(value: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (!match) return undefined
  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined
  return `${yearText}-${monthText}-${dayText}`
}

function basename(filename: string): string {
  return filename.split(/[\\/]/).at(-1) ?? filename
}

export function assertNationalDailyFilename(filename: string): string {
  const match = /^china_sites_(\d{8})\.csv$/.exec(basename(filename))
  const date = match && compactDateToIso(match[1])
  if (!date) throw new Error(`文件名必须为严格的 china_sites_YYYYMMDD.csv，且日期有效：${filename}`)
  return date
}

export function parseStationWideFilename(filename: string): StationWideFilenameIdentity {
  const match = /^(\d{4}[A-Z])_(\d{8})_(\d{8})\.csv$/.exec(basename(filename))
  const startDate = match && compactDateToIso(match[2])
  const endDate = match && compactDateToIso(match[3])
  if (!match || !startDate || !endDate || startDate > endDate) {
    throw new Error(`文件名必须为严格的 <station>_YYYYMMDD_YYYYMMDD.csv，且日期范围有效：${filename}`)
  }
  return { stationId: match[1], startDate, endDate }
}

export function validateStationWideIdentity(
  filename: string,
  selectedStationId: string,
  parsedStationId: string,
  rows: readonly HourlyStationRow[],
): void {
  const identity = parseStationWideFilename(filename)
  if (parsedStationId !== selectedStationId) {
    throw new Error(`站点宽表中的站点编号 ${parsedStationId} 与当前选择的 ${selectedStationId} 不一致`)
  }
  if (identity.stationId !== parsedStationId) {
    throw new Error(`站点宽表文件名中的站点编号 ${identity.stationId} 与表内 ${parsedStationId} 不一致`)
  }
  const firstDate = rows[0]?.timestamp.slice(0, 10)
  const lastDate = rows.at(-1)?.timestamp.slice(0, 10)
  if (firstDate !== identity.startDate || lastDate !== identity.endDate) {
    throw new Error(`站点宽表实际日期范围 ${firstDate ?? '无'} 至 ${lastDate ?? '无'} 与文件名范围 ${identity.startDate} 至 ${identity.endDate} 不一致`)
  }
}

export function assertStationFileSize(file: Pick<File, 'name' | 'size'>, kind: StationFileKind): void {
  const maximum = kind === 'station-wide' ? MAX_STATION_WIDE_FILE_BYTES : MAX_NATIONAL_DAILY_FILE_BYTES
  if (file.size > maximum) throw new Error(`${file.name} 大小超过 ${kind === 'station-wide' ? '5 MiB' : '8 MiB'} 限制`)
}

export function detectStationFileKind(
  preview: string,
  filename: string,
): { kind: StationFileKind } {
  const parsed = Papa.parse<string[]>(preview.replace(/^\uFEFF/, ''), {
    preview: 1,
    skipEmptyLines: true,
  })
  const header = parsed.data[0]
  if (!header || parsed.errors.length > 0) {
    throw new Error(`无法识别 ${filename}：表头无法解析。请提供国控日文件或本站导出的站点宽表 CSV。`)
  }
  const fields = header.map((value) => value.trim())
  if (fields.join('\u0000') === STATION_WIDE_HEADERS.join('\u0000')) {
    parseStationWideFilename(filename)
    return { kind: 'station-wide' }
  }
  if (
    fields.length >= 4 &&
    fields[0] === 'date' &&
    fields[1] === 'hour' &&
    fields[2] === 'type' &&
    fields.slice(3).some((field) => STATION_ID_PATTERN.test(field))
  ) {
    assertNationalDailyFilename(filename)
    return { kind: 'national-daily' }
  }
  throw new Error(`无法识别 ${filename}：表头不符合国控日文件或站点宽表格式。请检查文件类型和表头。`)
}
