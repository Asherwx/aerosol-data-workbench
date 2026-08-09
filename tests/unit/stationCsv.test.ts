import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  parseStationCsvText,
  STATION_CSV_WARNING_CAP,
} from '../../src/core/stationCsv'

const fixture = readFileSync('tests/fixtures/china_sites_20241101-small.csv', 'utf8')

describe('parseStationCsvText', () => {
  it('pivots the exact sample into six instantaneous pollutant values', () => {
    const result = parseStationCsvText(fixture, 'china_sites_20241101.csv', '3329A')

    expect(result).toEqual({
      filename: 'china_sites_20241101.csv',
      rows: [
        {
          timestamp: '2024-11-01 00:00:00',
          SO2: 3,
          NO2: 21,
          O3: 92,
          CO: 0.6,
          PM10: 89,
          'PM2.5': 49,
        },
      ],
      warnings: [],
    })
  })

  it('keeps the fixture values for station 2277A exact', () => {
    const result = parseStationCsvText(fixture, 'china_sites_20241101.csv', '2277A')

    expect(result.rows).toEqual([
      {
        timestamp: '2024-11-01 00:00:00',
        SO2: 9,
        NO2: 27,
        O3: 68,
        CO: 0.9,
        PM10: 80,
        'PM2.5': 51,
      },
    ])
  })

  it('removes a UTF-8 BOM before reading headers', () => {
    const result = parseStationCsvText(`\uFEFF${fixture}`, 'bom.csv', '3329A')
    expect(result.rows[0]?.SO2).toBe(3)
  })

  it('requires a non-empty station id', () => {
    expect(() => parseStationCsvText(fixture, 'sample.csv', '  ')).toThrow(
      '站点编号不能为空',
    )
  })

  it('reports a missing selected station column', () => {
    expect(() => parseStationCsvText(fixture, 'sample.csv', '9999A')).toThrow(
      '站点列不存在：9999A',
    )
  })

  it.each(['date', 'hour', 'type'])('reports a missing structural %s column', (field) => {
    const csv = fixture.replace(field, `not_${field}`)
    expect(() => parseStationCsvText(csv, 'sample.csv', '3329A')).toThrow(
      `必要列不存在：${field}`,
    )
  })

  it('preserves numeric zero', () => {
    const csv = 'date,hour,type,3329A\n20241101,1,SO2,0'
    expect(parseStationCsvText(csv, 'zero.csv', '3329A').rows).toEqual([
      { timestamp: '2024-11-01 01:00:00', SO2: 0 },
    ])
  })

  it('accepts a zero-padded valid hour', () => {
    const csv = 'date,hour,type,3329A\n20241101,07,SO2,1'
    expect(parseStationCsvText(csv, 'padded-hour.csv', '3329A').rows).toEqual([
      { timestamp: '2024-11-01 07:00:00', SO2: 1 },
    ])
  })

  it('treats a blank as missing without a corruption warning', () => {
    const csv = 'date,hour,type,3329A\n20241101,1,SO2,'
    expect(parseStationCsvText(csv, 'missing.csv', '3329A')).toEqual({
      filename: 'missing.csv',
      rows: [
        { timestamp: '2024-11-01 01:00:00' },
      ],
      warnings: [],
    })
  })

  it('warns with full context for invalid nonblank numeric text', () => {
    const csv = 'date,hour,type,3329A\n20241101,1,SO2,not-a-number'
    const result = parseStationCsvText(csv, 'invalid-number.csv', '3329A')

    expect(result.rows).toEqual([
      { timestamp: '2024-11-01 01:00:00' },
    ])
    expect(result.warnings).toEqual([
      'invalid-number.csv：第2行站点 3329A 在 2024-11-01 01:00:00 的 SO2 数值无效：not-a-number；按缺测处理',
    ])
  })

  it('excludes aggregates, AQI, and unknown measurement types', () => {
    const csv = [
      'date,hour,type,3329A',
      '20241101,2,SO2,3',
      '20241101,2,SO2_24h,30',
      '20241101,2,AQI,80',
      '20241101,2,temperature,12',
    ].join('\n')
    expect(parseStationCsvText(csv, 'types.csv', '3329A').rows).toEqual([
      { timestamp: '2024-11-01 02:00:00', SO2: 3 },
    ])
  })

  it('warns and skips invalid calendar dates and hours', () => {
    const csv = [
      'date,hour,type,3329A',
      '20240230,0,SO2,1',
      '20241101,24,SO2,2',
      '20241101,3,SO2,3',
    ].join('\n')
    const result = parseStationCsvText(csv, 'invalid.csv', '3329A')

    expect(result.rows).toEqual([{ timestamp: '2024-11-01 03:00:00', SO2: 3 }])
    expect(result.warnings).toEqual([
      'invalid.csv：第2行日期无效：20240230',
      'invalid.csv：第3行小时无效：24',
    ])
  })

  it('sorts timestamps ascending', () => {
    const csv = [
      'date,hour,type,3329A',
      '20241102,0,SO2,2',
      '20241101,23,SO2,1',
    ].join('\n')
    expect(parseStationCsvText(csv, 'sorted.csv', '3329A').rows.map((row) => row.timestamp)).toEqual([
      '2024-11-01 23:00:00',
      '2024-11-02 00:00:00',
    ])
  })

  it('retains the first finite duplicate value and reports the ignored row', () => {
    const csv = [
      'date,hour,type,3329A',
      '20241101,4,SO2,5',
      '20241101,4,SO2,9',
    ].join('\n')
    const result = parseStationCsvText(csv, 'duplicate.csv', '3329A')

    expect(result.rows).toEqual([{ timestamp: '2024-11-01 04:00:00', SO2: 5 }])
    expect(result.warnings).toEqual([
      'duplicate.csv：第3行 2024-11-01 04:00:00 的 SO2 重复；已忽略，保留首次有效值',
    ])
  })

  it.each([
    ['', '先前缺失'],
    ['bad', '先前无效'],
  ])('replaces %s with a later finite duplicate', (firstValue, priorState) => {
    const csv = [
      'date,hour,type,3329A',
      `20241101,4,SO2,${firstValue}`,
      '20241101,4,SO2,9',
    ].join('\n')
    const result = parseStationCsvText(csv, 'replace.csv', '3329A')

    expect(result.rows).toEqual([{ timestamp: '2024-11-01 04:00:00', SO2: 9 }])
    expect(result.warnings).toContain(
      `replace.csv：第3行 2024-11-01 04:00:00 的 SO2 重复；已替换${priorState}值`,
    )
  })

  it('warns and skips Papa field-mismatch rows while keeping valid rows', () => {
    const csv = [
      'date,hour,type,3329A',
      '20241101,0,SO2',
      '20241101,1,SO2,3,extra',
      '20241101,2,SO2,4',
    ].join('\n')
    const result = parseStationCsvText(csv, 'field-mismatch.csv', '3329A')

    expect(result.rows).toEqual([{ timestamp: '2024-11-01 02:00:00', SO2: 4 }])
    expect(result.warnings).toEqual([
      'field-mismatch.csv：第2行字段数不足（应为 4，实际为 3）；已跳过该行',
      'field-mismatch.csv：第3行字段数过多（应为 4，实际为 5）；已跳过该行',
    ])
  })

  it('warns and skips rows whose dates disagree with a recognized filename', () => {
    const csv = [
      'date,hour,type,3329A',
      '20241102,0,SO2,3',
      '20241103,0,AQI,80',
      '20241101,1,SO2,4',
    ].join('\n')
    const result = parseStationCsvText(csv, 'china_sites_20241101.csv', '3329A')

    expect(result.rows).toEqual([{ timestamp: '2024-11-01 01:00:00', SO2: 4 }])
    expect(result.warnings).toEqual([
      'china_sites_20241101.csv：第2行日期与文件名不一致；预期 20241101，实际 20241102；已跳过该行',
      'china_sites_20241101.csv：第3行日期与文件名不一致；预期 20241101，实际 20241103；已跳过该行',
    ])
  })

  it('parses representative-width CRLF data with quoted cells across hours', () => {
    const extraStations = Array.from({ length: 300 }, (_, index) => `S${index}`)
    const header = ['date', 'hour', 'type', ...extraStations, '3329A'].join(',')
    const emptyStations = extraStations.map(() => '').join(',')
    const csv = [
      header,
      `20241101,0,"SO2",${emptyStations},"3"`,
      `20241101,1,"NO2",${emptyStations},"21"`,
    ].join('\r\n')

    expect(parseStationCsvText(csv, 'wide.csv', '3329A').rows).toEqual([
      { timestamp: '2024-11-01 00:00:00', SO2: 3 },
      { timestamp: '2024-11-01 01:00:00', NO2: 21 },
    ])
  })

  it('caps hostile-file warnings and appends a truncation warning', () => {
    const rows = Array.from(
      { length: STATION_CSV_WARNING_CAP + 5 },
      (_, index) => `20240230,${index % 24},SO2,1`,
    )
    const result = parseStationCsvText(
      ['date,hour,type,3329A', ...rows].join('\n'),
      'hostile.csv',
      '3329A',
    )

    expect(result.warnings).toHaveLength(STATION_CSV_WARNING_CAP)
    expect(result.warnings.at(-1)).toBe(
      `hostile.csv：警告过多，仅显示前 ${STATION_CSV_WARNING_CAP - 1} 条，其余已截断`,
    )
  })

  it('makes quote syntax errors blocking with filename, impact, and action', () => {
    const csv = 'date,hour,type,3329A\n20241101,0,SO2,"unterminated'
    expect(() => parseStationCsvText(csv, 'broken.csv', '3329A')).toThrow(
      /CSV解析失败：broken\.csv：[\s\S]*MissingQuotes[\s\S]*影响：[\s\S]*操作：/,
    )
  })

  it('makes an unusable delimiter blocking with actionable context', () => {
    const csv = 'date hour type 3329A\n20241101 0 SO2 3'
    expect(() => parseStationCsvText(csv, 'spaces.csv', '3329A')).toThrow(
      /CSV解析失败：spaces\.csv：[\s\S]*UndetectableDelimiter[\s\S]*影响：[\s\S]*操作：/,
    )
  })
})
