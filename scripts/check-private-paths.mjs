import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

const MAX_HISTORY_BLOB_BYTES = 16 * 1024 * 1024
const MAX_HISTORY_METADATA_BYTES = 1024 * 1024
const SAFE_URL_PATTERN = /\bhttps?:\/\/[^\s<>{}"']+/gi
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
const EMAIL_PATTERN = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/gi
const SAFE_NOREPLY_EMAIL_PATTERN = /^(?:(?:\d+\+)?[a-z0-9-]+@users\.noreply\.github\.com|noreply@github\.com)$/i
const PHONE_LIKE_PATTERN = /(?<![a-z0-9])(?:\+?\d{10,15}|\+?\d{1,3}[ .-]\(?\d{2,4}\)?(?:[ .-]\d{2,4}){2,4})(?![a-z0-9])/gi

const literalRules = [
  { code: 'XWECHAT_LOCAL_DATA', value: 'xwechat' + '_files' },
  { code: 'WECHAT_ID', value: 'wxid' + '_' },
  { code: 'LOCAL_DESIGN_SESSION', value: ['.superpowers', 'brainstorm'].join('/') },
  { code: 'PRIVATE_ION_DATASET_NAME', value: '颗粒物高新区2024年' + '组分数据水溶性离子' },
  { code: 'PRIVATE_CITY_DATASET_NAME', value: '淮南市' + ' -六常规.csv' },
]

const syntheticVectorsByFile = new Map([
  [
    ['tests', 'unit', 'exports.test.ts'].join('/'),
    [
      ['C:', 'Users', 'secret', 'raw.csv'].join('/'),
      ['', 'home', 'alice', 'private.csv'].join('/'),
      ['C:', 'Users', 'alice', 'private.csv'].join('/'),
    ],
  ],
  [
    ['tests', 'unit', 'usePipeline.test.tsx'].join('/'),
    [
      ['C:', 'Users', 'secret', 'bad.csv'].join('/'),
      ['', 'home', 'alice', 'private folder', 'input.csv'].join('/'),
      ['', 'home', 'alice', 'private%20data.csv'].join('/'),
    ],
  ],
])

export function normalizePathSeparators(value) {
  return value.replace(/\\+/g, '/')
}

function decodeUrlToken(value) {
  let decoded = value
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, '%20'))
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return decoded
}

function inspectableUrlReplacement(urlText) {
  const schemeEnd = urlText.indexOf('://') + 3
  const pathStart = urlText.indexOf('/', schemeEnd)
  const queryStart = urlText.indexOf('?', schemeEnd)
  const fragmentStart = urlText.indexOf('#', schemeEnd)
  const tokenStarts = [queryStart, fragmentStart].filter((index) => index >= 0)
  const suffixStart = tokenStarts.length > 0 ? Math.min(...tokenStarts) : urlText.length
  const encodedPath = pathStart >= 0 && pathStart < suffixStart
    ? urlText.slice(pathStart, suffixStart)
    : ''
  const queryAndFragment = suffixStart < urlText.length ? urlText.slice(suffixStart) : ''
  const inspectable = []

  if (/%[0-9a-f]{2}/i.test(encodedPath)) {
    inspectable.push(normalizePathSeparators(decodeUrlToken(encodedPath)))
  }
  if (queryAndFragment) {
    inspectable.push(
      queryAndFragment,
      normalizePathSeparators(decodeUrlToken(queryAndFragment)),
    )
  }
  return `<HTTPS_URL> ${inspectable.join(' ')}`
}

function withoutSafeUrls(value) {
  return value.replace(SAFE_URL_PATTERN, inspectableUrlReplacement)
}

export function findPrivateMarkers(value) {
  const normalized = withoutSafeUrls(normalizePathSeparators(value))
  const folded = normalized.toLocaleLowerCase('en-US')
  const codes = new Set()

  if (/(?:^|[^a-z0-9])[a-z]:\/users\/[^/\s<>:"|?*]+(?:\/|$)/i.test(normalized)) {
    codes.add('WINDOWS_USER_HOME')
  }
  if (/(?:^|[^a-z0-9:])\/(?:home|users)\/[^/\s<>:"|?*]+(?:\/|$)/i.test(normalized)) {
    codes.add('UNIX_USER_HOME')
  }
  if (/(?:^|[^a-z0-9:])\/[^/\s<>:"|?*]+\/(?:home|users)\/[^/\s<>:"|?*]+(?:\/|$)/i.test(normalized)) {
    codes.add('UNC_USER_HOME')
  }
  if (/(?:%userprofile%|\$env:userprofile|\$\{?userprofile\}?)(?:\/|$)/i.test(normalized)
      || /(?:^|[\s="'(])~\//.test(normalized)) {
    codes.add('USER_PROFILE_REFERENCE')
  }
  for (const rule of literalRules) {
    if (folded.includes(rule.value.toLocaleLowerCase('en-US'))) codes.add(rule.code)
  }
  return [...codes]
}

export function findSensitiveMetadataMarkers(value) {
  const codes = new Set()
  const emails = value.match(EMAIL_PATTERN) ?? []
  if (emails.some((email) => !SAFE_NOREPLY_EMAIL_PATTERN.test(email))) {
    codes.add('NON_NOREPLY_EMAIL')
  }
  const withoutEmails = value.replace(EMAIL_PATTERN, '<EMAIL>')
  if (PHONE_LIKE_PATTERN.test(withoutEmails)) codes.add('PHONE_LIKE_TOKEN')
  PHONE_LIKE_PATTERN.lastIndex = 0
  return [...codes]
}

export function findGitMetadataFindings(objectType, content) {
  if (objectType !== 'commit' && objectType !== 'tag') return []
  const separator = content.indexOf('\n\n')
  const header = separator === -1 ? content : content.slice(0, separator)
  const message = separator === -1 ? '' : content.slice(separator + 2)
  const identityHeader = objectType === 'commit' ? /^(author|committer) / : /^tagger /
  const findings = []

  for (const line of header.split('\n')) {
    if (!identityHeader.test(line)) continue
    const identity = line.match(/^(?:author|committer|tagger) (.*) <([^<>]*)> \d+ [+-]\d{4}$/)
    if (!identity) {
      findings.push({ code: 'UNPARSEABLE_GIT_IDENTITY', field: `${objectType}-identity` })
      continue
    }
    for (const code of findSensitiveMetadataMarkers(identity[1])) {
      findings.push({ code, field: `${objectType}-identity-name` })
    }
    for (const code of findSensitiveMetadataMarkers(identity[2])) {
      findings.push({ code, field: `${objectType}-identity-email` })
    }
  }
  for (const code of findSensitiveMetadataMarkers(message)) {
    findings.push({ code, field: `${objectType}-message` })
  }
  return findings
}

export function findPrivatePathMarkers(path) {
  const normalized = normalizePathSeparators(path)
  const codes = new Set(findPrivateMarkers(normalized))
  const folded = normalized.toLocaleLowerCase('en-US')
  const privateRoots = [
    ['tests', 'private-fixtures'].join('/'),
    ['research-data'].join('/'),
    ['artifacts'].join('/'),
  ]
  if (privateRoots.some((root) => folded === root || folded.startsWith(`${root}/`))) {
    codes.add('PRIVATE_FIXTURE_PATH')
  }
  return [...codes]
}

function plausibleText(value) {
  if (value.length === 0) return true
  const controls = value.match(CONTROL_PATTERN)?.length ?? 0
  const replacements = value.match(/\ufffd/g)?.length ?? 0
  return controls / value.length <= 0.01 && replacements === 0
}

function decodeWith(bytes, encoding, offset = 0) {
  try {
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset))
    return plausibleText(decoded) ? decoded.replace(/^\ufeff/, '') : undefined
  } catch {
    return undefined
  }
}

export function decodeTextBuffer(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeWith(bytes, 'utf-16le', 2)
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeWith(bytes, 'utf-16be', 2)
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeWith(bytes, 'utf-8', 3)
  }

  const pairs = Math.floor(bytes.length / 2)
  if (pairs > 1) {
    let evenNulls = 0
    let oddNulls = 0
    for (let index = 0; index < pairs * 2; index += 2) {
      if (bytes[index] === 0) evenNulls += 1
      if (bytes[index + 1] === 0) oddNulls += 1
    }
    if (oddNulls / pairs >= 0.3 && evenNulls / pairs <= 0.05) return decodeWith(bytes, 'utf-16le')
    if (evenNulls / pairs >= 0.3 && oddNulls / pairs <= 0.05) return decodeWith(bytes, 'utf-16be')
  }
  if (bytes.includes(0)) return undefined
  return decodeWith(bytes, 'utf-8')
}

function stripAllowedSyntheticVectors(file, value) {
  let normalized = normalizePathSeparators(value)
  for (const vector of syntheticVectorsByFile.get(normalizePathSeparators(file)) ?? []) {
    normalized = normalized.replaceAll(vector, '<SYNTHETIC_REDACTION_TEST_PATH>')
  }
  return normalized
}

function scanDecodedContent(file, content, scope, objectId) {
  const findings = []
  const lines = content.split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const code of findPrivateMarkers(stripAllowedSyntheticVectors(file, line))) {
      findings.push({ scope, file, line: index + 1, code, objectId })
    }
  })
  return findings
}

export function auditTrackedFiles() {
  const repositoryFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const findings = []

  for (const file of repositoryFiles) {
    for (const code of findPrivatePathMarkers(file)) {
      findings.push({ scope: 'current-path', file, code })
    }
    const content = decodeTextBuffer(readFileSync(file))
    if (content !== undefined) findings.push(...scanDecodedContent(file, content, 'current-content'))
  }
  return { repositoryFiles, findings }
}

export function auditGitHistory() {
  const records = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'rev-list', '--objects', '--all'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf(' ')
    return separator === -1
      ? { objectId: line, file: '' }
      : { objectId: line.slice(0, separator), file: line.slice(separator + 1) }
  })
  const objectIds = [...new Set(records.map(({ objectId }) => objectId))]
  const typeLines = execFileSync(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    { input: `${objectIds.join('\n')}\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim().split(/\r?\n/)
  const objectInfo = new Map(typeLines.map((line) => {
    const [objectId, type, size] = line.split(' ')
    return [objectId, { type, size: Number(size) }]
  }))
  const findings = []
  const scannedContent = new Set()

  for (const objectId of objectIds) {
    const info = objectInfo.get(objectId)
    if (info?.type !== 'commit' && info?.type !== 'tag') continue
    if (info.size > MAX_HISTORY_METADATA_BYTES) {
      findings.push({ scope: 'history-metadata', code: 'OVERSIZED_GIT_METADATA', objectId })
      continue
    }
    const metadata = execFileSync('git', ['cat-file', '-p', objectId], {
      encoding: 'utf8',
      maxBuffer: MAX_HISTORY_METADATA_BYTES + 1024,
    })
    for (const finding of findGitMetadataFindings(info.type, metadata)) {
      findings.push({ scope: 'history-metadata', objectId, ...finding })
    }
  }

  for (const record of records) {
    const info = objectInfo.get(record.objectId)
    if (info?.type !== 'blob') continue
    for (const code of findPrivatePathMarkers(record.file)) {
      findings.push({ scope: 'history-path', code, objectId: record.objectId })
    }
    if (scannedContent.has(record.objectId) || info.size > MAX_HISTORY_BLOB_BYTES) continue
    scannedContent.add(record.objectId)
    const bytes = execFileSync('git', ['cat-file', '-p', record.objectId], {
      encoding: 'buffer',
      maxBuffer: MAX_HISTORY_BLOB_BYTES + 1024,
    })
    const content = decodeTextBuffer(bytes)
    if (content !== undefined) {
      findings.push(...scanDecodedContent(record.file, content, 'history-content', record.objectId))
    }
  }
  return { objectCount: objectIds.length, findings }
}

function findingSummary(findings) {
  const counts = new Map()
  for (const { code } of findings) counts.set(code, (counts.get(code) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([code, count]) => `${code}=${count}`)
    .join(', ')
}

function main() {
  const history = process.argv.includes('--history')
  const result = history ? auditGitHistory() : auditTrackedFiles()
  if (result.findings.length > 0) {
    console.error(
      `${history ? 'Privacy history audit' : 'Privacy audit'} failed with ${result.findings.length} finding(s). Markers: ${findingSummary(result.findings)}`,
    )
    process.exitCode = 1
  } else {
    const count = history ? result.objectCount : result.repositoryFiles.length
    console.log(`${history ? 'Privacy history audit' : 'Privacy audit'} passed for ${count} ${history ? 'reachable objects' : 'tracked files'}.`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
