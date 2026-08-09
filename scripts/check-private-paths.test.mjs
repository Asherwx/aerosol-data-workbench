import assert from 'node:assert/strict'
import test from 'node:test'

import * as privacyAudit from './check-private-paths.mjs'

test('detects local design sessions with either path separator', () => {
  const forward = ['.superpowers', 'brainstorm', 'session-id', 'content', 'asset.png'].join('/')
  const backward = ['.superpowers', 'brainstorm', 'session-id', 'content', 'asset.png'].join('\\')
  const expected = 'LOCAL_DESIGN_SESSION'

  assert.ok(privacyAudit.findPrivateMarkers(forward).includes(expected))
  assert.ok(privacyAudit.findPrivateMarkers(backward).includes(expected))
  assert.deepEqual(privacyAudit.findPrivateMarkers('<LOCAL_DESIGN_SESSION>/content/asset.png'), [])
})

test('detects generic Windows, Unix, macOS, UNC and user-profile homes', () => {
  const samples = [
    ['D:', 'Users', 'alice', 'private', 'input.csv'].join('\\'),
    ['', 'home', 'alice', 'private', 'input.csv'].join('/'),
    ['', 'Users', 'alice', 'private', 'input.csv'].join('/'),
    ['', '', 'server', 'Users', 'alice', 'private', 'input.csv'].join('\\'),
    ['%USERPROFILE%', 'private', 'input.csv'].join('\\'),
  ]
  for (const sample of samples) assert.ok(privacyAudit.findPrivateMarkers(sample).length > 0)
  assert.deepEqual(privacyAudit.findPrivateMarkers('https://example.com/Users/alice/data.csv'), [])
})

test('inspects URL query and fragment values without flagging ordinary HTTPS paths', () => {
  const windowsHome = ['D:', 'Users', 'alice', 'private.csv'].join('\\')
  const linuxHome = ['', 'home', 'alice', 'private.csv'].join('/')
  const uncHome = ['', '', 'server', 'Users', 'alice', 'private.csv'].join('/')
  const encodedLinuxHome = ['%2Fhome', 'alice', 'private.csv'].join('%2F')
  const encodedUncHome = ['%5C%5Cserver', 'Users', 'alice', 'private.csv'].join('%5C')
  const encodedWindowsHome = ['%43%3A', 'Users', 'alice', 'private.csv'].join('%2F')
  const privateUrls = [
    `https://example.com/download?source=${windowsHome}`,
    `https://example.com/download?source=${linuxHome}`,
    `https://example.com/download#source=${uncHome}`,
    `https://example.com/download?source=${encodedLinuxHome}`,
    `https://example.com/download#source=${encodedUncHome}`,
    `https://example.com/${encodedWindowsHome}`,
  ]
  for (const value of privateUrls) {
    assert.ok(privacyAudit.findPrivateMarkers(value).length > 0, value)
  }

  for (const safe of [
    'https://example.com/Users/alice/data.csv',
    'https://example.com/reports/2024/data.csv?format=csv#download',
    'https://quotsoft.net/air/data/china_sites_20241101.csv',
  ]) assert.deepEqual(privacyAudit.findPrivateMarkers(safe), [], safe)
})

test('detects tracked private-fixture roots without flagging public synthetic fixtures', () => {
  const privateFixture = ['tests', 'private-fixtures', 'raw.csv'].join('/')
  const publicFixture = ['tests', 'fixtures', 'ions-small.xlsx'].join('/')
  assert.ok(privacyAudit.findPrivatePathMarkers(privateFixture).includes('PRIVATE_FIXTURE_PATH'))
  assert.deepEqual(privacyAudit.findPrivatePathMarkers(publicFixture), [])
})

test('decodes UTF-8, UTF-16LE and UTF-16BE text while rejecting binary data', () => {
  assert.equal(typeof privacyAudit.decodeTextBuffer, 'function')
  const text = ['D:', 'Users', 'alice', 'private.csv'].join('\\')
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  const littleEndianBody = Buffer.from(text, 'utf16le')
  const bigEndianBody = Buffer.alloc(littleEndianBody.length)
  for (let index = 0; index < littleEndianBody.length; index += 2) {
    bigEndianBody[index] = littleEndianBody[index + 1]
    bigEndianBody[index + 1] = littleEndianBody[index]
  }
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndianBody])

  for (const bytes of [Buffer.from(text, 'utf8'), utf16le, utf16be]) {
    const decoded = privacyAudit.decodeTextBuffer(bytes)
    assert.equal(typeof decoded, 'string')
    assert.ok(privacyAudit.findPrivateMarkers(decoded).length > 0)
  }
  assert.equal(privacyAudit.decodeTextBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x00, 0x80])), undefined)
})

test('detects personal contact details while allowing GitHub noreply identities', () => {
  assert.ok(privacyAudit.findSensitiveMetadataMarkers('alice@example.com').includes('NON_NOREPLY_EMAIL'))
  assert.ok(privacyAudit.findSensitiveMetadataMarkers('Call +1 (555) 010-1234').includes('PHONE_LIKE_TOKEN'))
  assert.deepEqual(
    privacyAudit.findSensitiveMetadataMarkers('123456+alice@users.noreply.github.com'),
    [],
  )
  assert.deepEqual(privacyAudit.findSensitiveMetadataMarkers('release 2024-11-01 for station 3329A'), [])
})

test('scans commit and annotated-tag identities and messages without exposing values', () => {
  const commit = [
    'tree 0000000000000000000000000000000000000000',
    'author Alice <alice@example.com> 1700000000 +0000',
    'committer Alice <123456+alice@users.noreply.github.com> 1700000000 +0000',
    '',
    'Call +1 (555) 010-1234',
  ].join('\n')
  assert.deepEqual(
    privacyAudit.findGitMetadataFindings('commit', commit).map(({ code, field }) => ({ code, field })),
    [
      { code: 'NON_NOREPLY_EMAIL', field: 'commit-identity-email' },
      { code: 'PHONE_LIKE_TOKEN', field: 'commit-message' },
    ],
  )

  const tag = [
    'object 0000000000000000000000000000000000000000',
    'type commit',
    'tag v1.0.0',
    'tagger Alice <alice@example.com> 1700000000 +0000',
    '',
    'Public release',
  ].join('\n')
  assert.deepEqual(
    privacyAudit.findGitMetadataFindings('tag', tag).map(({ code, field }) => ({ code, field })),
    [{ code: 'NON_NOREPLY_EMAIL', field: 'tag-identity-email' }],
  )
})
