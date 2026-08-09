import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ION_WORKBOOK_MAX_BYTES,
  ION_WORKBOOK_MAX_ROWS,
  ION_WORKBOOK_WARNING_CAP,
  parseIonMatrix,
  parseIonWorkbook,
  parseIonWorkbookSheets,
} from '../../src/core/ionWorkbook'
import { parseIonWorkbookBuffer } from '../../src/workers/parseIonWorkbookBuffer'

describe('parseIonMatrix', () => {
  it('finds a header after metadata and skips an accepted unit row', () => {
    const matrix = [
      ['2024 年水溶性离子'],
      ['导出时间', '2025-01-01'],
      ['日期时间', 'NO₃⁻', 'SO₄²⁻', 'NH₄⁺'],
      ['', 'μg/m³', 'ug/m3', 'ug·m-3'],
      [new Date(Date.UTC(2024, 0, 2, 3)), 0, 2.5, 1],
    ]

    const result = parseIonMatrix(matrix, 'ions.xlsx', '站点数据')

    expect(result).toEqual({
      rows: [{ timestamp: '2024-01-02 03:00:00', NO3: 0, SO4: 2.5, NH4: 1 }],
      sheetName: '站点数据',
      warnings: [],
    })
    expect(matrix[4]?.[1]).toBe(0)
  })

  it('uses UTC fields of Excel Date cells as timezone-neutral workbook wall-clock fields', () => {
    const result = parseIonMatrix(
      [
        ['时间', 'NO3', 'SO4', 'NH4'],
        [new Date(Date.UTC(2024, 6, 1, 8)), 1, 2, 3],
      ],
      'wall-clock.xlsx',
      '数据',
    )
    expect(result.rows[0]?.timestamp).toBe('2024-07-01 08:00:00')
  })

  it.each([
    [['time', 'NO3-', 'SO4²-', 'NH4+']],
    [['datetime', 'NO3_μg_m3', 'SO4_μg_m3', 'NH4_μg_m3']],
    [['日期时间', '硝酸根', '硫酸根', '铵根']],
  ])('recognizes normalized header variants', (header) => {
    const result = parseIonMatrix(
      [header, ['2024/02/03 04:00', 1, 2, 3]],
      'variants.xlsx',
      '数据',
    )
    expect(result.rows).toEqual([
      { timestamp: '2024-02-03 04:00:00', NO3: 1, SO4: 2, NH4: 3 },
    ])
  })

  it('combines a split two-row header and strips Excel newline escapes from unit-bearing ion labels', () => {
    const result = parseIonMatrix(
      [
        ['省份', '时间', null, null, null],
        [null, null, 'NO₃⁻\r\n_x000D_μg/m³', 'SO₄²⁻\r\n_x000D_μg/m³', 'NH₄⁺\r\n_x000D_μg/m³'],
        ['安徽省', '2024-11-01 00:00', 1, 2, 3],
      ],
      'real-layout.xlsx',
      '站点数据',
    )
    expect(result.rows).toEqual([
      { timestamp: '2024-11-01 00:00:00', NO3: 1, SO4: 2, NH4: 3 },
    ])
  })

  it('reports all missing required headers with file, sheet, and action', () => {
    expect(() => parseIonMatrix([['日期时间', 'NO3']], 'missing.xlsx', '数据')).toThrow(
      /missing\.xlsx.*数据.*SO4.*NH4.*请.*表头/s,
    )
  })

  it('preserves zero and negatives, leaves blanks missing, and warns for invalid and negative values', () => {
    const result = parseIonMatrix(
      [
        ['时间', 'NO3', 'SO4', 'NH4'],
        ['2024-01-01 00:00', 0, '', -1],
        ['2024-01-01 01:00', 'bad', null, 4],
      ],
      'values.xlsx',
      '数据',
    )
    expect(result.rows).toEqual([
      { timestamp: '2024-01-01 00:00:00', NO3: 0, NH4: -1 },
      { timestamp: '2024-01-01 01:00:00', NH4: 4 },
    ])
    expect(result.warnings.join('\n')).toMatch(/NH4.*负值.*-1/)
    expect(result.warnings.join('\n')).toMatch(/NO3.*无效.*bad/)
  })

  it('preserves an hourly row when every ion value is blank', () => {
    const result = parseIonMatrix(
      [
        ['时间', 'NO3', 'SO4', 'NH4'],
        ['2024-01-01 02:00', '', null, undefined],
      ],
      'all-missing.xlsx',
      '数据',
    )
    expect(result.rows).toEqual([{ timestamp: '2024-01-01 02:00:00' }])
  })

  it('accepts Chinese date separators but skips invalid calendar and non-hour timestamps', () => {
    const result = parseIonMatrix(
      [
        ['时间', 'NO3', 'SO4', 'NH4'],
        ['2024年2月29日 05时00分', 1, 2, 3],
        ['2023-02-29 05:00', 4, 5, 6],
        ['2024-01-01 05:30', 7, 8, 9],
        ['2024-01-01 06:00:01', 10, 11, 12],
      ],
      'dates.xlsx',
      '数据',
    )
    expect(result.rows).toEqual([
      { timestamp: '2024-02-29 05:00:00', NO3: 1, SO4: 2, NH4: 3 },
    ])
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings.join('\n')).toMatch(/非整点/)
  })

  it('merges complementary duplicates and keeps the first finite conflict', () => {
    const result = parseIonMatrix(
      [
        ['时间', 'NO3', 'SO4', 'NH4'],
        ['2024-01-02 00:00', 1, '', 3],
        ['2024-01-01 00:00', 4, 5, 6],
        ['2024-01-02 00:00', 9, 2, ''],
      ],
      'duplicates.xlsx',
      '数据',
    )
    expect(result.rows).toEqual([
      { timestamp: '2024-01-01 00:00:00', NO3: 4, SO4: 5, NH4: 6 },
      { timestamp: '2024-01-02 00:00:00', NO3: 1, SO4: 2, NH4: 3 },
    ])
    expect(result.warnings.join('\n')).toMatch(/NO3.*重复.*保留首次/)
  })

  it('does not warn when duplicate finite ion values are identical', () => {
    const result = parseIonMatrix(
      [
        ['时间', 'NO3', 'SO4', 'NH4'],
        ['2024-01-01 00:00', 1, 2, 3],
        ['2024-01-01 00:00', 1, 2, 3],
      ],
      'equal-duplicates.xlsx',
      '数据',
    )
    expect(result.rows).toEqual([
      { timestamp: '2024-01-01 00:00:00', NO3: 1, SO4: 2, NH4: 3 },
    ])
    expect(result.warnings).toEqual([])
  })

  it('warns for explicit unexpected units without converting values', () => {
    const result = parseIonMatrix(
      [
        ['时间', 'NO3', 'SO4', 'NH4'],
        ['单位', 'mg/m3', 'μg/m3', 'ug·m-3'],
        ['2024-01-01 00:00', 1, 2, 3],
      ],
      'units.xlsx',
      '数据',
    )
    expect(result.rows[0]?.NO3).toBe(1)
    expect(result.warnings.join('\n')).toMatch(/NO3.*mg\/m3.*μg\/m³/)
  })

  it.each(['μg·m⁻³', 'µg m−3', 'ug/m^3'])(
    'accepts the equivalent ion unit %s without warning',
    (unit) => {
      const result = parseIonMatrix(
        [
          ['时间', 'NO3', 'SO4', 'NH4'],
          ['单位', unit, unit, unit],
          ['2024-01-01 00:00', 1, 2, 3],
        ],
        'equivalent-units.xlsx',
        '数据',
      )
      expect(result.rows).toEqual([
        { timestamp: '2024-01-01 00:00:00', NO3: 1, SO4: 2, NH4: 3 },
      ])
      expect(result.warnings).toEqual([])
    },
  )

  it('requires a header within the first 20 rows', () => {
    const matrix = Array.from({ length: 20 }, () => ['metadata'])
    matrix.push(['时间', 'NO3', 'SO4', 'NH4'])
    expect(() => parseIonMatrix(matrix, 'late.xlsx', '数据')).toThrow(/前 20 行.*表头/)
  })

  it('does not combine header-like metadata spread across unrelated rows', () => {
    const matrix = [
      ['时间', 'exported metadata'],
      ['unrelated'],
      [null, 'NO3'],
      ['unrelated'],
      [null, null, 'SO4'],
      ['unrelated'],
      [null, null, null, 'NH4'],
    ]
    expect(() => parseIonMatrix(matrix, 'metadata.xlsx', '说明')).toThrow(/未找到完整表头/)
  })

  it('rejects more than the configured row cap', () => {
    const matrix = [
      ['时间', 'NO3', 'SO4', 'NH4'],
      ...Array.from({ length: ION_WORKBOOK_MAX_ROWS + 1 }, () => ['', '', '', '']),
    ]
    expect(() => parseIonMatrix(matrix, 'huge.xlsx', '数据')).toThrow(/行数.*上限/)
  })

  it('caps warnings and appends a truncation marker', () => {
    const matrix = [
      ['时间', 'NO3', 'SO4', 'NH4'],
      ...Array.from({ length: ION_WORKBOOK_WARNING_CAP + 5 }, (_, index) => [
        `2024-01-01 00:${String((index % 59) + 1).padStart(2, '0')}`,
        1,
        2,
        3,
      ]),
    ]
    const result = parseIonMatrix(matrix, 'warnings.xlsx', '数据')
    expect(result.warnings).toHaveLength(ION_WORKBOOK_WARNING_CAP)
    expect(result.warnings.at(-1)).toMatch(/其余已截断/)
  })

  it('sanitizes and bounds untrusted names and raw cell values in diagnostics', () => {
    const result = parseIonMatrix(
      [
        ['时间', 'NO3', 'SO4', 'NH4'],
        ['2024-01-01 00:00', `bad\r\n${'x'.repeat(1000)}`, 2, 3],
      ],
      `file\r\n\u202E${'f'.repeat(500)}.xlsx`,
      `sheet\n\u2066${'s'.repeat(500)}`,
    )
    expect(result.warnings[0]).not.toMatch(/[\r\n]/)
    expect(result.warnings[0]).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/i)
    expect(result.warnings[0]?.length).toBeLessThan(600)
    expect(result.warnings[0]).toContain('…')
  })
})

describe('parseIonWorkbook', () => {
  it('reads the small XLSX fixture and prefers 站点数据', async () => {
    const bytes = readFileSync('tests/fixtures/ions-small.xlsx')
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const result = await parseIonWorkbookBuffer(input, 'ions-small.xlsx')
    expect(result.sheetName).toBe('站点数据')
    expect(result).not.toHaveProperty('sheets')
    expect(result).not.toHaveProperty('data')
    expect(result.rows).toEqual([
      { timestamp: '2024-01-02 03:00:00', NO3: 0, SO4: 2.5, NH4: 1 },
    ])
  })

  it('falls back to the first sheet containing all recognized headers', async () => {
    const bytes = readFileSync('tests/fixtures/ions-fallback.xlsx')
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const result = await parseIonWorkbookBuffer(input, 'ions-fallback.xlsx')
    expect(result.sheetName).toBe('有效数据')
  })

  it('skips an invalid preferred sheet, uses the first valid fallback, and warns', () => {
    const result = parseIonWorkbookSheets(
      [
        { sheet: '站点数据', data: [['说明', '无有效表头']] },
        {
          sheet: '有效数据',
          data: [['时间', 'NO3', 'SO4', 'NH4'], ['2024-01-01 00:00', 1, 2, 3]],
        },
      ],
      'fallback.xlsx',
    )
    expect(result.sheetName).toBe('有效数据')
    expect(result.warnings.join('\n')).toMatch(/站点数据.*表头无效.*有效数据/)
  })

  it('rejects oversized input before parsing', async () => {
    await expect(
      parseIonWorkbook(new ArrayBuffer(ION_WORKBOOK_MAX_BYTES + 1), 'oversized.xlsx'),
    ).rejects.toThrow(/文件大小.*25 MiB/)
  })

  it('rejects corrupted non-ZIP input before creating the parser worker', async () => {
    const input = new TextEncoder().encode('not an xlsx').buffer
    await expect(parseIonWorkbook(input, 'broken.xlsx')).rejects.toThrow(
      /broken\.xlsx.*ZIP.*无效.*有效.*XLSX/s,
    )
  })
})
