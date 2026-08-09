import { boundedDisplay } from './display'
import type { UserMergedRow } from './hourlyMerge'
import {
  qualityControlStation,
  type QcFlagCode as StationQcFlagCode,
} from './stationQualityControl'
import type { UserVariableSpec } from './userDataset'

const SAFE_USER_KEY = /^[a-z][a-z0-9_]{0,63}$/
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export type DynamicQcFlagCode = StationQcFlagCode

export interface DynamicStructuredQcFlag {
  code: DynamicQcFlagCode
  variable?: string
  message: string
}

export type DynamicCheckedRow = UserMergedRow & {
  QC_flag: string
  QC_flags: DynamicStructuredQcFlag[]
  QC_keep: boolean
}

export interface DynamicQualityControlResult {
  rows: DynamicCheckedRow[]
  counts: Record<string, number>
  keptRows: DynamicCheckedRow[]
  rejectedRows: DynamicCheckedRow[]
  gaps: string[]
  gapCount: number
  warnings: string[]
}

function displayName(variable: UserVariableSpec): string {
  const sanitize = (value: string, limit: number): string => {
    const text = boundedDisplay(value, limit)
    return /^[=+@-]/.test(text) ? boundedDisplay(`'${text}`, limit) : text
  }
  const label = sanitize(variable.label, 120) || variable.key
  const unit = sanitize(variable.unit, 48)
  return unit ? `${label} (${unit})` : label
}

function clone(row: DynamicCheckedRow): DynamicCheckedRow {
  return {
    ...row,
    missing: [...row.missing],
    userValues: { ...row.userValues },
    QC_flags: row.QC_flags.map((flag) => ({ ...flag })),
  }
}

export function qualityControlDynamic(
  input: readonly UserMergedRow[],
  variableSpecs: readonly UserVariableSpec[],
): DynamicQualityControlResult {
  const stationResult = qualityControlStation(input)
  if (variableSpecs.length > 1_000) throw new Error('User variable count exceeds safe limit 1000')
  const variables: UserVariableSpec[] = []
  const seen = new Set<string>()
  for (const variable of variableSpecs) {
    if (!SAFE_USER_KEY.test(variable.key) || PROTOTYPE_KEYS.has(variable.key) || seen.has(variable.key)
      || !Number.isInteger(variable.sourceColumn) || variable.sourceColumn < 0 || variable.sourceColumn >= 1_000) {
      throw new Error(`Invalid or duplicate user variable key: ${boundedDisplay(variable.key)}`)
    }
    seen.add(variable.key)
    variables.push({ ...variable, label: boundedDisplay(variable.label, 120), unit: boundedDisplay(variable.unit, 48) })
  }

  const counts: Record<string, number> = { '\u6b63\u5e38': 0 }
  const rows = stationResult.rows.map((stationRow, index): DynamicCheckedRow => {
    const source = input[index]
    const flags: DynamicStructuredQcFlag[] = stationRow.QC_flags.map((flag) => ({ ...flag }))
    for (const variable of variables) {
      const value = source.userValues[variable.key]
      const name = displayName(variable)
      if (value === undefined) {
        flags.push({ code: 'missing', variable: variable.key, message: `\u7f3a\u5931\uff1a${name}` })
      } else if (!Number.isFinite(value)) {
        flags.push({ code: 'nonfinite', variable: variable.key, message: `\u975e\u6709\u9650\u503c\uff1a${name}` })
      } else if (variable.nonNegative === true && value < 0) {
        flags.push({ code: 'negative', variable: variable.key, message: `\u8d1f\u503c\uff1a${name}` })
      }
    }
    const QC_flag = flags.length === 0 ? '\u6b63\u5e38' : flags.map(({ message }) => message).join('\uff1b')
    if (flags.length === 0) counts['\u6b63\u5e38'] += 1
    else for (const flag of flags) counts[flag.message] = (counts[flag.message] ?? 0) + 1
    return {
      ...source,
      missing: [...source.missing],
      userValues: { ...source.userValues },
      QC_flag,
      QC_flags: flags.map((flag) => ({ ...flag })),
      QC_keep: flags.length === 0,
    }
  })
  return {
    rows,
    counts,
    keptRows: rows.filter(({ QC_keep }) => QC_keep).map(clone),
    rejectedRows: rows.filter(({ QC_keep }) => !QC_keep).map(clone),
    gaps: [...stationResult.gaps],
    gapCount: stationResult.gapCount,
    warnings: [...stationResult.warnings],
  }
}
