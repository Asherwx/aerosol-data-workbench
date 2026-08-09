import { boundedDisplay } from './display'

export const ION_ZIP_MAX_ENTRIES = 5_000
export const ION_ZIP_MAX_COMPRESSED_BYTES = 25 * 1024 * 1024
export const ION_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
export const ION_ZIP_MAX_SINGLE_UNCOMPRESSED_BYTES = 25 * 1024 * 1024
// XLSX XML can compress heavily; 200:1 leaves generous room for repetitive
// worksheets while bounding the expansion typical of ZIP bombs.
export const ION_ZIP_MAX_COMPRESSION_RATIO = 200
export const USER_XLSX_MAX_WORKSHEET_XML_BYTES = 16 * 1024 * 1024
export const USER_XLSX_MAX_SHARED_STRINGS_BYTES = 8 * 1024 * 1024
export const USER_XLSX_MAX_METADATA_XML_BYTES = 2 * 1024 * 1024
export const USER_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
const USER_ZIP_MAX_WORKSHEETS = 20

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const ZIP64_EXTRA_FIELD_ID = 0x0001
const EOCD_MIN_SIZE = 22
const MAX_ZIP_COMMENT = 0xffff

export interface IonZipPreflightResult {
  entries: number
  totalCompressedBytes: number
  totalUncompressedBytes: number
}

export interface UserWorkbookZipPreflightResult extends IonZipPreflightResult {
  worksheets: number
}

function zipError(filename: string, detail: string, action: string): Error {
  return new Error(
    `${boundedDisplay(filename, 160)}：XLSX ZIP 预检失败（${detail}）；${action}`,
  )
}

function findEocd(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - EOCD_MIN_SIZE - MAX_ZIP_COMMENT)
  for (let offset = view.byteLength - EOCD_MIN_SIZE; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset
  }
  return -1
}

function preflightWorkbookZip(
  input: ArrayBuffer,
  filename: string,
  userWorkbook: boolean,
): UserWorkbookZipPreflightResult {
  const view = new DataView(input)
  if (view.byteLength > ION_ZIP_MAX_COMPRESSED_BYTES) {
    throw zipError(filename, '文件大小超过 25 MiB 上限', '请拆分或压缩工作簿后重试')
  }
  if (view.byteLength < EOCD_MIN_SIZE) {
    throw zipError(filename, 'ZIP 结构无效：未找到中央目录结束记录', '请提供有效、未损坏的 XLSX 文件')
  }
  const eocd = findEocd(view)
  if (eocd < 0) {
    throw zipError(filename, 'ZIP 结构无效：未找到中央目录结束记录', '请提供有效、未损坏的 XLSX 文件')
  }

  const commentLength = view.getUint16(eocd + 20, true)
  if (eocd + EOCD_MIN_SIZE + commentLength !== view.byteLength) {
    throw zipError(filename, 'ZIP 中央目录结束记录无效', '请重新导出为标准 XLSX 后重试')
  }
  const disk = view.getUint16(eocd + 4, true)
  const centralDisk = view.getUint16(eocd + 6, true)
  const entriesOnDisk = view.getUint16(eocd + 8, true)
  const entries = view.getUint16(eocd + 10, true)
  const centralSize = view.getUint32(eocd + 12, true)
  const centralOffset = view.getUint32(eocd + 16, true)

  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) {
    throw zipError(filename, '不支持多磁盘 ZIP', '请重新导出为单文件 XLSX 后重试')
  }
  if (
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw zipError(filename, '检测到 ZIP64，当前不支持', '请重新导出为小于限制的标准 XLSX 后重试')
  }
  if (entries > ION_ZIP_MAX_ENTRIES) {
    throw zipError(
      filename,
      `ZIP 条目数 ${entries} 超过上限 ${ION_ZIP_MAX_ENTRIES}`,
      '请拆分工作簿或移除不需要的工作表后重试',
    )
  }
  const centralEnd = centralOffset + centralSize
  if (centralEnd > eocd || centralEnd > view.byteLength) {
    throw zipError(filename, 'ZIP 中央目录范围无效', '请重新导出为标准 XLSX 后重试')
  }
  for (let offset = centralEnd; offset + 4 <= eocd; offset += 1) {
    const signature = view.getUint32(offset, true)
    if (
      signature === ZIP64_EOCD_SIGNATURE ||
      signature === ZIP64_EOCD_LOCATOR_SIGNATURE
    ) {
      throw zipError(
        filename,
        '检测到 ZIP64 结束记录或定位器，当前不支持',
        '请重新导出为小于限制的标准 XLSX 后重试',
      )
    }
  }

  let cursor = centralOffset
  let totalCompressedBytes = 0
  let totalUncompressedBytes = 0
  let worksheets = 0
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > centralEnd || view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw zipError(filename, `ZIP 中央目录第 ${index + 1} 个条目无效`, '请重新导出为标准 XLSX 后重试')
    }
    const compressed = view.getUint32(cursor + 20, true)
    const uncompressed = view.getUint32(cursor + 24, true)
    const filenameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const entryCommentLength = view.getUint16(cursor + 32, true)
    const startDisk = view.getUint16(cursor + 34, true)
    const localOffset = view.getUint32(cursor + 42, true)
    if (
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw zipError(filename, '检测到 ZIP64 条目，当前不支持', '请重新导出为标准 XLSX 后重试')
    }
    if (startDisk !== 0) {
      throw zipError(filename, '不支持多磁盘 ZIP 条目', '请重新导出为单文件 XLSX 后重试')
    }
    const entryEnd = cursor + 46 + filenameLength + extraLength + entryCommentLength
    if (entryEnd > centralEnd) {
      throw zipError(
        filename,
        'ZIP 中央目录条目长度无效',
        '请重新导出为标准 XLSX 后重试',
      )
    }
    const filenameStart = cursor + 46
    const entryName = new TextDecoder('utf-8', { fatal: false })
      .decode(new Uint8Array(input, filenameStart, filenameLength))
      .replace(/\\/g, '/')
    if (
      entryName.includes('\0') ||
      entryName.startsWith('/') ||
      /^[a-z]:\//i.test(entryName) ||
      entryName.split('/').some((part) => part === '..')
    ) {
      throw zipError(
        filename,
        'ZIP 条目路径包含目录穿越或绝对路径',
        '请重新导出为不含危险路径的标准 XLSX 后重试',
      )
    }
    if (userWorkbook) {
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(entryName)) {
        worksheets += 1
        if (worksheets > USER_ZIP_MAX_WORKSHEETS) {
          throw zipError(filename, `worksheet count exceeds limit ${USER_ZIP_MAX_WORKSHEETS}`, '请删除不需要的工作表后重试')
        }
        if (uncompressed > USER_XLSX_MAX_WORKSHEET_XML_BYTES) {
          throw zipError(filename, '单个工作表 XML 超过 16 MiB 上限', '请拆分工作表后重试')
        }
      }
      if (/^xl\/sharedStrings\.xml$/i.test(entryName) && uncompressed > USER_XLSX_MAX_SHARED_STRINGS_BYTES) {
        throw zipError(filename, '共享字符串 XML 超过 8 MiB 上限', '请减少超长文本或拆分工作簿后重试')
      }
      if (/^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml)$/i.test(entryName) && uncompressed > USER_XLSX_MAX_METADATA_XML_BYTES) {
        throw zipError(filename, '工作簿元数据 XML 超过 2 MiB 上限', '请重新导出精简的标准 XLSX 后重试')
      }
    }
    const extraStart = cursor + 46 + filenameLength
    const extraEnd = extraStart + extraLength
    let extraCursor = extraStart
    while (extraCursor < extraEnd) {
      if (extraEnd - extraCursor < 4) {
        throw zipError(
          filename,
          'ZIP 中央目录额外字段长度无效',
          '请重新导出为标准 XLSX 后重试',
        )
      }
      const headerId = view.getUint16(extraCursor, true)
      const dataSize = view.getUint16(extraCursor + 2, true)
      if (dataSize > extraEnd - extraCursor - 4) {
        throw zipError(
          filename,
          'ZIP 中央目录额外字段长度无效',
          '请重新导出为标准 XLSX 后重试',
        )
      }
      if (headerId === ZIP64_EXTRA_FIELD_ID) {
        throw zipError(
          filename,
          '检测到 ZIP64 条目额外字段，当前不支持',
          '请重新导出为小于限制的标准 XLSX 后重试',
        )
      }
      extraCursor += 4 + dataSize
    }
    if (localOffset >= centralOffset) {
      throw zipError(filename, 'ZIP 本地条目偏移无效', '请重新导出为标准 XLSX 后重试')
    }
    if (uncompressed > ION_ZIP_MAX_SINGLE_UNCOMPRESSED_BYTES) {
      throw zipError(
        filename,
        `单个 ZIP 条目声明解压大小超过 25 MiB`,
        '请拆分工作簿或移除异常的大型内容后重试',
      )
    }
    if (uncompressed > 0 && (compressed === 0 || uncompressed / compressed > ION_ZIP_MAX_COMPRESSION_RATIO)) {
      throw zipError(
        filename,
        `ZIP 条目声明压缩比超过 ${ION_ZIP_MAX_COMPRESSION_RATIO}:1`,
        '文件可能是压缩炸弹；请重新导出可信 XLSX 后重试',
      )
    }
    totalCompressedBytes += compressed
    totalUncompressedBytes += uncompressed
    if (totalUncompressedBytes > ION_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw zipError(
        filename,
        'ZIP 声明总解压大小超过 100 MiB',
        '请拆分工作簿后重试',
      )
    }
    if (userWorkbook && totalUncompressedBytes > USER_XLSX_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw zipError(
        filename,
        'user workbook declared total uncompressed size exceeds 64 MiB',
        '请拆分工作簿后重试',
      )
    }
    cursor = entryEnd
  }
  if (cursor !== centralEnd) {
    throw zipError(filename, 'ZIP 中央目录大小与条目不一致', '请重新导出为标准 XLSX 后重试')
  }
  if (totalCompressedBytes > centralOffset) {
    throw zipError(filename, 'ZIP 条目声明压缩大小超出文件数据范围', '请重新导出为标准 XLSX 后重试')
  }
  return { entries, totalCompressedBytes, totalUncompressedBytes, worksheets }
}

export function preflightIonWorkbookZip(
  input: ArrayBuffer,
  filename: string,
): IonZipPreflightResult {
  const { entries, totalCompressedBytes, totalUncompressedBytes } = preflightWorkbookZip(input, filename, false)
  return { entries, totalCompressedBytes, totalUncompressedBytes }
}

/** Applies the ion ZIP envelope plus tighter XML and sheet-count budgets. */
export function preflightUserWorkbookZip(
  input: ArrayBuffer,
  filename: string,
): UserWorkbookZipPreflightResult {
  return preflightWorkbookZip(input, filename, true)
}
