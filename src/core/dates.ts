const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function assertValidDate(date: Date): void {
  if (Number.isNaN(date.getTime())) {
    throw new Error('日期对象无效')
  }

  if (date.getUTCFullYear() < 1000) {
    throw new Error('请输入有效的日历日期')
  }
}

function toUtcMidnight(date: Date): Date {
  assertValidDate(date)
  const normalized = new Date(date.getTime())
  normalized.setUTCHours(0, 0, 0, 0)
  return normalized
}

function createUtcDate(year: number, month: number, day: number): Date {
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return date
}

export function parseIsoDateStrict(value: string): Date {
  const match = ISO_DATE_PATTERN.exec(value)

  if (!match) {
    throw new Error('日期格式必须为 YYYY-MM-DD')
  }

  const [, yearPart, monthPart, dayPart] = match
  const year = Number(yearPart)
  const month = Number(monthPart)
  const day = Number(dayPart)
  const date = createUtcDate(year, month, day)

  if (
    year < 1000 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error('请输入有效的日历日期')
  }

  return date
}

export function formatUtcDate(date: Date): string {
  assertValidDate(date)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function* iterateUtcDaysInclusive(start: Date, end: Date): Generator<Date> {
  const cursor = toUtcMidnight(start)
  const normalizedEnd = toUtcMidnight(end)

  while (cursor.getTime() <= normalizedEnd.getTime()) {
    yield new Date(cursor.getTime())
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
}
