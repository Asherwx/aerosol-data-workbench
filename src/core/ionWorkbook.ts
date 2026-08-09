import { boundedDisplay } from './display'
import {
  ION_WORKBOOK_MAX_ROWS,
  ION_WORKBOOK_WARNING_CAP,
  type IonRow,
  type ParsedIonWorkbook,
} from './ionMatrix'
import type {
  IonWorkbookWorkerRequest,
  IonWorkbookWorkerResponse,
} from './ionWorkbookProtocol'
import {
  ION_ZIP_MAX_COMPRESSED_BYTES,
  preflightIonWorkbookZip,
} from './zipPreflight'

export * from './ionMatrix'
export type { IonWorkbookWorkerRequest, IonWorkbookWorkerResponse } from './ionWorkbookProtocol'

export interface ParseIonWorkbookOptions {
  signal?: AbortSignal
}

export const ION_WORKBOOK_MAX_BYTES = ION_ZIP_MAX_COMPRESSED_BYTES
export const ION_WORKBOOK_WORKER_TIMEOUT_MS = 60_000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function canonicalIonRow(value: unknown): IonRow | undefined {
  if (!isObject(value) || typeof value.timestamp !== 'string') return undefined
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(value.timestamp)) return undefined
  const row: IonRow = { timestamp: value.timestamp }
  for (const ion of ['NO3', 'SO4', 'NH4'] as const) {
    const concentration = value[ion]
    if (concentration === undefined) continue
    if (typeof concentration !== 'number' || !Number.isFinite(concentration)) return undefined
    row[ion] = concentration
  }
  return row
}

function canonicalParsedIonWorkbook(value: unknown): ParsedIonWorkbook | undefined {
  if (
    !isObject(value) ||
    typeof value.sheetName !== 'string' ||
    !Array.isArray(value.rows) ||
    value.rows.length > ION_WORKBOOK_MAX_ROWS ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > ION_WORKBOOK_WARNING_CAP ||
    !value.warnings.every((warning) => typeof warning === 'string')
  ) return undefined

  const rows: IonRow[] = []
  for (const valueRow of value.rows) {
    const row = canonicalIonRow(valueRow)
    if (!row) return undefined
    rows.push(row)
  }
  return {
    rows,
    sheetName: boundedDisplay(value.sheetName, 120),
    warnings: value.warnings.map((warning) => boundedDisplay(warning, 1_000)),
  }
}

type CanonicalWorkerResponse =
  | { ok: true; result: ParsedIonWorkbook }
  | { ok: false; error: string }

function canonicalWorkerResponse(value: unknown): CanonicalWorkerResponse | undefined {
  if (!isObject(value)) return undefined
  if (value.ok === true) {
    const result = canonicalParsedIonWorkbook(value.result)
    return result ? { ok: true, result } : undefined
  }
  if (value.ok === false && typeof value.error === 'string') {
    return { ok: false, error: boundedDisplay(value.error, 200) }
  }
  return undefined
}

function abortError(): DOMException {
  return new DOMException('水溶性离子工作簿解析已取消', 'AbortError')
}

function parseInWorker(
  buffer: ArrayBuffer,
  filename: string,
  signal?: AbortSignal,
): Promise<ParsedIonWorkbook> {
  preflightIonWorkbookZip(buffer, filename)
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('../workers/ionWorkbook.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch (error) {
      reject(
        new Error(
          `${boundedDisplay(filename, 160)}：无法启动 XLSX 工作线程（${boundedDisplay(error, 200)}）`,
        ),
      )
      return
    }

    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      settle()
    }
    const fail = (error: unknown): void =>
      finish(() =>
        reject(
          error instanceof Error || error instanceof DOMException
            ? error
            : new Error(String(error)),
        ),
      )
    const onAbort = (): void => fail(abortError())

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const response = canonicalWorkerResponse(event.data)
      if (!response) {
        fail(new Error(`${boundedDisplay(filename, 160)}：XLSX 工作线程返回格式无效`))
        return
      }
      if (response.ok) {
        finish(() => resolve(response.result))
      } else {
        fail(
          new Error(
            `${boundedDisplay(filename, 160)}：XLSX 解析失败（${response.error}）；请确认文件有效、未损坏且未加密`,
          ),
        )
      }
    }
    worker.onerror = (event: ErrorEvent) => {
      fail(
        new Error(
          `${boundedDisplay(filename, 160)}：XLSX 工作线程失败（${boundedDisplay(event.message || '未知错误', 200)}）`,
        ),
      )
    }
    worker.onmessageerror = () => {
      fail(new Error(`${boundedDisplay(filename, 160)}：XLSX 工作线程消息无法解析`))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timeoutId = setTimeout(() => {
      fail(
        new Error(
          `${boundedDisplay(filename, 160)}：XLSX 工作线程运行超过 60 秒，已超时终止；请检查文件大小后重试`,
        ),
      )
    }, ION_WORKBOOK_WORKER_TIMEOUT_MS)

    const request: IonWorkbookWorkerRequest = { buffer, filename }
    try {
      worker.postMessage(request, [buffer])
    } catch (error) {
      fail(
        new Error(
          `${boundedDisplay(filename, 160)}：向 XLSX 工作线程发送数据失败（${boundedDisplay(error, 200)}）`,
        ),
      )
    }
  })
}

export function parseIonWorkbook(
  input: ArrayBuffer | File,
  filename: string,
  options: ParseIonWorkbookOptions = {},
): Promise<ParsedIonWorkbook> {
  const isBuffer =
    input instanceof ArrayBuffer || Object.prototype.toString.call(input) === '[object ArrayBuffer]'
  const size = isBuffer ? (input as ArrayBuffer).byteLength : (input as File).size
  if (size > ION_WORKBOOK_MAX_BYTES) {
    return Promise.reject(new Error(
      `${boundedDisplay(filename, 160)}：文件大小超过 25 MiB 上限，已在解析前停止；请拆分或压缩工作簿后重试`,
    ))
  }
  if (options.signal?.aborted) return Promise.reject(abortError())

  if (isBuffer) {
    try {
      return parseInWorker((input as ArrayBuffer).slice(0), filename, options.signal)
    } catch (error) {
      return Promise.reject(error)
    }
  }
  return readFileWithAbort(input as File, options.signal).then((buffer) => {
    if (options.signal?.aborted) throw abortError()
    return parseInWorker(buffer, filename, options.signal)
  }, (error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(
      `${boundedDisplay(filename, 160)}：读取文件失败（${boundedDisplay(error, 200)}）；请重新选择文件后重试`,
    )
  })
}

function readFileWithAbort(file: File, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!signal) return file.arrayBuffer()
  if (signal.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => finish(() => reject(abortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      file.arrayBuffer().then(
        (buffer) => finish(() => resolve(buffer)),
        (error: unknown) => finish(() => reject(error)),
      )
    } catch (error) {
      finish(() => reject(error))
    }
  })
}
