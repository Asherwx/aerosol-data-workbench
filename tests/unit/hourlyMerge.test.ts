import { describe, expect, it } from 'vitest'

import {
  MAX_MERGE_ROWS,
  MERGE_WARNING_LIMIT,
  UNMATCHED_TIMESTAMP_SAMPLE_LIMIT,
  mergeHourly,
  mergeUserHourly,
} from '../../src/core/hourlyMerge'
import type { IonRow } from '../../src/core/ionMatrix'
import type { StationSeriesRow } from '../../src/core/stationSeries'
import type { ParsedUserDataset } from '../../src/core/userDataset'

function station(
  timestamp: string,
  values: Partial<StationSeriesRow> = {},
): StationSeriesRow {
  return {
    timestamp,
    missing: [],
    status: '完整',
    ...values,
  }
}

describe('mergeHourly', () => {
  it('uses exact canonical timestamps and station order as the authoritative timeline', () => {
    const result = mergeHourly(
      [station('2024-11-01 01:00:00', { SO2: 2 }), station('2024-11-01 00:00:00', { SO2: 1 })],
      [
        { timestamp: '2024-11-01 00:00:00', NO3: 10, SO4: 20, NH4: 30 },
        { timestamp: '2024-11-01 01:00:00', NO3: 11 },
      ],
    )

    expect(result.rows.map((row) => row.timestamp)).toEqual([
      '2024-11-01 01:00:00',
      '2024-11-01 00:00:00',
    ])
    expect(result.rows[0]).toMatchObject({ SO2: 2, NO3: 11 })
    expect(result.rows[1]).toMatchObject({ SO2: 1, NO3: 10, SO4: 20, NH4: 30 })
    expect(result.warnings).toEqual([])
    expect(result.unmatchedIonTimestamps).toEqual([])
  })

  it('keeps station rows without ion matches and preserves zero and undefined ion fields', () => {
    const result = mergeHourly(
      [station('2024-11-01 00:00:00', { SO2: 0 }), station('2024-11-01 01:00:00')],
      [{ timestamp: '2024-11-01 00:00:00', NO3: 0, SO4: undefined }],
    )

    expect(result.rows[0]?.SO2).toBe(0)
    expect(result.rows[0]?.NO3).toBe(0)
    expect(result.rows[0]).not.toHaveProperty('SO4')
    expect(result.rows[1]).not.toHaveProperty('NO3')
  })

  it('does not silently add ion-only timestamps and reports their count and timestamps', () => {
    const result = mergeHourly(
      [station('2024-11-01 00:00:00')],
      [
        { timestamp: '2024-11-01 02:00:00', NO3: 3 },
        { timestamp: '2024-11-01 01:00:00', NO3: 2 },
      ],
    )

    expect(result.rows).toHaveLength(1)
    expect(result.unmatchedIonTimestamps).toEqual([
      '2024-11-01 02:00:00',
      '2024-11-01 01:00:00',
    ])
    expect(result.warnings).toContain(
      '有 2 个离子小时未匹配站点时间线，未加入合并结果：2024-11-01 02:00:00、2024-11-01 01:00:00',
    )
  })

  it('reports one unmatched hour after consolidating duplicate ion rows', () => {
    const result = mergeHourly(
      [station('2024-11-01 00:00:00')],
      [
        { timestamp: '2024-11-01 01:00:00', NO3: 1 },
        { timestamp: '2024-11-01 01:00:00', SO4: 2 },
      ],
    )

    expect(result.unmatchedIonTimestamps).toEqual(['2024-11-01 01:00:00'])
    expect(result.warnings).toContain(
      '有 1 个离子小时未匹配站点时间线，未加入合并结果：2024-11-01 01:00:00',
    )
  })

  it('merges complementary and equal duplicate ion rows without conflict warnings', () => {
    const result = mergeHourly(
      [station('2024-11-01 00:00:00')],
      [
        { timestamp: '2024-11-01 00:00:00', NO3: 1 },
        { timestamp: '2024-11-01 00:00:00', SO4: 2, NO3: 1 },
      ],
    )

    expect(result.rows[0]).toMatchObject({ NO3: 1, SO4: 2 })
    expect(result.warnings).toEqual([])
  })

  it('retains the first finite value for conflicting duplicate ions and warns', () => {
    const result = mergeHourly(
      [station('2024-11-01 00:00:00')],
      [
        { timestamp: '2024-11-01 00:00:00', NO3: 1 },
        { timestamp: '2024-11-01 00:00:00', NO3: 9 },
      ],
    )

    expect(result.rows[0]?.NO3).toBe(1)
    expect(result.warnings).toEqual([
      '离子时间 2024-11-01 00:00:00 的 NO3 (μg/m³) 重复且冲突；保留首个有限值 1，忽略 9',
    ])
  })

  it.each([
    {
      name: 'nonfinite then finite',
      first: Number.NaN,
      second: 5,
      expected: 5,
    },
    {
      name: 'finite then nonfinite',
      first: 5,
      second: Number.POSITIVE_INFINITY,
      expected: 5,
    },
    {
      name: 'differing nonfinite values',
      first: Number.NaN,
      second: Number.POSITIVE_INFINITY,
      expected: Number.NaN,
    },
  ])('warns for supplied duplicate $name values and applies explicit precedence', ({ first, second, expected }) => {
    const result = mergeHourly(
      [station('2024-11-01 00:00:00')],
      [
        { timestamp: '2024-11-01 00:00:00', NO3: first },
        { timestamp: '2024-11-01 00:00:00', NO3: second },
      ],
    )

    expect(Object.is(result.rows[0]?.NO3, expected)).toBe(true)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('NO3 (μg/m³)')
    expect(result.warnings[0]).toContain('重复且冲突')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'silently accepts duplicate values equal by Object.is: %s',
    (value) => {
      const result = mergeHourly(
        [station('2024-11-01 00:00:00')],
        [
          { timestamp: '2024-11-01 00:00:00', NO3: value },
          { timestamp: '2024-11-01 00:00:00', NO3: value },
        ],
      )

      expect(Object.is(result.rows[0]?.NO3, value)).toBe(true)
      expect(result.warnings).toEqual([])
    },
  )

  it('treats absent and explicitly undefined ion properties as missing, allowing a later finite value', () => {
    const result = mergeHourly(
      [station('2024-11-01 00:00:00')],
      [
        { timestamp: '2024-11-01 00:00:00' },
        { timestamp: '2024-11-01 00:00:00', NO3: undefined },
        { timestamp: '2024-11-01 00:00:00', NO3: 0 },
      ],
    )

    expect(result.rows[0]?.NO3).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it('rejects invalid station timestamps and skips invalid ion timestamps with an actionable warning', () => {
    expect(() => mergeHourly([station('2024-11-01T00:00:00')], [])).toThrow(
      '站点小时数据时间无效：2024-11-01T00:00:00；应为 YYYY-MM-DD HH:00:00 的有效整点',
    )

    const result = mergeHourly(
      [station('2024-11-01 00:00:00')],
      [{ timestamp: '2024-02-30 00:00:00', NO3: 1 }],
    )
    expect(result.warnings).toEqual([
      '离子小时数据时间无效：2024-02-30 00:00:00；已跳过，请改为 YYYY-MM-DD HH:00:00 的有效整点',
    ])
  })

  it('does not mutate or alias station rows, nested missing arrays, or ion rows', () => {
    const stationRows = [station('2024-11-01 00:00:00', { SO2: 1, missing: ['NO2'] })]
    const ionRows: IonRow[] = [{ timestamp: '2024-11-01 00:00:00', NO3: 2 }]
    const stationSnapshot = structuredClone(stationRows)
    const ionSnapshot = structuredClone(ionRows)

    const first = mergeHourly(stationRows, ionRows)
    first.rows[0]!.SO2 = 99
    first.rows[0]!.NO3 = 88
    first.rows[0]!.missing.push('O3')
    const second = mergeHourly(stationRows, ionRows)

    expect(stationRows).toEqual(stationSnapshot)
    expect(ionRows).toEqual(ionSnapshot)
    expect(first.rows[0]).not.toBe(stationRows[0])
    expect(first.rows[0]?.missing).not.toBe(stationRows[0]?.missing)
    expect(second.rows[0]).toMatchObject({ SO2: 1, NO3: 2, missing: ['NO2'] })
  })

  it('caps detailed warnings and ends with an auditable suppression summary', () => {
    const invalidRows = Array.from({ length: MERGE_WARNING_LIMIT + 1 }, (_, index) => ({
      timestamp: `invalid-${index}`,
      NO3: index,
    }))

    const result = mergeHourly([station('2024-11-01 00:00:00')], invalidRows)

    expect(result.warnings).toHaveLength(MERGE_WARNING_LIMIT)
    expect(result.warnings.at(-1)).toBe(
      `合并警告共 ${MERGE_WARNING_LIMIT + 1} 条，仅显示前 ${MERGE_WARNING_LIMIT - 1} 条；已省略 2 条`,
    )
  })

  it('bounds the timestamp sample in the unmatched aggregate warning but returns every distinct timestamp', () => {
    const ionRows = Array.from(
      { length: UNMATCHED_TIMESTAMP_SAMPLE_LIMIT + 2 },
      (_, index) => ({
        timestamp: `2024-11-01 ${String(index + 1).padStart(2, '0')}:00:00`,
        NO3: index,
      }),
    )

    const result = mergeHourly([station('2024-11-01 00:00:00')], ionRows)

    expect(result.unmatchedIonTimestamps).toHaveLength(UNMATCHED_TIMESTAMP_SAMPLE_LIMIT + 2)
    expect(result.warnings.at(-1)).toContain(
      `有 ${UNMATCHED_TIMESTAMP_SAMPLE_LIMIT + 2} 个离子小时未匹配站点时间线`,
    )
    expect(result.warnings.at(-1)).toContain('仅显示前')
    expect(result.warnings.at(-1)).not.toContain(
      result.unmatchedIonTimestamps[UNMATCHED_TIMESTAMP_SAMPLE_LIMIT],
    )
  })

  it('rejects oversized station and ion inputs before merge allocation', () => {
    const stationRow = station('2024-11-01 00:00:00')
    const ionRow = { timestamp: '2024-11-01 00:00:00', NO3: 1 }

    expect(() => mergeHourly(Array(MAX_MERGE_ROWS + 1).fill(stationRow), [])).toThrow(
      `站点小时数据行数 ${MAX_MERGE_ROWS + 1} 超过安全上限 ${MAX_MERGE_ROWS}`,
    )
    expect(() => mergeHourly([], Array(MAX_MERGE_ROWS + 1).fill(ionRow))).toThrow(
      `离子小时数据行数 ${MAX_MERGE_ROWS + 1} 超过安全上限 ${MAX_MERGE_ROWS}`,
    )
  })

  it('handles a full leap-year hourly workflow with one output row per station hour', () => {
    const stationRows = Array.from({ length: MAX_MERGE_ROWS }, (_, index) => {
      const date = new Date(Date.UTC(2024, 0, 1, index))
      const timestamp = date.toISOString().replace('T', ' ').slice(0, 13) + ':00:00'
      return station(timestamp)
    })

    const ionRows = stationRows.map((item, index) => ({
      timestamp: item.timestamp,
      NO3: index,
    }))
    const result = mergeHourly(stationRows, ionRows)

    expect(result.rows).toHaveLength(366 * 24)
    expect(result.rows[0]?.timestamp).toBe('2024-01-01 00:00:00')
    expect(result.rows.at(-1)?.timestamp).toBe('2024-12-31 23:00:00')
    expect(result.rows.at(-1)?.NO3).toBe(MAX_MERGE_ROWS - 1)
    expect(result.unmatchedIonTimestamps).toEqual([])
  })
})

describe('mergeUserHourly', () => {
  const variables: ParsedUserDataset['variables'] = [
    { key: 'dust', label: 'Dust', unit: 'ug/m3', nonNegative: true, sourceColumn: 1 },
    { key: 'temperature', label: 'Temperature', unit: 'C', nonNegative: false, sourceColumn: 2 },
  ]

  function dataset(rows: ParsedUserDataset['rows']): ParsedUserDataset {
    return { rows, variables, warnings: [], warningTotal: 0, sheetName: 'Data' }
  }

  it('keeps the station timeline authoritative and stores user values only in a nested record', () => {
    const result = mergeUserHourly([
      station('2024-11-01 01:00:00', { SO2: 2 }),
      station('2024-11-01 00:00:00', { SO2: 1 }),
    ], dataset([
      { timestamp: '2024-11-01 00:00:00', values: { dust: 3 } },
      { timestamp: '2024-11-01 02:00:00', values: { dust: 9 } },
    ]))

    expect(result.rows.map(({ timestamp }) => timestamp)).toEqual([
      '2024-11-01 01:00:00', '2024-11-01 00:00:00',
    ])
    expect(result.rows[0]).toMatchObject({ SO2: 2, userValues: {} })
    expect(result.rows[1]).toMatchObject({ SO2: 1, userValues: { dust: 3 } })
    expect(result.rows[1]).not.toHaveProperty('dust')
    expect(result.unmatchedUserTimestamps).toEqual(['2024-11-01 02:00:00'])
    expect(result.unmatchedUserTimestampCount).toBe(1)
    expect(result.warnings.join(' ')).toMatch(/1.*unmatched user/i)
  })

  it('defensively consolidates duplicates with finite precedence and stable provenance warnings', () => {
    const result = mergeUserHourly([station('2024-11-01 00:00:00')], dataset([
      { timestamp: '2024-11-01 00:00:00', values: { dust: Number.NaN } },
      { timestamp: '2024-11-01 00:00:00', values: { dust: 2 } },
      { timestamp: '2024-11-01 00:00:00', values: { dust: 7, temperature: -4 } },
      { timestamp: '2024-11-01 00:00:00', values: { temperature: -4 } },
    ]))

    expect(result.rows[0]?.userValues).toEqual({ dust: 2, temperature: -4 })
    expect(result.warnings).toHaveLength(2)
    expect(result.warningTotal).toBe(2)
    expect(result.warnings[0]).toMatch(/2024-11-01 00:00:00.*dust.*Dust.*ug\/m3.*finite.*2.*NaN/i)
    expect(result.warnings[1]).toMatch(/2024-11-01 00:00:00.*dust.*Dust.*ug\/m3.*first finite.*2.*7/i)
  })

  it('warns in both finite/nonfinite duplicate directions and explains the resolution', () => {
    const result = mergeUserHourly([
      station('2024-11-01 00:00:00'), station('2024-11-01 01:00:00'),
    ], dataset([
      { timestamp: '2024-11-01 00:00:00', values: { dust: Number.NaN } },
      { timestamp: '2024-11-01 00:00:00', values: { dust: 4 } },
      { timestamp: '2024-11-01 01:00:00', values: { dust: 5 } },
      { timestamp: '2024-11-01 01:00:00', values: { dust: Number.POSITIVE_INFINITY } },
    ]))

    expect(result.rows.map((item) => item.userValues.dust)).toEqual([4, 5])
    expect(result.warningTotal).toBe(2)
    expect(result.warnings[0]).toMatch(/00:00:00.*dust.*ug\/m3.*finite.*4.*NaN/i)
    expect(result.warnings[1]).toMatch(/01:00:00.*dust.*ug\/m3.*finite.*5.*Infinity/i)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'keeps Object.is-equal supplied nonfinite duplicates silent while undefined remains missing: %s',
    (value) => {
      const result = mergeUserHourly([station('2024-11-01 00:00:00')], dataset([
        { timestamp: '2024-11-01 00:00:00', values: { dust: undefined } },
        { timestamp: '2024-11-01 00:00:00', values: { dust: value } },
        { timestamp: '2024-11-01 00:00:00', values: { dust: value } },
      ]))

      expect(Object.is(result.rows[0]?.userValues.dust, value)).toBe(true)
      expect(result.warnings).toEqual([])
      expect(result.warningTotal).toBe(0)
    },
  )

  it('ignores prototype keys and deeply clones station and user inputs', () => {
    const values = Object.create(null) as Record<string, number>
    values.dust = 3
    values.__proto__ = 99
    Object.defineProperty(values, 'constructor', { value: 88, enumerable: true })
    const stationRows = [station('2024-11-01 00:00:00', { missing: ['NO2'] })]
    const user = dataset([{ timestamp: '2024-11-01 00:00:00', values }])
    const stationSnapshot = structuredClone(stationRows)

    const result = mergeUserHourly(stationRows, user)
    expect(result.rows[0]?.userValues).toEqual({ dust: 3 })
    expect(Object.getPrototypeOf(result.rows[0]!.userValues)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(result.rows[0]!.userValues, '__proto__')).toBe(false)
    result.rows[0]!.missing.push('O3')
    result.rows[0]!.userValues.dust = 10
    expect(stationRows).toEqual(stationSnapshot)
    expect(user.rows[0]?.values.dust).toBe(3)
  })

  it('rejects invalid/duplicate station hours and bounds inputs and unmatched samples', () => {
    expect(() => mergeUserHourly([station('2024/11/01')], dataset([]))).toThrow(/canonical/i)
    expect(() => mergeUserHourly([station('2024-11-01 00:00:00'), station('2024-11-01 00:00:00')], dataset([]))).toThrow(/duplicate/i)
    expect(() => mergeUserHourly(Array(MAX_MERGE_ROWS + 1).fill(station('2024-11-01 00:00:00')), dataset([]))).toThrow(/8784/)

    const unmatched = Array.from({ length: UNMATCHED_TIMESTAMP_SAMPLE_LIMIT + 2 }, (_, index) => ({
      timestamp: `2024-11-${String(index + 2).padStart(2, '0')} 00:00:00`, values: { dust: index },
    }))
    const result = mergeUserHourly([station('2024-11-01 00:00:00')], dataset(unmatched))
    expect(result.unmatchedUserTimestampCount).toBe(unmatched.length)
    expect(result.unmatchedUserTimestamps).toHaveLength(unmatched.length)
    expect(result.warnings.at(-1)).not.toContain(unmatched[UNMATCHED_TIMESTAMP_SAMPLE_LIMIT].timestamp)
  })
})
