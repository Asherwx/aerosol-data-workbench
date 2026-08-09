import { describe, expect, it } from 'vitest'
import {
  extractStationDay,
  STATION_DAY_WARNING_LIMIT,
} from '../../worker/src/stationDay'
import {
  MAX_STATION_DAY_CSV_COLUMNS,
  MAX_STATION_DAY_CSV_DATA_ROWS,
  MAX_STATION_DAY_CSV_LINE_CHARS,
  MAX_UPSTREAM_CSV_BYTES,
  STATION_ID_PATTERN,
} from '../../worker/src/protocol'

const SIX_POLLUTANT_CSV = [
  'date,hour,type,3329A,2277A',
  '20241101,0,SO2,3,9',
  '20241101,0,NO2,21,27',
  '20241101,0,O3,92,68',
  '20241101,0,CO,0.6,0.9',
  '20241101,0,PM10,89,80',
  '20241101,0,PM2.5,49,51',
].join('\n')

describe('extractStationDay', () => {
  it('extracts the requested station day from BOM-prefixed CSV data', () => {
    expect(extractStationDay(`\uFEFF${SIX_POLLUTANT_CSV}`, '2024-11-01', '3329A')).toEqual({
      date: '2024-11-01',
      stationId: '3329A',
      sourceFilename: 'china_sites_20241101.csv',
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
      allRows: [{
        timestamp: '2024-11-01 00:00:00',
        values: { SO2: 3, NO2: 21, O3: 92, CO: 0.6, PM10: 89, 'PM2.5': 49 },
      }],
      warnings: [],
      warningTotal: 0,
    })
  })

  it.each(['', '3329', '3329A<script>'])('rejects invalid station IDs', (stationId) => {
    expect(() => extractStationDay(SIX_POLLUTANT_CSV, '2024-11-01', stationId)).toThrow(
      /站点编号/,
    )
  })

  it('skips dates outside the requested day and bounds mismatch warnings', () => {
    const mismatchRows = Array.from(
      { length: STATION_DAY_WARNING_LIMIT + 5 },
      () => '20241102,0,SO2,3,9',
    )
    const result = extractStationDay(
      ['date,hour,type,3329A,2277A', ...mismatchRows, '20241101,1,SO2,4,8'].join('\n'),
      '2024-11-01',
      '3329A',
    )

    expect(result.rows).toEqual([{ timestamp: '2024-11-01 01:00:00', SO2: 4 }])
    expect(result.warningTotal).toBe(mismatchRows.length)
    expect(result.warnings.length).toBeLessThanOrEqual(STATION_DAY_WARNING_LIMIT)
    expect(result.warningTotal).toBeGreaterThan(result.warnings.length)
  })

  it('requires a real ISO calendar date and an integer hour from 0 through 23', () => {
    expect(() => extractStationDay(SIX_POLLUTANT_CSV, '2024-02-30', '3329A')).toThrow()

    const result = extractStationDay(
      [
        'date,hour,type,3329A',
        '20241101,0.5,SO2,1',
        '20241101,24,SO2,2',
        '20241101,07,SO2,3',
      ].join('\n'),
      '2024-11-01',
      '3329A',
    )

    expect(result.rows).toEqual([{ timestamp: '2024-11-01 07:00:00', SO2: 3 }])
    expect(result.warningTotal).toBe(2)
  })

  it('rejects text larger than the upstream CSV byte limit', () => {
    expect(() =>
      extractStationDay('x'.repeat(MAX_UPSTREAM_CSV_BYTES + 1), '2024-11-01', '3329A'),
    ).toThrow(/大小/)
  })

  it('counts UTF-8 bytes rather than JavaScript characters for the source limit', () => {
    const text = '汉'.repeat(Math.floor(MAX_UPSTREAM_CSV_BYTES / 3) + 1)
    expect(() => extractStationDay(text, '2024-11-01', '3329A')).toThrow(/大小/)
  })

  it.each([
    'date,hour,type,3329A,3329A',
    'date,date,type,3329A',
    'date,hour,type,type,3329A',
    'date,hour,type,,3329A',
  ])('rejects duplicate or empty raw headers', (header) => {
    expect(() => extractStationDay(`${header}\n20241101,0,SO2,3,4`, '2024-11-01', '3329A')).toThrow(
      /表头/,
    )
  })

  it('rejects a header with too many physical columns before Papa expands it', () => {
    const header = Array.from({ length: MAX_STATION_DAY_CSV_COLUMNS + 1 }, (_, index) => `c${index}`).join(',')
    expect(() => extractStationDay(header, '2024-11-01', '3329A')).toThrow(/列数/)
  })

  it('rejects an overlong physical row before Papa expands it', () => {
    const csv = `date,hour,type,3329A\n${'x'.repeat(MAX_STATION_DAY_CSV_LINE_CHARS + 1)}`
    expect(() => extractStationDay(csv, '2024-11-01', '3329A')).toThrow(/行长度/)
  })

  it('rejects excessive physical data rows before Papa parses them', () => {
    const csv = [
      'date,hour,type,3329A',
      ...Array.from({ length: MAX_STATION_DAY_CSV_DATA_ROWS + 1 }, () => '20241101,0,SO2,1'),
    ].join('\n')
    expect(() => extractStationDay(csv, '2024-11-01', '3329A')).toThrow(/数据行/)
  })

  it('accepts quoted auxiliary headers with commas and quoted CRLF data', () => {
    const result = extractStationDay(
      [
        'date,hour,type,3329A,"source,detail"',
        '20241101,0,SO2,3,"first line\r\nsecond line"',
      ].join('\r\n'),
      '2024-11-01',
      '3329A',
    )

    expect(result.rows).toEqual([{ timestamp: '2024-11-01 00:00:00', SO2: 3 }])
  })

  it('does not count quoted newlines as separate records', () => {
    const csv = [
      'date,hour,type,3329A,note',
      `20241101,0,SO2,3,"${'\n'.repeat(MAX_STATION_DAY_CSV_DATA_ROWS + 1)}"`,
    ].join('\n')

    expect(extractStationDay(csv, '2024-11-01', '3329A').rows).toEqual([
      { timestamp: '2024-11-01 00:00:00', SO2: 3 },
    ])
  })

  it('rejects quoted empty headers and unterminated quotes with actionable errors', () => {
    expect(() => extractStationDay('date,hour,type,3329A,""\n20241101,0,SO2,3,', '2024-11-01', '3329A')).toThrow(
      /表头/,
    )
    expect(() => extractStationDay('date,hour,type,3329A\n20241101,0,SO2,"unterminated', '2024-11-01', '3329A')).toThrow(
      /引号/,
    )
  })

  it('keeps the six conventional subset and every source data type while preserving zeros', () => {
    const result = extractStationDay(
      [
        'date,hour,type,3329A',
        '20241101,2,SO2,0',
        '20241101,2,SO2_24h,30',
        '20241101,2,AQI,80',
        '20241101,2,temperature,12',
      ].join('\n'),
      '2024-11-01',
      '3329A',
    )

    expect(result.rows).toEqual([{ timestamp: '2024-11-01 02:00:00', SO2: 0 }])
    expect(result.allRows).toEqual([
      {
        timestamp: '2024-11-01 02:00:00',
        values: { SO2: 0, SO2_24h: 30, AQI: 80, temperature: 12 },
      },
    ])
    expect(result.warningTotal).toBe(0)
  })

  it('uses the first finite duplicate and permits a later finite replacement', () => {
    const result = extractStationDay(
      [
        'date,hour,type,3329A',
        '20241101,4,SO2,bad',
        '20241101,4,SO2,9',
        '20241101,4,SO2,12',
      ].join('\n'),
      '2024-11-01',
      '3329A',
    )

    expect(result.rows).toEqual([{ timestamp: '2024-11-01 04:00:00', SO2: 9 }])
    expect(result.warningTotal).toBe(3)
  })

  it('treats blank measurements as missing and invalid measurements as warnings', () => {
    const result = extractStationDay(
      ['date,hour,type,3329A', '20241101,1,SO2,', '20241101,2,NO2,not-a-number'].join('\n'),
      '2024-11-01',
      '3329A',
    )

    expect(result.rows).toEqual([
      { timestamp: '2024-11-01 01:00:00' },
      { timestamp: '2024-11-01 02:00:00' },
    ])
    expect(result.warningTotal).toBe(1)
  })

  it('treats Infinity and NaN as invalid measurements without leaking state between calls', () => {
    const invalid = extractStationDay(
      ['date,hour,type,3329A', '20241101,1,SO2,Infinity', '20241101,2,NO2,NaN'].join('\n'),
      '2024-11-01',
      '3329A',
    )
    const valid = extractStationDay('date,hour,type,3329A\n20241101,1,SO2,1', '2024-11-01', '3329A')

    expect(invalid.rows).toEqual([
      { timestamp: '2024-11-01 01:00:00' },
      { timestamp: '2024-11-01 02:00:00' },
    ])
    expect(invalid.warningTotal).toBe(2)
    expect(valid).toMatchObject({
      rows: [{ timestamp: '2024-11-01 01:00:00', SO2: 1 }],
      warnings: [],
      warningTotal: 0,
    })
  })
})

describe('station-day protocol constants', () => {
  it('uses the bounded upstream size and exact station ID format', () => {
    expect(MAX_UPSTREAM_CSV_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_STATION_DAY_CSV_COLUMNS).toBeGreaterThan(300)
    expect(MAX_STATION_DAY_CSV_LINE_CHARS).toBeGreaterThan(0)
    expect(MAX_STATION_DAY_CSV_DATA_ROWS).toBeGreaterThan(0)
    expect(STATION_ID_PATTERN.test('3329A')).toBe(true)
    expect(STATION_ID_PATTERN.test('3329a')).toBe(false)
  })
})
