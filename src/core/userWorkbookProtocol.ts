import type { ParsedUserData, UserDataMapping } from './userDataset'

export interface UserWorkbookWorkerOptions {
  mapping?: UserDataMapping
  preferredSheet?: string
}

export interface UserWorkbookWorkerRequest {
  kind: 'csv' | 'xlsx'
  buffer: ArrayBuffer
  filename: string
  options: UserWorkbookWorkerOptions
}

export type UserWorkbookWorkerResponse =
  | { ok: true; result: ParsedUserData }
  | { ok: false; error: string }
