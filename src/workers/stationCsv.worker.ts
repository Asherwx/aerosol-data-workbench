/// <reference lib="webworker" />

import { parseExtractedStationCsv } from '../core/extractedStationCsv'
import { assertNationalDailyFilename, assertStationFileSize, validateStationWideIdentity } from '../core/stationFileDetection'
import { parseStationCsvText, type ParsedStationFile } from '../core/stationCsv'

export interface NationalDailyWorkerRequest {
  kind: 'national-daily'
  identityPolicy: 'strict' | 'legacy'
  file: File
  stationId: string
}
export interface StationWideWorkerRequest {
  kind: 'station-wide'
  identityPolicy: 'strict'
  file: File
  stationId: string
}
export type StationCsvWorkerRequest = NationalDailyWorkerRequest | StationWideWorkerRequest

export type StationCsvWorkerResponse =
  | { ok: true; result: ParsedStationFile }
  | { ok: false; error: string }

const workerScope = self as unknown as DedicatedWorkerGlobalScope

export async function handleStationWorkerRequest(
  request: StationCsvWorkerRequest,
): Promise<StationCsvWorkerResponse> {
  try {
    const { file, stationId } = request
    assertStationFileSize(file, request.kind)
    const text = await file.text()
    if (request.kind === 'station-wide') {
      const parsed = parseExtractedStationCsv(text)
      validateStationWideIdentity(file.name, stationId, parsed.stationId, parsed.rows)
      return { ok: true, result: { filename: file.name, rows: parsed.rows, warnings: parsed.warnings } }
    }
    if (request.identityPolicy === 'strict') assertNationalDailyFilename(file.name)
    return {
      ok: true,
      result: parseStationCsvText(text, file.name, stationId),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

workerScope.onmessage = async (event: MessageEvent<StationCsvWorkerRequest>) => {
  workerScope.postMessage(await handleStationWorkerRequest(event.data))
}
