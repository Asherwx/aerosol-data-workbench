# Python 命令行参考

这些脚本用于复核网页的“下载逐日站点数据”和“提取站点逐时六常规”逻辑。数据地址来自第三方公开镜像，不代表官方服务；使用前请确认数据授权、完整性和引用方式。

## 安装

```bash
python -m pip install -r reference-python/requirements.txt -r reference-python/requirements-audit.txt
```

## 只检查下载计划（不联网、不写文件）

```bash
python reference-python/download_station_daily.py --start 2024-11-01 --end 2024-11-03 --output-dir station-csv --dry-run
```

删除 `--dry-run` 才会真正请求文件。单次最多 366 天，单文件默认上限 64 MiB；下载器会同时检查响应声明大小与实际流式字节数，并在发布文件前验证完整 CSV 结构。已有有效文件默认跳过；如确需更新可添加 `--overwrite`。

## 提取一个站点

```bash
python reference-python/extract_station_hourly.py --input-dir station-csv --station 3329A --output station-3329A-hourly.csv
```

输出以连续小时排列。缺测保留为空值并写入“缺测项目”和“数据状态”，不会用零填补。SO2、NO2、O3、PM10、PM2.5 单位为 μg/m³，CO 单位为 mg/m³。两个脚本都不会默认覆盖已有文件；确认需要覆盖时才添加 `--overwrite`。

提取脚本会逐一报告所有 `china_sites_*.csv` 候选文件的处理结果。每行日期必须与文件名中的日期一致，小时必须是 0–23 的整数；缺少必要列或站点列的错误文件会阻止输出。重复的同一小时、同一污染物采用首次有限值，若后续有限值不同则写出警告，不做平均。连续时间轴在分配前限制为 8784 小时。

运行 `npm run verify:public` 时，固定版本的 `pip-audit` 会依据 Python Packaging Advisory Database 检查运行时依赖；审计工具单独保存在 `requirements-audit.txt`，不加入参考脚本的运行时依赖。
