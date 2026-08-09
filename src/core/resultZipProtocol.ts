export interface ResultZipWorkerFile {
  name: string
  buffer: ArrayBuffer
}

export interface ResultZipWorkerRequest {
  files: ResultZipWorkerFile[]
}

export type ResultZipWorkerResponse =
  | { ok: true; buffer: ArrayBuffer }
  | { ok: false; message: string }
