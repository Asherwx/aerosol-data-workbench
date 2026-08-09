# Aerosol Data Workbench｜大气气溶胶数据工作台

一个面向大气气溶胶研究前处理的网页工具：获取或导入国控站六常规污染物数据，导入用户自己的 CSV/XLSX 数据，完成逐时整理、合并、质控和结果导出。

## 项目目的

本项目把数据来源、站点逐时序列、质量控制和结果导出整理成可重复的四阶段流程，降低前期数据整理的操作成本。网页用于初步整理和核查，不替代权威数据发布、仪器质控或研究者的科学判断。

## 在线地址

在线访问：

`https://asherwx.github.io/aerosol-data-workbench/`

逐日站点文件沿用 `china_sites_YYYYMMDD.csv` 命名。数据来自 [quotsoft.net 第三方公开镜像示例（2024-11-01）](https://quotsoft.net/air/data/china_sites_20241101.csv)，该镜像并非本项目或国家官方服务。使用者应自行确认来源授权、可用性、数据完整性和论文引用要求。

## 四阶段工作流

1. **STEP 01｜数据来源**提供三条并行路径：
   - **仅生成逐日原始链接**：按日期列出第三方镜像链接，不选择站点，也不会让站点数据进入后续处理；点击链接时由浏览器直接访问第三方站点。
   - **在线下载并直接处理站点数据**：选择日期和站点编号后，请求先发送到 Cloudflare Worker；Worker 获取固定上游文件、提取该站点并返回结果，网页同时下载一份站点 CSV 并直接进入后续处理。
   - **本地导入站点 CSV**：导入已有的逐日站点 CSV，本地文件由浏览器 Worker 解析，不上传到 Cloudflare Worker、GitHub Pages 或本项目服务器。
2. **STEP 02｜站点逐时序列**：整理 SO2、NO2、O3、CO、PM10 和 PM2.5，补齐连续逐时时间轴并标记缺测。
3. **STEP 03｜质量控制**：可以只运行**站点数据质控**，也可以导入用户数据后运行**站点 + 用户数据合并质控**；两个模式的结果互相独立。
4. **STEP 04｜结果导出**：按所选质控模式导出保留行、剔除行、质控汇总、元数据，以及 CSV、XLSX 和 ZIP 结果包。

每个阶段都可单独点击。准备好当前来源后，“一键完成”会从当前阶段继续执行，不会无条件重跑已经完成的阶段。运行期间可以取消；导出前仍应核对站点编号、时间范围、字段映射、单位和质控汇总。

## 数据来源与字段映射

站点逐日 CSV 需要 `date`、`hour`、`type` 和所选站点编号列，文件名为 `china_sites_YYYYMMDD.csv`。用户研究数据可导入 CSV 或 XLSX：系统会尝试识别时间列和数值列；识别不确定时必须先确认字段映射，才会进入合并质控。任意数值列都可参与动态质控，列名和单位会写入结果元数据。

六常规污染物输出列和单位如下：

| 变量 | 输出列 | 单位 |
| --- | --- | --- |
| SO2 | `SO2_μg_m3` | μg/m³ |
| NO2 | `NO2_μg_m3` | μg/m³ |
| O3 | `O3_μg_m3` | μg/m³ |
| CO | `CO_mg_m3` | mg/m³ |
| PM10 | `PM10_μg_m3` | μg/m³ |
| PM2.5 | `PM2.5_μg_m3` | μg/m³ |

兼容的离子数据列包括 `NO3_μg_m3`、`SO4_μg_m3` 和 `NH4_μg_m3`，单位均为 μg/m³。网页不会把零值自动当作缺测或删除；它会**保留零值**并生成相应的**质控标记**，供研究者结合原始记录判断。

## 数据隐私

本地导入的 CSV/XLSX 研究文件只在当前设备中读取，解析和导出在浏览器及其本地 Web Worker 内完成，**不会离开浏览器**。在线站点下载不是纯本地操作：请求会经过本项目的 Cloudflare Worker，Worker 仅访问配置中固定的 quotsoft.net 上游地址，并仅允许固定的 GitHub Pages 来源和本地开发来源通过 CORS。Worker 不接收本地上传文件。

请勿把原始研究数据、包含个人目录的日志、Cloudflare 凭据或未脱敏元数据提交到公开仓库。浏览器、Cloudflare 和第三方镜像各自适用其服务与日志政策。

## 支持的列和单位

站点模式支持六常规污染物；合并模式支持经字段映射确认的任意用户数值列。单位不会被在线服务自动校正，CSV/XLSX 中的单位含义、字段映射和最终科学解释均由使用者复核。标准站点列与兼容离子列见上一节。

## 本地开发

需要 Node.js 22、npm 和可运行 Python 3.12 的环境。先安装依赖：

```bash
npm ci
python -m pip install -r reference-python/requirements.txt -r reference-python/requirements-audit.txt
```

在未提交的 `.env.local` 中配置本地端点；`.env*.local` 已被 Git 忽略。HTTP 只允许用于 `localhost` 或 `127.0.0.1` 的开发、预览和测试：

```dotenv
VITE_STATION_API_URL=http://127.0.0.1:8787/v1/station-day
```

分别启动 Worker 和网页：

```bash
npm run worker:dev
npm run dev -- --host 127.0.0.1 --port 4173
```

本地发布验证与 Worker 无部署打包检查：

```bash
npm run verify:release
npm run worker:dry-run
```

普通 `npm run build` 可用于本地验证；GitHub Pages 使用 `npm run build:public`，并要求仓库变量提供非空、有效、无凭据和片段的 HTTPS `VITE_STATION_API_URL`。生产构建输出到 `dist/`，基路径为 `/aerosol-data-workbench/`。

## 部署

部署需要一个 Cloudflare 账号、Wrangler 登录权限，以及 GitHub 仓库管理权限。推荐按以下顺序操作：

1. 执行 `npm ci`，再用 `npx wrangler whoami` 确认账号；未登录时执行 `npx wrangler login`。
2. 执行 `npm run verify:release` 和 `npm run worker:dry-run`，确认测试、隐私审计、依赖审计、构建与浏览器测试全部通过。
3. 执行 `npm run worker:deploy`，记录 Wrangler 返回的 Worker HTTPS 地址，并在末尾添加 `/v1/station-day` 作为网页 API 地址。
4. 在 GitHub Actions secrets 中设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`；令牌只授予部署这个 Worker 所需的最小权限，不要写入文件或日志。
5. 在 GitHub repository variable 中设置 `VITE_STATION_API_URL`，值为上一步得到的完整 HTTPS API 地址。
6. 在 Settings → Pages 中把 Source 设为 **GitHub Actions**。推送 `main` 或手动运行 Pages 工作流后，同一次 Pages 发布会先调用 Worker 工作流完成测试、dry-run 和 Worker 部署，再验证 API URL、构建并部署 `dist/`；Worker 部署失败时不会构建或部署 Pages。PR 只执行 Worker 测试和 dry-run，不使用部署凭据；也可单独手动运行 Worker 工作流，非 `main` 分支仍只验证，只有 `main` 的非 PR 运行才部署。

`.github/workflows/deploy-worker.yml` 使用固定 Wrangler 版本部署 Worker；`.github/workflows/pages.yml` 执行公开发布契约、隐私与历史审计、Python/Node 依赖审计、单元测试、类型检查、浏览器端到端测试和生产构建。GitHub Pages 只能托管静态网页，**GitHub Pages 不能执行 Python**；Python 脚本仅供本地参考。

## 使用限制

- quotsoft.net 第三方镜像可能限流、暂时不可用、改变格式或缺少部分日期；生成链接不代表文件一定存在，Cloudflare Worker 也不保证第三方服务可用。
- Worker 仅做固定上游访问、站点提取和安全边界控制，不证明数据权威性，也不承担第三方镜像的授权、长期保存或服务连续性责任。
- 浏览器内处理受设备内存限制，大文件使用以**桌面端**为先，处理前关闭不必要页面并保留原始数据备份。
- 自动字段识别、时间匹配和质控标记只提供初步审计线索，不能代替仪器日志、现场校准和权威数据核验。
- 零值不被自动删除；需要结合污染物组合、连续性和其他来源判断它是真实低值还是异常占位。
- 输出结果的科学使用、quotsoft.net 等第三方数据的授权、合规、引用和解释责任由使用者承担。

## Python 参考脚本

[`reference-python/`](reference-python/) 提供可审阅的命令行参考实现：

- [`download_station_daily.py`](reference-python/download_station_daily.py)：批量下载严格命名的逐日 CSV，支持超时、重试、请求间隔、状态汇总和不联网的 `--dry-run`。
- [`extract_station_hourly.py`](reference-python/extract_station_hourly.py)：按站点编号提取六常规污染物，补齐连续逐时时间轴并标记缺测。

安装与调用示例见 [`reference-python/README.md`](reference-python/README.md)。这些脚本不会在 GitHub Pages 中运行，也不会被网页自动调用。
