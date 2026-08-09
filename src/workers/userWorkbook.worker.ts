/// <reference lib="webworker" />

import JSZip from 'jszip'
import { readSheet } from 'read-excel-file/web-worker'
import type { SheetData } from 'read-excel-file/web-worker'
import { boundedDisplay } from '../core/display'
import {
  MAX_USER_SHEETS,
  USER_CSV_MAX_BYTES,
  USER_DATA_WARNING_CAP,
  assertUserMatrixBudgets,
  parseUserCsv,
  parseUserMatrix,
  type ParsedUserData,
} from '../core/userDataset'
import type {
  UserWorkbookWorkerOptions,
  UserWorkbookWorkerRequest,
  UserWorkbookWorkerResponse,
} from '../core/userWorkbookProtocol'
import { preflightUserWorkbookZip } from '../core/zipPreflight'

export function parseUserCsvBuffer(
  buffer: ArrayBuffer,
  filename: string,
  options: UserWorkbookWorkerOptions,
): ParsedUserData {
  if (buffer.byteLength > USER_CSV_MAX_BYTES) throw new Error('CSV exceeds the 25 MiB limit.')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer))
  } catch {
    throw new Error(`${boundedDisplay(filename, 160)} is not valid UTF-8 CSV.`)
  }
  return parseUserCsv(text, filename, options.mapping)
}

function withFallbackWarning(result: ParsedUserData, filename: string, preferred: string): ParsedUserData {
  const warning = `${boundedDisplay(filename, 160)}: preferred sheet "${boundedDisplay(preferred, 120)}" was invalid; fell back to "${result.sheetName}".`
  const warnings = [warning, ...result.warnings]
  if (warnings.length > USER_DATA_WARNING_CAP) {
    warnings.length = USER_DATA_WARNING_CAP
    warnings[USER_DATA_WARNING_CAP - 1] = `Warning limit reached; only the first ${USER_DATA_WARNING_CAP - 1} warnings are shown and the remainder are truncated.`
  }
  return { ...result, warnings, warningTotal: result.warningTotal + 1 }
}

export async function parseUserWorkbookBuffer(
  buffer: ArrayBuffer,
  filename: string,
  options: UserWorkbookWorkerOptions,
): Promise<ParsedUserData> {
  preflightUserWorkbookZip(buffer, filename)
  const sheetNames = await readWorkbookMetadata(buffer)
  if (sheetNames.length === 0) throw new Error('Workbook contains no worksheets.')
  const preferredName = options.preferredSheet?.trim()
  const preferred = preferredName && sheetNames.includes(preferredName) ? preferredName : undefined
  const ordered = preferred ? [preferred, ...sheetNames.filter((name) => name !== preferred)] : sheetNames
  let firstMappingRequired: ParsedUserData | undefined
  for (const sheetName of ordered.slice(0, MAX_USER_SHEETS)) {
    let matrix: SheetData<number> = []
    try {
      matrix = await readSheet(buffer, sheetName)
    } catch {
      continue
    }
    assertUserMatrixBudgets(matrix, `${filename} (${sheetName})`)
    try {
      const result = parseUserMatrix(matrix, filename, sheetName, options.mapping)
      if (result.mappingRequired) {
        firstMappingRequired ??= result
        continue
      }
      return preferredName && sheetName !== preferred
        ? withFallbackWarning(result, filename, preferredName)
        : result
    } catch {
      // A malformed candidate must not prevent deterministic fallback to the
      // next workbook sheet. The final failure below remains bounded.
    } finally {
      matrix.length = 0
    }
  }
  if (firstMappingRequired) {
    return preferredName && firstMappingRequired.sheetName !== preferredName
      ? withFallbackWarning(firstMappingRequired, filename, preferredName)
      : firstMappingRequired
  }
  throw new Error(`${boundedDisplay(filename, 160)} has no worksheet compatible with the selected mapping.`)
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)
  return match ? decodeXmlAttribute(match[2]) : undefined
}

async function readWorkbookMetadata(buffer: ArrayBuffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(new Uint8Array(buffer))
  const workbookEntry = zip.file('xl/workbook.xml')
  if (!workbookEntry) throw new Error('Workbook metadata is missing.')
  const xml = await workbookEntry.async('string')
  const workbookPr = /<workbookPr\b[^>]*>/i.exec(xml)?.[0]
  const date1904 = workbookPr ? attribute(workbookPr, 'date1904') : undefined
  if (date1904 === '1' || date1904?.toLowerCase() === 'true') {
    throw new Error('Mac 1904 date-system workbooks are not supported; dates would be ambiguous.')
  }
  if (date1904 !== undefined && !['0', 'false'].includes(date1904.toLowerCase())) {
    throw new Error('Workbook date-system metadata is invalid; refusing to guess.')
  }
  const names: string[] = []
  for (const match of xml.matchAll(/<sheet\b[^>]*>/gi)) {
    const name = attribute(match[0], 'name')
    if (name === undefined) throw new Error('Workbook sheet metadata is invalid.')
    const safeName = boundedDisplay(name, 120)
    if (!safeName || safeName !== name) throw new Error('Workbook sheet name is unsafe or exceeds 120 characters.')
    names.push(safeName)
    if (names.length > MAX_USER_SHEETS) throw new Error(`Workbook exceeds the ${MAX_USER_SHEETS}-sheet limit.`)
  }
  return names
}

function isWorkerRequest(value: unknown): value is UserWorkbookWorkerRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Record<string, unknown>
  return (request.kind === 'csv' || request.kind === 'xlsx') &&
    request.buffer instanceof ArrayBuffer && typeof request.filename === 'string' &&
    typeof request.options === 'object' && request.options !== null
}

const inDedicatedWorker = typeof WorkerGlobalScope !== 'undefined' &&
  typeof self !== 'undefined' && self instanceof WorkerGlobalScope

if (inDedicatedWorker) {
  const workerScope = self as unknown as DedicatedWorkerGlobalScope
  workerScope.onmessage = async (event: MessageEvent<unknown>) => {
    let response: UserWorkbookWorkerResponse
    try {
      if (!isWorkerRequest(event.data)) throw new Error('Invalid user data worker request.')
      response = {
        ok: true,
        result: event.data.kind === 'csv'
          ? parseUserCsvBuffer(event.data.buffer, event.data.filename, event.data.options)
          : await parseUserWorkbookBuffer(event.data.buffer, event.data.filename, event.data.options),
      }
    } catch (error) {
      response = { ok: false, error: boundedDisplay(error instanceof Error ? error.message : error, 200) }
    }
    workerScope.postMessage(response)
  }
}
