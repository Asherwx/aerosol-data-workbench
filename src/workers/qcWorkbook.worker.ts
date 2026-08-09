/// <reference lib="webworker" />

import {
  QC_WORKBOOK_PROTOCOL_VERSION,
  type QcWorkbookWorkerRequest,
  type QcWorkbookWorkerResponse,
} from '../core/exportShared'
import { createQcWorkbookBlobFromModelDirect } from '../core/qcWorkbook'

function parseRequest(value: unknown): QcWorkbookWorkerRequest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Workbook request envelope is invalid')
  }
  const request = value as Partial<QcWorkbookWorkerRequest>
  if (!Object.prototype.hasOwnProperty.call(request, 'version')
    || !Object.prototype.hasOwnProperty.call(request, 'model')
    || request.version !== QC_WORKBOOK_PROTOCOL_VERSION || request.model === undefined) {
    throw new Error('Workbook request envelope is invalid')
  }
  return request as QcWorkbookWorkerRequest
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  try {
    const request = parseRequest(event.data)
    const blob = await createQcWorkbookBlobFromModelDirect(request.model)
    const buffer = await blob.arrayBuffer()
    const response: QcWorkbookWorkerResponse = { ok: true, buffer }
    self.postMessage(response, { transfer: [buffer] })
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成质控工作簿失败'
    const response: QcWorkbookWorkerResponse = {
      ok: false,
      message: message.slice(0, 1_000),
    }
    self.postMessage(response)
  }
}

export {}
