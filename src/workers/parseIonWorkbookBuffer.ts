import readXlsxFile from 'read-excel-file/web-worker'
import {
  parseIonWorkbookSheets,
  type ParsedIonWorkbook,
} from '../core/ionMatrix'

export async function parseIonWorkbookBuffer(
  buffer: ArrayBuffer,
  filename: string,
): Promise<ParsedIonWorkbook> {
  const sheets = await readXlsxFile(buffer)
  return parseIonWorkbookSheets(sheets, filename)
}
