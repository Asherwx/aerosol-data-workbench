import Papa from 'papaparse'
import { describe, expect, it, vi } from 'vitest'
import {
  USER_DATA_MAX_ROWS,
  USER_DATA_MAX_PHYSICAL_ROWS,
  MAX_USER_CELL_CHARS,
  MAX_USER_CELLS,
  MAX_USER_ROW_CELLS,
  USER_DATA_WARNING_CAP,
  assertUserMatrixBudgets,
  parseUserCsv,
  parseUserMatrix,
  type UserDataMapping,
} from '../../src/core/userDataset'

const explicitMapping: UserDataMapping = {
  timestampColumn: 0,
  variables: [
    { key: 'pm25', label: 'PM2.5', unit: 'µg/m³', nonNegative: true, sourceColumn: 1 },
    { key: 'temperature', label: 'Temperature', unit: '°C', nonNegative: false, sourceColumn: 2 },
  ],
}

describe('parseUserCsv and parseUserMatrix', () => {
  it('parses BOM, CRLF and quoted CSV into canonical generic rows', () => {
    const result = parseUserCsv(
      '\uFEFFdatetime,"PM2.5, corrected",Temperature\r\nunits,µg/m³,°C\r\n2024-01-01 00:00,"1.5",-2\r\n',
      'sample.csv',
    )
    expect(result.mappingRequired).toBeUndefined()
    expect(result.rows).toEqual([
      { timestamp: '2024-01-01 00:00:00', values: { pm2_5_corrected: 1.5, temperature: -2 } },
    ])
    expect(result.variables.map(({ key, unit }) => ({ key, unit }))).toEqual([
      { key: 'pm2_5_corrected', unit: 'µg/m³' },
      { key: 'temperature', unit: '°C' },
    ])
  })

  it('does not guess when multiple common time aliases exist', () => {
    const result = parseUserMatrix([
      ['time', 'datetime', 'PM10'],
      ['2024-01-01 00:00', '2024-01-01 00:00', 1],
    ], 'ambiguous.csv')
    expect(result.rows).toEqual([])
    expect(result.mappingRequired).toMatchObject({ timeCandidates: [0, 1] })
    expect(result.mappingRequired?.columns).toHaveLength(3)
  })

  it('counts quoted multiline CSV fields as one logical row', () => {
    const result = parseUserCsv(
      'time,"PM2.5\ncorrected"\r\n2024-01-01 00:00,1\r\n',
      'multiline.csv',
    )
    expect(result.variables[0]?.label).toBe('PM2.5 corrected')
    expect(result.rows).toEqual([
      { timestamp: '2024-01-01 00:00:00', values: { pm2_5_corrected: 1 } },
    ])
  })

  it('accepts explicit mapping, clones it, and merges complementary duplicates', () => {
    const mapping = structuredClone(explicitMapping)
    const matrix = [
      ['when', 'dust', 'temp'],
      ['2024-01-01 00:00', 2, ''],
      ['2024-01-01 00:00', 2, -4],
      ['2024-01-01 00:00', 3, -4],
    ]
    const result = parseUserMatrix(matrix, 'mapped.csv', 'Data', mapping)
    expect(result.rows).toEqual([
      { timestamp: '2024-01-01 00:00:00', values: { pm25: 2, temperature: -4 } },
    ])
    expect(result.warnings.join('\n')).toMatch(/conflict.*pm25.*first finite/i)
    expect(mapping).toEqual(explicitMapping)
    expect(matrix[1]?.[1]).toBe(2)
  })

  it('combines adjacent name and unit header rows and warns on unknown units', () => {
    const result = parseUserMatrix([
      ['Timestamp', 'NO3', 'Wind'],
      ['', 'µg/m³', 'furlongs/fortnight'],
      ['2024-01-01 01:00', 1, 2],
    ], 'headers.xlsx')
    expect(result.variables.map((item) => item.unit)).toEqual(['µg/m³', 'furlongs/fortnight'])
    expect(result.warnings.join('\n')).toMatch(/unknown unit.*furlongs/i)
  })

  it('combines variable names split across adjacent header rows', () => {
    const result = parseUserMatrix([
      ['time', 'PM2.5', ''],
      ['', 'µg/m³', 'PM10'],
      ['2024-01-01 00:00', 1, 2],
    ], 'split.csv')
    expect(result.variables.map(({ key, unit }) => ({ key, unit }))).toEqual([
      { key: 'pm2_5', unit: 'µg/m³' },
      { key: 'pm10', unit: '' },
    ])
    expect(result.rows[0]?.values).toEqual({ pm2_5: 1, pm10: 2 })
  })

  it('treats formula-like headers as sanitized text and creates safe keys', () => {
    const result = parseUserMatrix([
      ['time', '=HYPERLINK("bad")', '__proto__'],
      ['2024-01-01 00:00', 1, 2],
    ], 'formula.csv')
    expect(result.variables[0]?.label).toBe("'=HYPERLINK(\"bad\")")
    expect(result.variables.every(({ key }) => /^[a-z][a-z0-9_]*$/.test(key))).toBe(true)
    expect(result.variables.map(({ key }) => key)).not.toContain('__proto__')
    expect(Object.getPrototypeOf(result.rows[0]?.values)).toBe(Object.prototype)
  })

  it('parses Date cells and Excel serials as timezone-neutral wall-clock hours', () => {
    const result = parseUserMatrix([
      ['time', 'x'],
      [new Date(Date.UTC(2024, 6, 1, 8)), 1],
      [45474 + 9 / 24, 2],
    ], 'wall-clock.xlsx')
    expect(result.rows.map((row) => row.timestamp)).toEqual([
      '2024-07-01 08:00:00',
      '2024-07-01 09:00:00',
    ])
  })

  it('uses the Excel 1900 date system and rejects its phantom serial day', () => {
    const result = parseUserMatrix([
      ['time', 'x'],
      [1, 1],
      [59 + 1 / 24, 2],
      [60, 3],
      [61 + 2 / 24, 4],
    ], 'excel-1900.xlsx')
    expect(result.rows).toEqual([
      { timestamp: '1900-01-01 00:00:00', values: { x: 1 } },
      { timestamp: '1900-02-28 01:00:00', values: { x: 2 } },
      { timestamp: '1900-03-01 02:00:00', values: { x: 4 } },
    ])
    expect(result.warnings.join('\n')).toMatch(/serial 60|invalid timestamp/i)
  })

  it('skips non-hour, invalid, and non-finite cells deterministically', () => {
    const result = parseUserMatrix([
      ['time', 'x'],
      ['2024-01-01 00:30', 1],
      ['bad', 2],
      ['2024-01-01 01:00', 'Infinity'],
    ], 'invalid.csv')
    expect(result.rows).toEqual([{ timestamp: '2024-01-01 01:00:00', values: {} }])
    expect(result.warningTotal).toBe(3)
  })

  it('rejects invalid or duplicate explicit source columns and prototype keys', () => {
    const base = structuredClone(explicitMapping)
    expect(() => parseUserMatrix([['t', 'a', 'b']], 'bad.csv', 'Data', {
      ...base,
      variables: [{ ...base.variables[0], key: '__proto__' }],
    })).toThrow(/key/i)
    expect(() => parseUserMatrix([['t', 'a', 'b']], 'bad.csv', 'Data', {
      ...base,
      variables: [base.variables[0], { ...base.variables[1], sourceColumn: 1 }],
    })).toThrow(/source column.*unique/i)
  })

  it('enforces physical and canonical row/range caps', () => {
    expect(() => parseUserMatrix([
      ['time', 'x'],
      ...Array.from({ length: USER_DATA_MAX_PHYSICAL_ROWS + 1 }, () => ['', '']),
    ], 'huge.csv')).toThrow(/100000/)
    expect(() => parseUserMatrix([
      ['time', 'x'],
      ['2024-01-01 00:00', 1],
      ['2025-01-01 01:00', 2],
    ], 'range.csv')).toThrow(/8784/)
  })

  it('rejects 100001 physical rows before returning missing mapping requirements', () => {
    const matrix = Array.from(
      { length: USER_DATA_MAX_PHYSICAL_ROWS + 1 },
      (_, index) => [`unrecognized-${index}`, index],
    )
    expect(() => parseUserMatrix(matrix, 'missing-cap.csv')).toThrow(/100000.*physical/i)
  })

  it('rejects 100001 data rows before returning ambiguous mapping requirements', () => {
    const matrix = [
      ['time', 'datetime', 'x'],
      ...Array.from({ length: USER_DATA_MAX_PHYSICAL_ROWS + 1 }, () => ['', '', '']),
    ]
    expect(() => parseUserMatrix(matrix, 'ambiguous-cap.csv')).toThrow(/100000.*physical/i)
  })

  it('allows exactly 100000 physical rows after two adjacent header rows', () => {
    const result = parseUserMatrix([
      ['time', 'PM2.5', ''],
      ['', 'µg/m³', 'PM10'],
      ...Array.from({ length: USER_DATA_MAX_PHYSICAL_ROWS }, () => ['', '', '']),
    ], 'split-boundary.csv')
    expect(result.mappingRequired).toBeUndefined()
    expect(result.rows).toEqual([])
  })

  it('caps visible warnings while retaining an auditable total', () => {
    const result = parseUserMatrix([
      ['time', 'x'],
      ...Array.from({ length: USER_DATA_WARNING_CAP + 7 }, (_, index) => [
        `bad-${index}`,
        1,
      ]),
    ], 'warnings.csv')
    expect(result.warnings).toHaveLength(USER_DATA_WARNING_CAP)
    expect(result.warningTotal).toBe(USER_DATA_WARNING_CAP + 7)
    expect(result.warnings.at(-1)).toMatch(/truncated/i)
  })

  it('aborts synchronous CSV decoding before retaining a million tiny rows', () => {
    const csv = `not-a-header,x\n${'a,1\n'.repeat(1_000_000)}`
    const parseSpy = vi.spyOn(Papa, 'parse')
    try {
      expect(() => parseUserCsv(csv, 'million.csv')).toThrow(/100000.*row/i)
      expect(parseSpy.mock.calls[0]?.[1]).toMatchObject({ step: expect.any(Function) })
    } finally {
      parseSpy.mockRestore()
    }
  })

  it('enforces total-cell and single-cell decoding budgets', () => {
    expect(() => assertUserMatrixBudgets([
      ['x'.repeat(MAX_USER_CELL_CHARS + 1)],
    ], 'long-cell.xlsx')).toThrow(/cell.*character/i)

    expect(() => assertUserMatrixBudgets([
      Array.from({ length: MAX_USER_ROW_CELLS + 1 }, () => 1),
    ], 'wide-row.xlsx')).toThrow(/logical row/i)

    const fullRows = Math.floor(MAX_USER_CELLS / 1_000) + 1
    const row = Array.from({ length: 1_000 }, () => 1)
    expect(() => assertUserMatrixBudgets(
      Array.from({ length: fullRows }, () => row),
      'many-cells.xlsx',
    )).toThrow(/total cell/i)
  })
})
