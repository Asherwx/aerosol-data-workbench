import { formatUtcDate, iterateUtcDaysInclusive, parseIsoDateStrict } from './dates'
import type { DownloadLink } from './types'

const DOWNLOAD_BASE_URL = 'https://quotsoft.net/air/data'
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

export const MAX_DOWNLOAD_RANGE_DAYS = 366

export function buildDownloadLinks(start: string, end: string): DownloadLink[] {
  const startDate = parseIsoDateStrict(start)
  const endDate = parseIsoDateStrict(end)

  if (endDate.getTime() < startDate.getTime()) {
    throw new Error('结束日期不能早于开始日期')
  }

  const inclusiveDayCount =
    (endDate.getTime() - startDate.getTime()) / MILLISECONDS_PER_DAY + 1

  if (inclusiveDayCount > MAX_DOWNLOAD_RANGE_DAYS) {
    throw new Error('单次最多生成366天的下载链接，请缩短日期范围')
  }

  return Array.from(iterateUtcDaysInclusive(startDate, endDate), (date) => {
    const formattedDate = formatUtcDate(date)
    const compactDate = formattedDate.replaceAll('-', '')
    const filename = `china_sites_${compactDate}.csv`

    return {
      date: formattedDate,
      filename,
      url: `${DOWNLOAD_BASE_URL}/${filename}`,
    }
  })
}
