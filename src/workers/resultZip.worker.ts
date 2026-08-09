/// <reference lib="webworker" />

import { createResultZipDirect } from '../core/resultZip'
import type { ResultZipWorkerRequest, ResultZipWorkerResponse } from '../core/resultZipProtocol'

self.onmessage = async (event: MessageEvent<ResultZipWorkerRequest>) => {
  let response: ResultZipWorkerResponse
  try {
    const buffer = await createResultZipDirect(event.data.files)
    response = { ok: true, buffer }
    self.postMessage(response, { transfer: [buffer] })
  } catch (error) {
    response = {
      ok: false,
      message: error instanceof Error ? error.message : '生成结果压缩包失败',
    }
    self.postMessage(response)
  }
}

export {}
