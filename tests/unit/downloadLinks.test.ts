import { describe, expect, it } from 'vitest'

import { buildDownloadLinks } from '../../src/core/downloadLinks'

describe('buildDownloadLinks', () => {
  it('builds one deterministic link for every day in an inclusive range', () => {
    expect(buildDownloadLinks('2024-11-01', '2024-11-03')).toEqual([
      {
        date: '2024-11-01',
        filename: 'china_sites_20241101.csv',
        url: 'https://quotsoft.net/air/data/china_sites_20241101.csv',
      },
      {
        date: '2024-11-02',
        filename: 'china_sites_20241102.csv',
        url: 'https://quotsoft.net/air/data/china_sites_20241102.csv',
      },
      {
        date: '2024-11-03',
        filename: 'china_sites_20241103.csv',
        url: 'https://quotsoft.net/air/data/china_sites_20241103.csv',
      },
    ])
  })

  it('builds exactly one link for a same-day range', () => {
    expect(buildDownloadLinks('2024-11-01', '2024-11-01')).toEqual([
      {
        date: '2024-11-01',
        filename: 'china_sites_20241101.csv',
        url: 'https://quotsoft.net/air/data/china_sites_20241101.csv',
      },
    ])
  })

  it('includes leap day in a range', () => {
    expect(buildDownloadLinks('2024-02-28', '2024-03-01').map(({ date }) => date)).toEqual([
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ])
  })

  it('allows an inclusive range of exactly 366 days', () => {
    const links = buildDownloadLinks('2024-01-01', '2024-12-31')

    expect(links).toHaveLength(366)
    expect(links.at(0)?.date).toBe('2024-01-01')
    expect(links.at(-1)?.date).toBe('2024-12-31')
  })

  it('rejects an inclusive range longer than 366 days before generating links', () => {
    expect(() => buildDownloadLinks('2024-01-01', '2025-01-01')).toThrow(
      '单次最多生成366天的下载链接，请缩短日期范围',
    )
  })

  it('rejects a reversed range with a user-facing Chinese error', () => {
    expect(() => buildDownloadLinks('2024-11-03', '2024-11-01')).toThrow(
      '结束日期不能早于开始日期',
    )
  })

  it('rejects an impossible calendar date instead of rolling it over', () => {
    expect(() => buildDownloadLinks('2024-02-30', '2024-03-01')).toThrow(
      '请输入有效的日历日期',
    )
  })

  it('rejects an invalid end date', () => {
    expect(() => buildDownloadLinks('2024-02-01', '2024-02-30')).toThrow(
      '请输入有效的日历日期',
    )
  })

  it('rejects February 29 in a non-leap year', () => {
    expect(() => buildDownloadLinks('2023-02-29', '2023-03-01')).toThrow(
      '请输入有效的日历日期',
    )
  })

  it('iterates correctly across a month and year transition', () => {
    expect(buildDownloadLinks('2024-12-31', '2025-01-01').map(({ date }) => date)).toEqual([
      '2024-12-31',
      '2025-01-01',
    ])
  })

  it('rejects years before 1000 explicitly', () => {
    expect(() => buildDownloadLinks('0099-01-01', '0099-01-02')).toThrow(
      '请输入有效的日历日期',
    )
  })

  it.each(['2024/11/01', '2024-1-01', 'not-a-date'])(
    'rejects malformed date input: %s',
    (input) => {
      expect(() => buildDownloadLinks(input, '2024-11-03')).toThrow(
        '日期格式必须为 YYYY-MM-DD',
      )
    },
  )
})
