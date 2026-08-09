import type { ParsedIonWorkbook } from './ionMatrix'

export interface IonWorkbookWorkerRequest {
  buffer: ArrayBuffer
  filename: string
}

export type IonWorkbookWorkerResponse =
  | { ok: true; result: ParsedIonWorkbook }
  | { ok: false; error: string }
