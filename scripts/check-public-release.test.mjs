import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(path, 'utf8')

function yamlTopLevelBlock(source, key) {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `${key}:`)
  assert.notEqual(start, -1, `YAML missing top-level ${key}`)
  let end = start + 1
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end += 1
  return lines.slice(start, end).join('\n')
}

function yamlJobBlock(source, jobName) {
  const jobs = yamlTopLevelBlock(source, 'jobs').split('\n')
  const start = jobs.findIndex((line) => line === `  ${jobName}:`)
  assert.notEqual(start, -1, `YAML missing job ${jobName}`)
  let end = start + 1
  while (end < jobs.length && (jobs[end] === '' || !/^  \S/.test(jobs[end]))) end += 1
  return jobs.slice(start, end).join('\n')
}

test('Pages release structurally gates build and deployment on the reusable station Worker', () => {
  const pages = read('.github/workflows/pages.yml')
  const workerWorkflow = read('.github/workflows/deploy-worker.yml')
  const workerJob = yamlJobBlock(pages, 'worker')
  const buildJob = yamlJobBlock(pages, 'build')
  const pagesDeployJob = yamlJobBlock(pages, 'deploy')
  const workerTriggers = yamlTopLevelBlock(workerWorkflow, 'on')

  assert.match(workerJob, /^    uses: \.\/\.github\/workflows\/deploy-worker\.yml$/m)
  assert.match(workerJob, /^    secrets: inherit$/m)
  assert.match(workerJob, /^    permissions:\n      contents: read$/m)
  assert.match(buildJob, /^    needs: worker$/m)
  assert.match(pagesDeployJob, /^    needs: build$/m)
  assert.match(workerTriggers, /^  workflow_call:$/m)
  assert.match(workerTriggers, /^  workflow_dispatch:$/m)
  assert.doesNotMatch(workerTriggers, /^  (?:push|pull_request):$/m)

  const readme = read('README.md')
  assert.ok(readme.includes('同一次 Pages 发布'))
  assert.ok(readme.includes('Worker 部署失败时不会构建或部署 Pages'))
})

test('README documents the continuous public workflow, privacy boundary, and scientific units', () => {
  const readme = read('README.md')
  assert.ok(readme.includes('在线访问：'))
  assert.ok(!readme.includes('占位符'))
  const headings = [
    '项目目的',
    '在线地址',
    '四阶段工作流',
    '数据来源与字段映射',
    '数据隐私',
    '支持的列和单位',
    '本地开发',
    '部署',
    '使用限制',
    'Python 参考脚本',
  ]
  for (const heading of headings) assert.match(readme, new RegExp(`^## ${heading}$`, 'm'))

  for (const required of [
    'https://asherwx.github.io/aerosol-data-workbench/',
    'china_sites_YYYYMMDD.csv',
    'CO_mg_m3',
    'SO2_μg_m3',
    'NO3_μg_m3',
    'SO4_μg_m3',
    'NH4_μg_m3',
    '不会离开浏览器',
    'GitHub Pages 不能执行 Python',
    '桌面端',
    '保留零值',
    '质控标记',
    '第三方公开镜像',
    'STEP 01',
    '仅生成逐日原始链接',
    '在线下载并直接处理站点数据',
    '本地导入站点 CSV',
    '站点数据质控',
    '站点 + 用户数据合并质控',
    'Cloudflare Worker',
    'VITE_STATION_API_URL',
    'CSV',
    'XLSX',
    '本地文件由浏览器 Worker 解析',
    'quotsoft.net',
    'npm run dev -- --host 127.0.0.1 --port 4173',
  ]) assert.ok(readme.includes(required), `README 缺少：${required}`)
  assert.ok(!readme.includes('网页的正式工作流完全在浏览器内运行'))
})

test('Pages workflow validates and injects the public Worker URL before production deployment', () => {
  const workflow = read('.github/workflows/pages.yml')
  for (const required of [
    'push:',
    'pull_request:',
    'workflow_dispatch:',
    'contents: read',
    'pages: write',
    'id-token: write',
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'node-version: 22',
    'actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065',
    'pip install -r reference-python/requirements.txt',
    'pip install -r reference-python/requirements-audit.txt',
    'npm ci',
    'npm run verify:public',
    'npm run build:public',
    'npx playwright install --with-deps chromium',
    'npm run e2e',
    'actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b',
    'actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e',
    'actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b',
    'timeout-minutes:',
    'VITE_STATION_API_URL: ${{ vars.VITE_STATION_API_URL }}',
    'Validate production station API URL',
    "url.protocol !== 'https:'",
    'url.username || url.password || url.hash',
  ]) assert.ok(workflow.includes(required), `workflow 缺少：${required}`)
  for (const line of workflow.split(/\r?\n/).filter((entry) => entry.trim().startsWith('uses:'))) {
    if (line.trim().startsWith('uses: ./')) {
      assert.equal(line.trim(), 'uses: ./.github/workflows/deploy-worker.yml')
    } else {
      assert.match(line, /@[0-9a-f]{40}(?:\s+#\s+v\d+)?$/)
    }
  }
  const productionGate = "github.ref == 'refs/heads/main' && github.event_name != 'pull_request'"
  assert.equal(workflow.split(productionGate).length - 1, 4)
  assert.ok(workflow.includes("'pages-production'"))
  assert.doesNotMatch(workflow, /group:\s+pages-\$\{\{/)
  assert.match(read('vite.config.ts'), /\/aerosol-data-workbench\//)
})

test('production Pages builds fail closed on the canonical station API environment variable', () => {
  const viteConfig = read('vite.config.ts')
  const services = read('src/pipeline/defaultPipelineServices.ts')
  const envTypes = read('src/vite-env.d.ts')
  const playwright = read('playwright.config.ts')

  for (const required of [
    'loadEnv',
    "mode === 'pages'",
    'VITE_STATION_API_URL',
    "protocol !== 'https:'",
    'username || url.password || url.hash',
  ]) assert.ok(viteConfig.includes(required), `Vite production contract missing ${required}`)
  assert.match(services, /import\.meta\.env\.VITE_STATION_API_URL/)
  assert.doesNotMatch(services, /VITE_STATION_DATA_ENDPOINT/)
  assert.match(envTypes, /readonly VITE_STATION_API_URL\?: string/)
  assert.match(playwright, /VITE_STATION_API_URL:/)
  assert.doesNotMatch(playwright, /VITE_STATION_DATA_ENDPOINT/)
})

test('Worker configuration and deployment workflow are fixed, pinned, and main-only', () => {
  const wrangler = JSON.parse(read('worker/wrangler.jsonc'))
  assert.equal(wrangler.name, 'aerosol-station-data-api')
  assert.equal(wrangler.main, 'src/index.ts')
  assert.deepEqual(wrangler.vars, {
    SOURCE_BASE_URL: 'https://quotsoft.net/air/data',
    ALLOWED_ORIGINS: 'https://asherwx.github.io,http://127.0.0.1:4173',
  })

  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.devDependencies.wrangler, '4.120.0')
  assert.ok(pkg.scripts['verify:public'].includes('npm run worker:dry-run'))

  const workflow = read('.github/workflows/deploy-worker.yml')
  for (const required of [
    'workflow_call:',
    'workflow_dispatch:',
    'contents: read',
    'timeout-minutes: 10',
    "github.ref == 'refs/heads/main' && github.event_name != 'pull_request'",
    "'worker-production'",
    'npm run worker:test',
    'npm run worker:dry-run',
    'cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd # v3',
    'apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    'accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
    'wranglerVersion: "4.120.0"',
    'workingDirectory: worker',
    'command: deploy',
  ]) assert.ok(workflow.includes(required), `Worker workflow missing ${required}`)
  for (const line of workflow.split(/\r?\n/).filter((entry) => entry.trim().startsWith('uses:'))) {
    assert.match(line, /@[0-9a-f]{40}(?:\s+#\s+v\d+)?$/)
  }
  const credentialLines = workflow.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:apiToken|accountId):/.test(line))
  assert.deepEqual(credentialLines, [
    'apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    'accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
  ])
})

test('local Vite secrets stay untracked and public files contain no private paths or placeholders', () => {
  const gitignore = read('.gitignore')
  assert.match(gitignore, /^\.env\*\.local$/m)
  const publicContract = [
    '.github/workflows/pages.yml',
    '.github/workflows/deploy-worker.yml',
    'README.md',
    'vite.config.ts',
  ].map(read).join('\n')
  assert.doesNotMatch(publicContract, /[A-Za-z]:[\\/](?:Users|Documents|Desktop)[\\/]/i)
  assert.doesNotMatch(publicContract, /(?:your[-_ ]?(?:token|account|url)|replace[-_ ]?me|占位符)/i)
  assert.doesNotMatch(publicContract, /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)\s*[:=]\s*[A-Za-z0-9_-]{20,}/)
})

test('release scripts cannot skip scientific, privacy, audit, build, or browser checks', () => {
  const scripts = JSON.parse(read('package.json')).scripts
  for (const required of [
    'scripts/check-public-release.test.mjs',
    'python -m unittest discover',
    'npm test',
    'audit:privacy',
    'audit:privacy:history',
    'npm audit --omit=dev',
    'python -m pip_audit --strict --no-deps -r reference-python/requirements.txt',
    'npm run lint',
    'npm run build',
    'npm run worker:dry-run',
  ]) assert.ok(scripts['verify:public'].includes(required), `verify:public missing ${required}`)
  assert.equal(scripts['verify:release'], 'npm run verify:public && npm run e2e')
  assert.ok(read('README.md').includes('npm run verify:release'))
})

test('reference Python scripts are portable, bounded, and have safe CLI help', () => {
  const downloader = read('reference-python/download_station_daily.py')
  const extractor = read('reference-python/extract_station_hourly.py')
  const combined = `${downloader}\n${extractor}`

  assert.match(downloader, /MAX_DATE_SPAN_DAYS\s*=\s*366/)
  assert.match(downloader, /--output-dir/)
  assert.match(downloader, /--timeout/)
  assert.match(downloader, /--retries/)
  assert.match(downloader, /--dry-run/)
  assert.match(downloader, /拒绝覆盖已有文件/)
  assert.match(extractor, /--input-dir/)
  assert.match(extractor, /--output/)
  assert.match(extractor, /--overwrite/)
  assert.match(extractor, /拒绝覆盖已有文件/)
  assert.match(extractor, /validate_station_id/)
  assert.doesNotMatch(combined, /[A-Za-z]:[\\/](?:Users|Documents|Desktop)[\\/]/i)
  assert.doesNotMatch(combined, /(?:^|[\s"'])~[\\/]/m)

  for (const script of [
    'reference-python/download_station_daily.py',
    'reference-python/extract_station_hourly.py',
  ]) {
    execFileSync('python', ['-m', 'py_compile', script], { stdio: 'pipe' })
    const help = execFileSync('python', [script, '--help'], { encoding: 'utf8' })
    assert.match(help, /usage:/i)
  }
  execFileSync('python', [
    'reference-python/download_station_daily.py',
    '--start', '2024-01-01',
    '--end', '2024-01-02',
    '--output-dir', 'reference-python/dry-run-output',
    '--dry-run',
  ], { stdio: 'pipe' })

  const requirements = read('reference-python/requirements.txt')
    .split(/\r?\n/)
    .filter(Boolean)
  assert.ok(requirements.length >= 2)
  for (const dependency of requirements) {
    assert.match(dependency, /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+$/)
  }
  assert.deepEqual(requirements, [
    'certifi==2026.7.22',
    'charset-normalizer==3.4.9',
    'idna==3.18',
    'numpy==2.5.1',
    'pandas==3.0.5',
    'python-dateutil==2.9.0.post0',
    'pytz==2026.3.post1',
    'requests==2.34.2',
    'six==1.17.0',
    'tzdata==2026.3',
    'urllib3==2.7.0',
  ])
  assert.equal(read('reference-python/requirements-audit.txt').trim(), 'pip-audit==2.10.1')

  const pythonReadme = read('reference-python/README.md')
  for (const required of ['8784', '日期必须与文件名', '首次有限值', '错误文件', '--overwrite']) {
    assert.ok(pythonReadme.includes(required), `Python README missing ${required}`)
  }
})
