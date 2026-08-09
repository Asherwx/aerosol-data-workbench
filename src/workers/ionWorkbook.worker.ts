/// <reference lib="webworker" />

import type {
  IonWorkbookWorkerRequest,
  IonWorkbookWorkerResponse,
} from '../core/ionWorkbookProtocol'
import { boundedDisplay } from '../core/display'
import { parseIonWorkbookBuffer } from './parseIonWorkbookBuffer'

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = async (event: MessageEvent<IonWorkbookWorkerRequest>) => {
  let response: IonWorkbookWorkerResponse
  try {
    if (!(event.data?.buffer instanceof ArrayBuffer)) {
      throw new Error('工作线程请求格式无效')
    }
    if (typeof event.data.filename !== 'string') {
      throw new Error('工作线程请求缺少文件名')
    }
    const result = await parseIonWorkbookBuffer(event.data.buffer, event.data.filename)
    response = { ok: true, result }
  } catch (error) {
    response = {
      ok: false,
      error: boundedDisplay(error instanceof Error ? error.message : error, 200),
    }
  }
  workerScope.postMessage(response)
}
