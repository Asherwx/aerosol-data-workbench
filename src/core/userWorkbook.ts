import { boundedDisplay } from './display'
import {
  USER_DATA_MAX_ROWS,
  USER_DATA_WARNING_CAP,
  USER_CSV_MAX_BYTES,
  MAX_USER_CELLS,
  type ParsedUserData,
  type UserDataMapping,
  type UserDataRow,
  type UserMappingRequired,
  type UserVariableSpec,
} from './userDataset'
import type {
  UserWorkbookWorkerOptions,
  UserWorkbookWorkerRequest,
  UserWorkbookWorkerResponse,
} from './userWorkbookProtocol'
import {
  ION_ZIP_MAX_COMPRESSED_BYTES,
  preflightUserWorkbookZip,
} from './zipPreflight'

export type { UserWorkbookWorkerRequest, UserWorkbookWorkerResponse } from './userWorkbookProtocol'
export * from './userDataset'

export interface ParseUserWorkbookOptions extends UserWorkbookWorkerOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export const USER_WORKBOOK_MAX_BYTES = ION_ZIP_MAX_COMPRESSED_BYTES
export const USER_WORKBOOK_DEFAULT_TIMEOUT_MS = 60_000
export const USER_WORKBOOK_MAX_TIMEOUT_MS = 120_000

const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalVariable(value: unknown): UserVariableSpec | undefined {
  if (!isObject(value) || typeof value.key !== 'string' || !SAFE_KEY.test(value.key) ||
      PROTOTYPE_KEYS.has(value.key) || typeof value.label !== 'string' || !value.label.trim() ||
      typeof value.unit !== 'string' || typeof value.nonNegative !== 'boolean' ||
      !Number.isInteger(value.sourceColumn) || (value.sourceColumn as number) < 0 || (value.sourceColumn as number) >= 1_000) return undefined
  const safeLabel = boundedDisplay(value.label, 120)
  const safeUnit = boundedDisplay(value.unit, 48)
  if (!safeLabel) return undefined
  return {
    key: value.key,
    label: /^[=+@-]/.test(safeLabel) ? boundedDisplay(`'${safeLabel}`, 120) : safeLabel,
    unit: /^[=+@-]/.test(safeUnit) ? boundedDisplay(`'${safeUnit}`, 48) : safeUnit,
    nonNegative: value.nonNegative,
    sourceColumn: value.sourceColumn as number,
  }
}

function canonicalVariables(value: unknown): UserVariableSpec[] | undefined {
  if (!Array.isArray(value) || value.length > 1_000) return undefined
  const variables: UserVariableSpec[] = []
  const keys = new Set<string>()
  const columns = new Set<number>()
  for (const raw of value) {
    const variable = canonicalVariable(raw)
    if (!variable || keys.has(variable.key) || columns.has(variable.sourceColumn)) return undefined
    keys.add(variable.key); columns.add(variable.sourceColumn); variables.push(variable)
  }
  return variables
}

function canonicalMapping(value: unknown, variables: readonly UserVariableSpec[]): UserDataMapping | undefined {
  if (!isObject(value) || !Number.isInteger(value.timestampColumn) ||
      (value.timestampColumn as number) < 0 || (value.timestampColumn as number) >= 1_000) return undefined
  const mapped = canonicalVariables(value.variables)
  if (!mapped || mapped.length < 1 || mapped.length !== variables.length) return undefined
  if (mapped.some((item, index) => JSON.stringify(item) !== JSON.stringify(variables[index]))) return undefined
  if (mapped.some((item) => item.sourceColumn === value.timestampColumn)) return undefined
  return { timestampColumn: value.timestampColumn as number, variables: mapped }
}

function canonicalMappingRequired(value: unknown): UserMappingRequired | undefined {
  if (!isObject(value) || !['missing-time', 'ambiguous-time'].includes(String(value.reason)) ||
      !Array.isArray(value.timeCandidates) || value.timeCandidates.length > 1_000 ||
      !Array.isArray(value.columns) || value.columns.length > 1_000) return undefined
  const timeCandidates: number[] = []
  for (const item of value.timeCandidates) {
    if (!Number.isInteger(item) || item < 0 || item >= 1_000) return undefined
    timeCandidates.push(item)
  }
  const columns: UserMappingRequired['columns'] = []
  for (const raw of value.columns) {
    if (!isObject(raw) || !Number.isInteger(raw.sourceColumn) || (raw.sourceColumn as number) < 0 ||
        (raw.sourceColumn as number) >= 1_000 || typeof raw.label !== 'string') return undefined
    columns.push({ sourceColumn: raw.sourceColumn as number, label: boundedDisplay(raw.label, 120) })
  }
  return { reason: value.reason as UserMappingRequired['reason'], timeCandidates, columns }
}

function canonicalRows(value: unknown, variables: readonly UserVariableSpec[]): UserDataRow[] | undefined {
  if (!Array.isArray(value) || value.length > USER_DATA_MAX_ROWS) return undefined
  const allowed = new Set(variables.map(({ key }) => key))
  const rows: UserDataRow[] = []
  let cells = 0
  let previous = ''
  for (const raw of value) {
    if (!isObject(raw) || typeof raw.timestamp !== 'string' ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(raw.timestamp) ||
        !isCanonicalTimestamp(raw.timestamp) ||
        raw.timestamp <= previous || !isObject(raw.values)) return undefined
    const values: Record<string, number | undefined> = {}
    for (const key of allowed) {
      const numeric = raw.values[key]
      if (numeric === undefined) continue
      if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return undefined
      values[key] = numeric
      cells += 1
      if (cells > MAX_USER_CELLS) return undefined
    }
    rows.push({ timestamp: raw.timestamp, values })
    previous = raw.timestamp
  }
  if (rows.length > 1) {
    const first = Date.parse(`${rows[0].timestamp.replace(' ', 'T')}Z`)
    const last = Date.parse(`${rows.at(-1)?.timestamp.replace(' ', 'T')}Z`)
    if ((last - first) / 3_600_000 + 1 > USER_DATA_MAX_ROWS) return undefined
  }
  return rows
}

function isCanonicalTimestamp(value: string): boolean {
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  if (!Number.isFinite(date.getTime())) return false
  const canonical = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:00:00`
  return canonical === value
}

function canonicalResult(value: unknown): ParsedUserData | undefined {
  if (!isObject(value) || typeof value.sheetName !== 'string' || !Array.isArray(value.warnings) ||
      value.warnings.length > USER_DATA_WARNING_CAP || !value.warnings.every((item) => typeof item === 'string') ||
      !Number.isInteger(value.warningTotal) || (value.warningTotal as number) < value.warnings.length) return undefined
  const variables = canonicalVariables(value.variables)
  if (!variables) return undefined
  const mappingRequired = value.mappingRequired === undefined ? undefined : canonicalMappingRequired(value.mappingRequired)
  if (value.mappingRequired !== undefined && !mappingRequired) return undefined
  const mapping = value.mapping === undefined ? undefined : canonicalMapping(value.mapping, variables)
  if (value.mapping !== undefined && !mapping) return undefined
  if ((mappingRequired && mapping) || (!mappingRequired && !mapping) || (mappingRequired && variables.length !== 0)) return undefined
  const rows = canonicalRows(value.rows, variables)
  if (!rows || (mappingRequired && rows.length !== 0)) return undefined
  return {
    rows,
    variables,
    ...(mapping ? { mapping } : {}),
    ...(mappingRequired ? { mappingRequired } : {}),
    warnings: value.warnings.map((item) => boundedDisplay(item, 1_000)),
    warningTotal: value.warningTotal as number,
    sheetName: boundedDisplay(value.sheetName, 120),
  }
}

function canonicalResponse(value: unknown): UserWorkbookWorkerResponse | undefined {
  if (!isObject(value)) return undefined
  if (value.ok === true) {
    const result = canonicalResult(value.result)
    return result ? { ok: true, result } : undefined
  }
  if (value.ok === false && typeof value.error === 'string') return { ok: false, error: boundedDisplay(value.error, 200) }
  return undefined
}

function abortError(): DOMException { return new DOMException('User workbook parsing was cancelled.', 'AbortError') }

function readFileWithAbort(file: File, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (signal?.aborted) return Promise.reject(abortError())
  if (!signal) {
    try { return file.arrayBuffer() } catch (error) { return Promise.reject(error) }
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', onAbort); action()
    }
    const onAbort = (): void => finish(() => reject(abortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      file.arrayBuffer().then(
        (buffer) => finish(() => resolve(buffer)),
        (error: unknown) => finish(() => reject(error)),
      )
    } catch (error) { finish(() => reject(error)) }
  })
}

function normalizedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return USER_WORKBOOK_DEFAULT_TIMEOUT_MS
  return Math.min(USER_WORKBOOK_MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(value)))
}

function parseInWorker(
  kind: UserWorkbookWorkerRequest['kind'],
  buffer: ArrayBuffer,
  filename: string,
  options: ParseUserWorkbookOptions,
): Promise<ParsedUserData> {
  if (kind === 'xlsx') preflightUserWorkbookZip(buffer, filename)
  else if (buffer.byteLength > USER_CSV_MAX_BYTES) throw new Error('CSV exceeds the 25 MiB limit.')
  if (options.signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let worker: Worker
    try { worker = new Worker(new URL('../workers/userWorkbook.worker.ts', import.meta.url), { type: 'module' }) }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null
      worker.terminate(); action()
    }
    const fail = (error: unknown): void => finish(() => reject(error instanceof Error || error instanceof DOMException ? error : new Error(String(error))))
    const onAbort = (): void => fail(abortError())
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const response = canonicalResponse(event.data)
      if (!response) { fail(new Error(`${boundedDisplay(filename, 160)}: workbook worker returned an invalid response envelope.`)); return }
      if (response.ok) finish(() => resolve(response.result))
      else fail(new Error(`${boundedDisplay(filename, 160)}: XLSX parsing failed (${response.error}).`))
    }
    worker.onerror = (event: ErrorEvent) => fail(new Error(`${boundedDisplay(filename, 160)}: workbook worker failed (${boundedDisplay(event.message || 'unknown error', 200)}).`))
    worker.onmessageerror = () => fail(new Error(`${boundedDisplay(filename, 160)}: workbook worker message could not be decoded.`))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) { onAbort(); return }
    const timeoutMs = normalizedTimeout(options.timeoutMs)
    timer = setTimeout(() => fail(new Error(`${boundedDisplay(filename, 160)}: workbook worker exceeded the ${Math.round(timeoutMs / 1_000)} second timeout.`)), timeoutMs)
    const workerOptions: UserWorkbookWorkerOptions = {
      ...(options.mapping ? { mapping: cloneInputMapping(options.mapping) } : {}),
      ...(options.preferredSheet ? { preferredSheet: boundedDisplay(options.preferredSheet, 120) } : {}),
    }
    const request: UserWorkbookWorkerRequest = { kind, buffer, filename: boundedDisplay(filename, 160), options: workerOptions }
    try { worker.postMessage(request, [buffer]) } catch (error) { fail(error) }
  })
}

function cloneInputMapping(mapping: UserDataMapping): UserDataMapping {
  if (!Number.isInteger(mapping.timestampColumn) || mapping.timestampColumn < 0 || mapping.timestampColumn >= 1_000 ||
      !Array.isArray(mapping.variables) || mapping.variables.length < 1 || mapping.variables.length > 1_000) {
    throw new Error('Workbook mapping is invalid.')
  }
  const columns = new Set<number>([mapping.timestampColumn])
  const keys = new Set<string>()
  const variables = mapping.variables.map((raw) => {
    const variable = canonicalVariable(raw)
    if (!variable || columns.has(variable.sourceColumn) || keys.has(variable.key)) throw new Error('Workbook mapping columns and keys must be valid and unique.')
    columns.add(variable.sourceColumn); keys.add(variable.key)
    return variable
  })
  return { timestampColumn: mapping.timestampColumn, variables }
}

export function parseUserWorkbook(
  input: ArrayBuffer | File,
  filename: string,
  options: ParseUserWorkbookOptions = {},
): Promise<ParsedUserData> {
  const isBuffer = input instanceof ArrayBuffer || Object.prototype.toString.call(input) === '[object ArrayBuffer]'
  const size = isBuffer ? (input as ArrayBuffer).byteLength : (input as File).size
  if (size > USER_WORKBOOK_MAX_BYTES) return Promise.reject(new Error(`${boundedDisplay(filename, 160)} exceeds the 25 MiB workbook limit.`))
  if (options.signal?.aborted) return Promise.reject(abortError())
  if (options.mapping) {
    try { cloneInputMapping(options.mapping) } catch (error) { return Promise.reject(error) }
  }
  if (isBuffer) {
    try { return parseInWorker('xlsx', (input as ArrayBuffer).slice(0), filename, options) }
    catch (error) { return Promise.reject(error) }
  }
  return readFileWithAbort(input as File, options.signal).then((buffer) => {
    if (options.signal?.aborted) throw abortError()
    return parseInWorker('xlsx', buffer, filename, options)
  })
}

export function parseUserCsvFile(
  file: File,
  filename = file.name,
  options: ParseUserWorkbookOptions = {},
): Promise<ParsedUserData> {
  if (file.size > USER_CSV_MAX_BYTES) {
    return Promise.reject(new Error(`${boundedDisplay(filename, 160)} exceeds the 25 MiB CSV limit.`))
  }
  if (options.signal?.aborted) return Promise.reject(abortError())
  if (options.mapping) {
    try { cloneInputMapping(options.mapping) } catch (error) { return Promise.reject(error) }
  }
  return readFileWithAbort(file, options.signal).then((buffer) => {
    if (options.signal?.aborted) throw abortError()
    if (buffer.byteLength > USER_CSV_MAX_BYTES) throw new Error(`${boundedDisplay(filename, 160)} exceeds the 25 MiB CSV limit.`)
    return parseInWorker('csv', buffer.slice(0), filename, options)
  })
}
