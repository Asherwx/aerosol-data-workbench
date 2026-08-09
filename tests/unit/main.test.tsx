import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('application bootstrap', () => {
  let originalBodyHtml: string

  beforeEach(() => {
    originalBodyHtml = document.body.innerHTML
  })

  afterEach(() => {
    document.body.innerHTML = originalBodyHtml
    vi.resetModules()
  })

  it('reports a descriptive error when the root element is missing', async () => {
    document.body.innerHTML = ''

    await expect(import('../../src/main')).rejects.toThrow(
      '无法启动大气气溶胶数据工作台：页面中缺少 #root 元素。',
    )
  })
})
