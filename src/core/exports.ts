import Papa from 'papaparse'

import { parseIsoDateStrict } from './dates'
import {
  EXPORT_HEADERS,
  type QcWorkbookMetadata,
  type QcWorkbookModel,
  type QcWorkbookWorkerRequest,
  QC_WORKBOOK_PROTOCOL_VERSION,
  normalizeQcWorkbookModel,
  sanitizeQcWorkbookMetadata,
  safeSpreadsheetString,
} from './exportShared'
import { createLegacyQcWorkbookModel } from './qcWorkbook'
import type { CheckedRow, QualityControlResult } from './qualityControl'
import type {
  ResultZipWorkerFile,
  ResultZipWorkerRequest,
  ResultZipWorkerResponse,
} from './resultZipProtocol'
import type { StationSeriesRow } from './stationSeries'

export type { QcWorkbookMetadata } from './exportShared'

export const MAX_EXPORT_ROWS = 366 * 24
export const RESULT_ZIP_MAX_FILES = 32
export const RESULT_ZIP_MAX_TOTAL_BYTES = 16 * 1024 * 1024
export const DEFAULT_WORKBOOK_TIMEOUT_MS = 30_000
export const MAX_WORKBOOK_TIMEOUT_MS = 120_000
export const DEFAULT_RESULT_ZIP_TIMEOUT_MS = 30_000
export const MAX_RESULT_ZIP_TIMEOUT_MS = 120_000

const STATION_HEADERS = EXPORT_HEADERS.slice(0, 9)
const UTF8_BOM = '\uFEFF'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

type ZipContent = string | Blob | ArrayBuffer | ArrayBufferView

export interface ResultZipFile {
  name: string
  content: ZipContent
}

export interface NamedArtifact<T> {
  name: string
  content: T
}

export interface ResultArtifacts {
  stationCsv: NamedArtifact<string>
  mergedCsv: NamedArtifact<string>
  qcWorkbook: NamedArtifact<Blob>
  processingLog: NamedArtifact<string>
  zip: NamedArtifact<Blob>
}

export interface BuildResultArtifactsInput {
  stationRows: readonly StationSeriesRow[]
  qcResult: QualityControlResult
  metadata: QcWorkbookMetadata
  startDate: string
  endDate: string
}

export interface BuildResultArtifactsOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface CreateQcWorkbookOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface CreateResultZipOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

function assertRowLimit(rows: readonly unknown[]): void {
  if (rows.length > MAX_EXPORT_ROWS) {
    throw new Error(`导出行数 ${rows.length} 超过安全上限 ${MAX_EXPORT_ROWS}`)
  }
}

function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) return ''
  const text = String(value)
  if (!/[eE]/.test(text)) return text

  const [coefficient, exponentText] = text.toLowerCase().split('e') as [string, string]
  const exponent = Number(exponentText)
  const negative = coefficient.startsWith('-')
  const unsigned = negative ? coefficient.slice(1) : coefficient
  const [integer, fraction = ''] = unsigned.split('.')
  const digits = integer + fraction
  const decimalPosition = integer.length + exponent
  let plain: string
  if (decimalPosition <= 0) {
    plain = `0.${'0'.repeat(-decimalPosition)}${digits}`
  } else if (decimalPosition >= digits.length) {
    plain = `${digits}${'0'.repeat(decimalPosition - digits.length)}`
  } else {
    plain = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`
  }
  return negative ? `-${plain}` : plain
}

function csvCell(value: string | number | boolean | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'number') return numberToPlainString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return safeSpreadsheetString(value)
}

function stationCells(row: StationSeriesRow): string[] {
  return [
    csvCell(row.timestamp),
    csvCell(row.SO2),
    csvCell(row.NO2),
    csvCell(row.O3),
    csvCell(row.CO),
    csvCell(row.PM10),
    csvCell(row['PM2.5']),
    csvCell(row.missing.join('；')),
    csvCell(row.status),
  ]
}

function mergedCells(row: CheckedRow): string[] {
  return [
    ...stationCells(row),
    csvCell(row.NO3),
    csvCell(row.SO4),
    csvCell(row.NH4),
    csvCell(row.QC_flag),
    csvCell(row.QC_keep),
  ]
}

function createCsv(headers: readonly string[], rows: readonly string[][]): string {
  return UTF8_BOM + Papa.unparse([headers.map(safeSpreadsheetString), ...rows], {
    newline: '\r\n',
    header: false,
  })
}

export function createStationCsv(rows: readonly StationSeriesRow[]): string {
  assertRowLimit(rows)
  return createCsv(STATION_HEADERS, rows.map(stationCells))
}

export function createMergedCsv(rows: readonly CheckedRow[]): string {
  assertRowLimit(rows)
  return createCsv(EXPORT_HEADERS, rows.map(mergedCells))
}

function cloneQcResult(result: QualityControlResult): QualityControlResult {
  const cloneRow = (row: CheckedRow): CheckedRow => ({
    ...row,
    missing: [...row.missing],
    QC_flags: row.QC_flags.map((flag) => ({ ...flag })),
  })
  return {
    rows: result.rows.map(cloneRow),
    counts: { ...result.counts },
    keptRows: result.keptRows.map(cloneRow),
    rejectedRows: result.rejectedRows.map(cloneRow),
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isWorkbookWorkerResponse(
  value: unknown,
): value is { ok: true; buffer: ArrayBuffer } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null
    || !Object.prototype.hasOwnProperty.call(value, 'ok')) return false
  const response = value as Record<string, unknown>
  if (response.ok === false) {
    return Object.prototype.hasOwnProperty.call(response, 'message')
      && typeof response.message === 'string'
      && response.message.length <= 1_000
  }
  if (response.ok !== true || !Object.prototype.hasOwnProperty.call(response, 'buffer')) return false
  return Object.prototype.toString.call(response.buffer) === '[object ArrayBuffer]'
}

async function createWorkbookInWorker(
  model: QcWorkbookModel,
  options: CreateQcWorkbookOptions,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('../workers/qcWorkbook.worker.ts', import.meta.url), {
        type: 'module',
        name: 'qc-workbook-export',
      })
    } catch (error) {
      const detail = toError(error).message
      reject(new Error(`无法启动后台工作线程导出；请升级浏览器或检查浏览器安全设置后重试。${detail}`))
      return
    }

    let settled = false
    const abort = () => fail(new Error('已取消生成质控工作簿'))
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      settle()
    }
    const fail = (error: unknown): void => finish(() => reject(toError(error)))
    const timeout = setTimeout(
      () => fail(new Error(`生成质控工作簿超时（${options.timeoutMs} ms）`)),
      options.timeoutMs,
    )

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const response = event.data
      if (!isWorkbookWorkerResponse(response)) {
        fail(new Error('工作线程返回格式无效'))
      } else if (response.ok) {
        finish(() => resolve(new Blob([response.buffer], { type: XLSX_MIME })))
      } else {
        fail(new Error(response.message))
      }
    }
    worker.onerror = (event: ErrorEvent) => {
      fail(new Error(event.message || '生成质控工作簿失败'))
    }
    worker.onmessageerror = () => fail(new Error('工作线程消息无法解析'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) {
      abort()
      return
    }
    try {
      const request: QcWorkbookWorkerRequest = {
        version: QC_WORKBOOK_PROTOCOL_VERSION,
        model,
      }
      worker.postMessage(request)
    } catch (error) {
      fail(error)
    }
  })
}

export async function createQcWorkbookFromModel(
  input: QcWorkbookModel,
  options: CreateQcWorkbookOptions = {},
): Promise<Blob> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKBOOK_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WORKBOOK_TIMEOUT_MS) {
    throw new Error(`工作簿超时必须是 1 到 ${MAX_WORKBOOK_TIMEOUT_MS} 毫秒之间的整数`)
  }
  if (options.signal?.aborted) throw new Error('已取消生成质控工作簿')
  const model = normalizeQcWorkbookModel(input)
  if (typeof Worker === 'undefined' || typeof window === 'undefined') {
    throw new Error('当前浏览器不支持后台工作线程导出；请升级浏览器后重试')
  }
  return createWorkbookInWorker(model, { ...options, timeoutMs })
}

export async function createQcWorkbook(
  qcResult: QualityControlResult,
  metadata: QcWorkbookMetadata,
  options: CreateQcWorkbookOptions = {},
): Promise<Blob> {
  assertRowLimit(qcResult.rows)
  assertRowLimit(qcResult.keptRows)
  assertRowLimit(qcResult.rejectedRows)
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKBOOK_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WORKBOOK_TIMEOUT_MS) {
    throw new Error(`工作簿超时必须是 1 到 ${MAX_WORKBOOK_TIMEOUT_MS} 毫秒之间的整数`)
  }
  if (options.signal?.aborted) throw new Error('已取消生成质控工作簿')
  const resultCopy = cloneQcResult(qcResult)
  const metadataCopy = sanitizeQcWorkbookMetadata(metadata)
  return createQcWorkbookFromModel(
    createLegacyQcWorkbookModel(resultCopy, metadataCopy),
    { ...options, timeoutMs },
  )
}

function assertSafeRelativeFilename(name: string): void {
  if (
    !name ||
    name.includes('\0') ||
    /[\u0000-\u001f\u007f<>:"|?*]/.test(name) ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`ZIP 文件名或路径不安全：${name || '(空)'}`)
  }
}

async function zipBuffer(content: ZipContent): Promise<ArrayBuffer> {
  if (typeof content === 'string') {
    const bytes = new TextEncoder().encode(content)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  if (content instanceof Blob) {
    if (typeof content.arrayBuffer === 'function') {
      return (await content.arrayBuffer()).slice(0)
    }
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('读取 Blob 失败'))
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.readAsArrayBuffer(content)
    })
    return buffer.slice(0)
  }
  if (ArrayBuffer.isView(content)) {
    return content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer
  }
  return content.slice(0)
}

function knownZipContentSize(content: ZipContent): number | undefined {
  if (typeof content === 'string') return undefined
  if (content instanceof Blob) return content.size
  if (ArrayBuffer.isView(content)) return content.byteLength
  return content.byteLength
}

function isResultZipWorkerResponse(value: unknown): value is ResultZipWorkerResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false
  const response = value as Record<string, unknown>
  if (response.ok === false) return typeof response.message === 'string'
  return response.ok === true
    && Object.prototype.toString.call(response.buffer) === '[object ArrayBuffer]'
}

function createResultZipInWorker(
  request: ResultZipWorkerRequest,
  options: Required<Pick<CreateResultZipOptions, 'timeoutMs'>> & CreateResultZipOptions,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('../workers/resultZip.worker.ts', import.meta.url), {
        type: 'module',
        name: 'result-zip-export',
      })
    } catch (error) {
      reject(new Error(
        `无法启动后台工作线程生成结果压缩包；请升级浏览器或检查浏览器安全设置后重试。${toError(error).message}`,
      ))
      return
    }

    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      settle()
    }
    const fail = (error: unknown): void => finish(() => reject(toError(error)))
    const abort = (): void => fail(new Error('已取消生成结果压缩包'))

    timeout = setTimeout(
      () => fail(new Error(`生成结果压缩包超时（${options.timeoutMs} ms）`)),
      options.timeoutMs,
    )
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const response = event.data
      if (!isResultZipWorkerResponse(response)) {
        fail(new Error('结果压缩包工作线程返回格式无效'))
      } else if (response.ok) {
        finish(() => resolve(new Blob([response.buffer], { type: 'application/zip' })))
      } else {
        fail(new Error(response.message))
      }
    }
    worker.onerror = (event: ErrorEvent) => fail(new Error(event.message || '结果压缩包工作线程失败'))
    worker.onmessageerror = () => fail(new Error('结果压缩包工作线程消息无法解析'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) {
      abort()
      return
    }
    try {
      worker.postMessage(request, request.files.map((file) => file.buffer))
    } catch (error) {
      fail(error)
    }
  })
}

export async function createResultZip(
  files: readonly ResultZipFile[],
  options: CreateResultZipOptions = {},
): Promise<Blob> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESULT_ZIP_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RESULT_ZIP_TIMEOUT_MS) {
    throw new Error(`结果压缩包工作线程超时必须是 1 到 ${MAX_RESULT_ZIP_TIMEOUT_MS} 毫秒之间的整数`)
  }
  if (files.length > RESULT_ZIP_MAX_FILES) {
    throw new Error(`ZIP 文件数超过安全上限 ${RESULT_ZIP_MAX_FILES}`)
  }
  const names = new Set<string>()
  let knownTotalBytes = 0
  for (const file of files) {
    assertSafeRelativeFilename(file.name)
    const foldedName = file.name.toLocaleLowerCase('en-US')
    if (names.has(foldedName)) throw new Error(`ZIP 中存在重复文件名：${file.name}`)
    names.add(foldedName)
    const knownSize = knownZipContentSize(file.content)
    if (knownSize !== undefined) {
      knownTotalBytes += knownSize
      if (knownTotalBytes > RESULT_ZIP_MAX_TOTAL_BYTES) {
        throw new Error(`ZIP 内容总大小超过安全上限 ${RESULT_ZIP_MAX_TOTAL_BYTES} 字节`)
      }
    }
  }

  const materialized: ResultZipWorkerFile[] = []
  let totalBytes = 0
  for (const file of files) {
    if (options.signal?.aborted) throw new Error('已取消生成结果压缩包')
    const buffer = await zipBuffer(file.content)
    if (options.signal?.aborted) throw new Error('已取消生成结果压缩包')
    totalBytes += buffer.byteLength
    if (totalBytes > RESULT_ZIP_MAX_TOTAL_BYTES) {
      throw new Error(`ZIP 内容总大小超过安全上限 ${RESULT_ZIP_MAX_TOTAL_BYTES} 字节`)
    }
    materialized.push({ name: file.name, buffer })
  }

  if (typeof Worker === 'undefined' || typeof window === 'undefined') {
    throw new Error('当前浏览器不支持后台工作线程生成结果压缩包；请升级浏览器后重试')
  }
  return createResultZipInWorker({ files: materialized }, { ...options, timeoutMs })
}

function sanitizeStationId(value: string): string {
  const filenamePart = value.split(/[\\/]/).at(-1) || ''
  const safe = filenamePart
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return safe || 'station'
}

function compactDate(value: string): string {
  return value.replaceAll('-', '')
}

export async function buildResultArtifacts(
  input: BuildResultArtifactsInput,
  options: BuildResultArtifactsOptions = {},
): Promise<ResultArtifacts> {
  const start = parseIsoDateStrict(input.startDate)
  const end = parseIsoDateStrict(input.endDate)
  if (end.getTime() < start.getTime()) throw new Error('结束日期不能早于开始日期')
  const prefix = `${sanitizeStationId(input.metadata.stationId)}_${compactDate(input.startDate)}-${compactDate(input.endDate)}`
  const stationCsv: NamedArtifact<string> = {
    name: `${prefix}_station.csv`,
    content: createStationCsv(input.stationRows),
  }
  const mergedCsv: NamedArtifact<string> = {
    name: `${prefix}_merged-qc.csv`,
    content: createMergedCsv(input.qcResult.rows),
  }
  const safeMetadata = sanitizeQcWorkbookMetadata(input.metadata)
  const qcWorkbook: NamedArtifact<Blob> = {
    name: `${prefix}_qc-report.xlsx`,
    content: await createQcWorkbook(input.qcResult, safeMetadata, options),
  }
  const processingLog: NamedArtifact<string> = {
    name: `${prefix}_processing-log.json`,
    content: JSON.stringify(safeMetadata, null, 2),
  }
  const zipName = `${prefix}_results.zip`
  const zipContent = await createResultZip(
    [stationCsv, mergedCsv, qcWorkbook, processingLog],
    options,
  )
  return {
    stationCsv,
    mergedCsv,
    qcWorkbook,
    processingLog,
    zip: { name: zipName, content: zipContent },
  }
}

interface DownloadEnvironment {
  document?: Document
  url?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
  revokeDelayMs?: number
}

export function downloadArtifact(
  content: Blob,
  filename: string,
  environment: DownloadEnvironment = {},
): void {
  assertSafeRelativeFilename(filename)
  if (filename.includes('/')) throw new Error('下载文件名不能包含目录路径')
  const targetDocument = environment.document ?? document
  const targetUrl = environment.url ?? URL
  const objectUrl = targetUrl.createObjectURL(content)
  let anchor: HTMLAnchorElement | undefined
  try {
    anchor = targetDocument.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    anchor.hidden = true
    targetDocument.body.append(anchor)
    anchor.click()
  } finally {
    try {
      if (anchor?.isConnected) anchor.remove()
    } finally {
      setTimeout(
        () => targetUrl.revokeObjectURL(objectUrl),
        environment.revokeDelayMs ?? 1_000,
      )
    }
  }
}
