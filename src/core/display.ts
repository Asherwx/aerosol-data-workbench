export function boundedDisplay(value: unknown, maxLength = 120): string {
  const sanitized = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (sanitized.length <= maxLength) return sanitized
  return `${sanitized.slice(0, Math.max(0, maxLength - 1))}…`
}
