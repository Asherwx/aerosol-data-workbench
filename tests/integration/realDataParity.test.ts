import { basename, join } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'

import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file/node'
import { describe, expect, it } from 'vitest'

import { EXPORT_HEADERS } from '../../src/core/exportShared'
import { createMergedCsv, createStationCsv } from '../../src/core/exports'
import { mergeHourly } from '../../src/core/hourlyMerge'
import { parseIonWorkbookSheets } from '../../src/core/ionMatrix'
import { createQcWorkbookBlobDirect } from '../../src/core/qcWorkbook'
import { qualityControl, type CheckedRow } from '../../src/core/qualityControl'
import { parseStationCsvText } from '../../src/core/stationCsv'
import { buildHourlySeries } from '../../src/core/stationSeries'
import { POLLUTANTS, type HourlyStationRow } from '../../src/core/types'
import {
  INCOMPLETE_PRIVATE_PARITY_ENV_MESSAGE,
  privateParityMode,
} from '../helpers/privateParityEnvironment'

const stationFixtureDirectory = process.env.PRIVATE_STATION_FIXTURES
const ionWorkbookPath = process.env.PRIVATE_ION_WORKBOOK
const citySixPollutantPath = process.env.PRIVATE_CITY_SIX_POLLUTANT_CSV
const primaryEnvironmentMode = privateParityMode(stationFixtureDirectory, ionWorkbookPath)
const describePrivate = primaryEnvironmentMode === 'run' ? describe : describe.skip
const describePrivateCity = citySixPollutantPath ? describe : describe.skip
const itInvalidPrimaryEnvironment = primaryEnvironmentMode === 'invalid' ? it : it.skip
const stationFilePattern = /^china_sites_(202411(?:0[1-9]|[12]\d|30)|202412(?:0[1-9]|[12]\d|3[01]))\.csv$/
const expectedStart = '2024-11-01 00:00:00'
const expectedEnd = '2024-12-31 23:00:00'
const comparisonTimestamp = '2024-11-15 18:00:00'
const expectedStationValues = [6, 38, 42, 0.8, 101, 73]
const expectedHours = 61 * 24

function elapsed(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10
}

function expectContinuousHours(timestamps: readonly string[]): void {
  expect(timestamps).toHaveLength(expectedHours)
  expect(new Set(timestamps).size).toBe(expectedHours)
  expect(timestamps[0]).toBe(expectedStart)
  expect(timestamps.at(-1)).toBe(expectedEnd)

  const start = Date.UTC(2024, 10, 1)
  timestamps.forEach((timestamp, index) => {
    const expected = new Date(start + index * 60 * 60 * 1_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19)
    expect(timestamp).toBe(expected)
  })
}

function parseCsv(csv: string): string[][] {
  const parsed = Papa.parse<string[]>(csv.replace(/^\uFEFF/, ''), {
    skipEmptyLines: true,
  })
  expect(parsed.errors).toEqual([])
  return parsed.data
}

function expectRepresentativeWorkbookRow(
  workbookRow: readonly unknown[] | undefined,
  source: CheckedRow,
): void {
  expect(workbookRow?.[0]).toBe(source.timestamp)
  expect(workbookRow?.slice(1, 7)).toEqual(
    POLLUTANTS.map((pollutant) => source[pollutant] ?? null),
  )
  expect(workbookRow?.slice(9, 12)).toEqual([source.NO3 ?? null, source.SO4 ?? null, source.NH4 ?? null])
  expect(workbookRow?.slice(12, 14)).toEqual([source.QC_flag, source.QC_keep])
}

async function blobBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })
}

describe('private research data environment', () => {
  itInvalidPrimaryEnvironment('requires the station directory and ion workbook together', () => {
    throw new Error(INCOMPLETE_PRIVATE_PARITY_ENV_MESSAGE)
  })
})

describePrivate('real research data parity', () => {
  it('preserves the full station-ion-QC-export pipeline without changing private inputs', async () => {
    const stationDirectory = stationFixtureDirectory as string
    const workbookPath = ionWorkbookPath as string
    const files = readdirSync(stationDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && stationFilePattern.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    expect(files).toHaveLength(61)
    expect(files[0]).toBe('china_sites_20241101.csv')
    expect(files.at(-1)).toBe('china_sites_20241231.csv')

    const inputStats = new Map(
      [...files.map((filename) => join(stationDirectory, filename)), workbookPath]
        .map((path) => {
          const stat = statSync(path)
          return [path, { size: stat.size, mtimeMs: stat.mtimeMs }] as const
        }),
    )
    const timings: Record<string, number> = {}

    let startedAt = performance.now()
    const parsedFiles = files.map((filename) => parseStationCsvText(
      readFileSync(join(stationDirectory, filename), 'utf8'),
      filename,
      '3329A',
    ))
    timings.stationParseMs = elapsed(startedAt)
    expect(parsedFiles.flatMap(({ warnings }) => warnings)).toEqual([])
    const stationInput: HourlyStationRow[] = parsedFiles.flatMap(({ rows }) => rows)
    const stationInputSnapshot = structuredClone(stationInput)

    startedAt = performance.now()
    const stationSeries = buildHourlySeries(stationInput)
    timings.stationSeriesMs = elapsed(startedAt)
    expect(stationInput).toEqual(stationInputSnapshot)
    expect(stationSeries.duplicateTimes).toEqual([])
    expect(stationSeries.warnings).toEqual([])
    expectContinuousHours(stationSeries.rows.map(({ timestamp }) => timestamp))
    const comparisonStationRow = stationSeries.rows.find(({ timestamp }) => timestamp === comparisonTimestamp)
    expect(comparisonStationRow).toBeDefined()
    expect(POLLUTANTS.map((pollutant) => comparisonStationRow?.[pollutant])).toEqual(expectedStationValues)
    expect(comparisonStationRow?.missing).toEqual([])

    startedAt = performance.now()
    const workbookSheets = await readXlsxFile(readFileSync(workbookPath))
    timings.workbookReadMs = elapsed(startedAt)
    const workbookSheetsSnapshot = structuredClone(workbookSheets)
    startedAt = performance.now()
    const ionResult = parseIonWorkbookSheets(workbookSheets, basename(workbookPath))
    timings.ionParseMs = elapsed(startedAt)
    expect(workbookSheets).toEqual(workbookSheetsSnapshot)
    expect(ionResult.sheetName).toBe('站点数据')
    expect(ionResult.warnings).toEqual([])
    expectContinuousHours(ionResult.rows.map(({ timestamp }) => timestamp))
    const ionPopulated = ionResult.rows.filter((row) =>
      row.NO3 !== undefined || row.SO4 !== undefined || row.NH4 !== undefined,
    ).length
    const ionBlank = ionResult.rows.length - ionPopulated
    expect({ ionPopulated, ionBlank, total: ionResult.rows.length }).toEqual({
      ionPopulated: 1393,
      ionBlank: 71,
      total: expectedHours,
    })

    const stationSnapshot = structuredClone(stationSeries.rows)
    const ionSnapshot = structuredClone(ionResult.rows)
    startedAt = performance.now()
    const merged = mergeHourly(stationSeries.rows, ionResult.rows)
    timings.mergeMs = elapsed(startedAt)
    expect(stationSeries.rows).toEqual(stationSnapshot)
    expect(ionResult.rows).toEqual(ionSnapshot)
    expect(merged.rows).toHaveLength(expectedHours)
    expect(merged.unmatchedIonTimestamps).toEqual([])
    expect(merged.warnings).toEqual([])
    expectContinuousHours(merged.rows.map(({ timestamp }) => timestamp))
    expect(POLLUTANTS.map((pollutant) =>
      merged.rows.find(({ timestamp }) => timestamp === comparisonTimestamp)?.[pollutant],
    )).toEqual(expectedStationValues)

    const mergedSnapshot = structuredClone(merged.rows)
    startedAt = performance.now()
    const qc = qualityControl(merged.rows)
    timings.qcMs = elapsed(startedAt)
    expect(merged.rows).toEqual(mergedSnapshot)
    expect(qc.rows).toHaveLength(expectedHours)
    expect(qc.keptRows.length + qc.rejectedRows.length).toBe(expectedHours)
    expect(qc.keptRows.every(({ QC_keep }) => QC_keep)).toBe(true)
    expect(qc.rejectedRows.every(({ QC_keep }) => !QC_keep)).toBe(true)
    // The older Python result (1328/136) used a different core-variable set.
    // The current browser rule checks all six pollutants plus all three ions.
    expect({ kept: qc.keptRows.length, rejected: qc.rejectedRows.length }).toEqual({
      kept: 1300,
      rejected: 164,
    })
    const comparisonQcRow = qc.rows.find(({ timestamp }) => timestamp === comparisonTimestamp)
    expect(POLLUTANTS.map((pollutant) => comparisonQcRow?.[pollutant])).toEqual(expectedStationValues)

    const qcSnapshot = structuredClone(qc)
    startedAt = performance.now()
    const stationCsv = createStationCsv(stationSeries.rows)
    const mergedCsv = createMergedCsv(qc.rows)
    const workbook = await createQcWorkbookBlobDirect(qc, {
      processingTime: '2024-12-31T23:00:00.000Z',
      stationId: '3329A',
      inputFiles: files.map((filename) => basename(filename)).concat(basename(workbookPath)),
      inputCounts: { stationFiles: files.length, ionWorkbooks: 1 },
      rowCounts: { station: stationSeries.rows.length, ion: ionResult.rows.length, merged: merged.rows.length },
      warnings: [],
      version: 'real-data-parity',
      logicNotes: ['Current browser nine-variable QC; private measurements are not persisted.'],
    })
    timings.exportsMs = elapsed(startedAt)
    expect(qc).toEqual(qcSnapshot)

    const stationCsvRows = parseCsv(stationCsv)
    expect(stationCsvRows).toHaveLength(expectedHours + 1)
    expect(stationCsvRows[0]).toEqual(EXPORT_HEADERS.slice(0, 9))
    const mergedCsvRows = parseCsv(mergedCsv)
    expect(mergedCsvRows).toHaveLength(expectedHours + 1)
    expect(mergedCsvRows[0]).toEqual([...EXPORT_HEADERS])
    const comparisonExport = mergedCsvRows.find((row) => row[0] === comparisonTimestamp)
    expect(comparisonExport?.slice(1, 7)).toEqual(expectedStationValues.map(String))

    startedAt = performance.now()
    const exportedSheets = await readXlsxFile(Buffer.from(await blobBuffer(workbook)))
    timings.exportReadbackMs = elapsed(startedAt)
    expect(exportedSheets).toHaveLength(5)
    expect(exportedSheets[0]?.data).toHaveLength(expectedHours + 1)
    expect(exportedSheets[0]?.data[0]).toEqual([...EXPORT_HEADERS])
    expect(exportedSheets[1]?.data).toHaveLength(qc.keptRows.length + 1)
    expect(exportedSheets[2]?.data).toHaveLength(qc.rejectedRows.length + 1)
    expect({
      kept: (exportedSheets[1]?.data.length ?? 1) - 1,
      rejected: (exportedSheets[2]?.data.length ?? 1) - 1,
    }).toEqual({ kept: 1300, rejected: 164 })

    const mergedWorkbookRows = exportedSheets[0]?.data
    const firstQcRow = qc.rows[0] as CheckedRow
    const comparisonQcIndex = qc.rows.findIndex(({ timestamp }) => timestamp === comparisonTimestamp)
    expect(comparisonQcIndex).toBeGreaterThanOrEqual(0)
    expectRepresentativeWorkbookRow(mergedWorkbookRows?.[1], firstQcRow)
    expectRepresentativeWorkbookRow(
      mergedWorkbookRows?.[comparisonQcIndex + 1],
      qc.rows[comparisonQcIndex] as CheckedRow,
    )

    const summaryRows = exportedSheets[3]?.data.slice(1) ?? []
    const summaryCounts = new Map(summaryRows.map((row) => [String(row[0]), Number(row[1])]))
    expect(Object.fromEntries(summaryCounts)).toEqual(qc.counts)
    const normalLabel = qc.keptRows[0]?.QC_flag as string
    expect(summaryCounts.get(normalLabel)).toBe(1300)
    expect([...summaryCounts.entries()]
      .filter(([label]) => label !== normalLabel)
      .reduce((sum, [, count]) => sum + count, 0)).toBe(502)

    for (const [path, before] of inputStats) {
      const after = statSync(path)
      expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual(before)
    }
    for (const [stage, durationMs] of Object.entries(timings)) {
      expect(durationMs, `${stage} exceeded generous smoke limit`).toBeLessThan(60_000)
    }

    const flagCounts = qc.rows
      .flatMap(({ QC_flags }) => QC_flags)
      .reduce<Record<string, number>>((counts, { code }) => {
        counts[code] = (counts[code] ?? 0) + 1
        return counts
      }, {})
    const missingByVariable = qc.rows
      .flatMap(({ QC_flags }) => QC_flags)
      .filter(({ code }) => code === 'missing')
      .reduce<Record<string, number>>((counts, { variable }) => {
        const key = variable ?? 'unspecified'
        counts[key] = (counts[key] ?? 0) + 1
        return counts
      }, {})
    expect(flagCounts).toEqual({ missing: 502 })
    expect(missingByVariable).toEqual({
      NO3: 71,
      SO4: 71,
      NH4: 71,
      PM10: 49,
      NO2: 47,
      O3: 47,
      'PM2.5': 42,
      SO2: 47,
      CO: 57,
    })
    const stationMissingRows = qc.rows.filter(({ QC_flags }) => QC_flags.some(({ code, variable }) =>
      code === 'missing' && variable !== undefined && POLLUTANTS.includes(variable as (typeof POLLUTANTS)[number]),
    )).length
    const ionMissingRows = qc.rows.filter(({ QC_flags }) => QC_flags.some(({ code, variable }) =>
      code === 'missing' && (variable === 'NO3' || variable === 'SO4' || variable === 'NH4'),
    )).length
    const bothMissingRows = qc.rows.filter(({ QC_flags }) => {
      const variables = new Set(QC_flags.filter(({ code }) => code === 'missing').map(({ variable }) => variable))
      return POLLUTANTS.some((pollutant) => variables.has(pollutant))
        && ['NO3', 'SO4', 'NH4'].some((ion) => variables.has(ion as 'NO3' | 'SO4' | 'NH4'))
    }).length
    expect({ stationMissingRows, ionMissingRows, bothMissingRows }).toEqual({
      stationMissingRows: 100,
      ionMissingRows: 71,
      bothMissingRows: 7,
    })
    console.info('REAL_DATA_PARITY', JSON.stringify({
      stationFiles: files.length,
      timeline: { rows: expectedHours, start: expectedStart, end: expectedEnd },
      ions: { populated: ionPopulated, blank: ionBlank },
      qc: {
        kept: qc.keptRows.length,
        rejected: qc.rejectedRows.length,
        flagCounts,
        missingByVariable,
        rejectionGroups: { stationMissingRows, ionMissingRows, bothMissingRows },
      },
      comparisonRecord: { timestamp: comparisonTimestamp, stationValues: expectedStationValues, preserved: true },
      exports: { stationCsvRows: stationCsvRows.length - 1, mergedCsvRows: mergedCsvRows.length - 1, workbookSheets: exportedSheets.length },
      timingsMs: timings,
    }))
  }, 120_000)
})

describePrivateCity('private city six-pollutant comparison', () => {
  it('keeps the separate city zero event distinct from station daily files', () => {
    const path = citySixPollutantPath as string
    const before = statSync(path)
    const parsed = Papa.parse<Record<string, string>>(readFileSync(path, 'utf8'), {
      header: true,
      skipEmptyLines: true,
    })
    expect(parsed.errors).toEqual([])
    const row = parsed.data.find((candidate) =>
      candidate.stationcode === '3329A' && candidate.timepoint === '11/15/2024 18:00',
    )
    expect(row).toBeDefined()
    expect(['so2', 'no2', 'o3', 'co', 'pm10', 'pm2_5'].map((key) => Number(row?.[key]))).toEqual([
      0, 0, 0, 0, 0, 0,
    ])
    expect({ size: statSync(path).size, mtimeMs: statSync(path).mtimeMs }).toEqual({
      size: before.size,
      mtimeMs: before.mtimeMs,
    })
  })
})
