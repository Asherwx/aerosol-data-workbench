"""Download daily station CSV files from a third-party public mirror."""

from __future__ import annotations

import argparse
import csv
import os
import re
import tempfile
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


URL_TEMPLATE = "https://quotsoft.net/air/data/china_sites_{date}.csv"
MAX_DATE_SPAN_DAYS = 366
DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
FILENAME_PATTERN = re.compile(r"^china_sites_\d{8}\.csv$")


def parse_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as error:
        raise argparse.ArgumentTypeError("日期必须使用 YYYY-MM-DD 格式") from error


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="从第三方公开镜像下载逐日站点空气质量 CSV"
    )
    parser.add_argument("--start", type=parse_date, required=True, help="开始日期 YYYY-MM-DD")
    parser.add_argument("--end", type=parse_date, required=True, help="结束日期 YYYY-MM-DD")
    parser.add_argument("--output-dir", type=Path, required=True, help="CSV 保存目录")
    parser.add_argument("--timeout", type=float, default=60.0, help="读取超时秒数，默认 60")
    parser.add_argument("--retries", type=int, default=3, help="失败重试次数，默认 3")
    parser.add_argument("--delay", type=float, default=0.5, help="相邻请求间隔秒数")
    parser.add_argument("--max-file-mib", type=int, default=64, help="单文件大小上限 MiB，默认 64")
    parser.add_argument("--overwrite", action="store_true", help="明确允许覆盖同名文件")
    parser.add_argument("--dry-run", action="store_true", help="只显示计划，不联网或写文件")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.end < args.start:
        raise ValueError("结束日期不能早于开始日期")
    span = (args.end - args.start).days + 1
    if span > MAX_DATE_SPAN_DAYS:
        raise ValueError(f"单次最多下载 {MAX_DATE_SPAN_DAYS} 天，当前为 {span} 天")
    if args.timeout <= 0:
        raise ValueError("--timeout 必须大于 0")
    if not 0 <= args.retries <= 10:
        raise ValueError("--retries 必须在 0 到 10 之间")
    if args.delay < 0:
        raise ValueError("--delay 不能小于 0")
    if not 1 <= args.max_file_mib <= 256:
        raise ValueError("--max-file-mib 必须在 1 到 256 之间")


def build_session(retries: int) -> requests.Session:
    retry = Retry(
        total=retries,
        connect=retries,
        read=retries,
        backoff_factor=1.0,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
    )
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.headers.update({"User-Agent": "Aerosol-Data-Workbench-Reference/1.0"})
    return session


def looks_like_station_csv(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size == 0:
        return False
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle)
            header = next(reader)
            if len(header) != len(set(header)):
                return False
            required = {"date", "hour", "type"}
            if not required.issubset(header):
                return False
            required_indexes = [header.index(column) for column in required]
            record_count = 0
            for record in reader:
                record_count += 1
                if len(record) != len(header):
                    return False
                if any(not record[index].strip() for index in required_indexes):
                    return False
    except (OSError, UnicodeError, csv.Error, StopIteration):
        return False
    return record_count > 0


def download_file(
    session: requests.Session,
    url: str,
    destination: Path,
    timeout: float,
    overwrite: bool,
    max_bytes: int = DEFAULT_MAX_FILE_BYTES,
) -> str:
    """Download and validate one file without silently clobbering another writer."""
    if destination.exists() and not overwrite:
        raise FileExistsError("拒绝覆盖已有文件；请明确使用 --overwrite")

    owned_temporary: Path | None = None
    try:
        with session.get(url, timeout=(10, timeout), stream=True) as response:
            response.raise_for_status()
            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                try:
                    declared_bytes = int(content_length)
                except ValueError as error:
                    raise ValueError("响应 Content-Length 无效") from error
                if declared_bytes < 0 or declared_bytes > max_bytes:
                    raise ValueError(f"响应超过大小上限 {max_bytes:,} bytes")

            destination.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="xb",
                prefix=f"{destination.name}.",
                suffix=".part",
                dir=destination.parent,
                delete=False,
            ) as handle:
                owned_temporary = Path(handle.name)
                downloaded_bytes = 0
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    downloaded_bytes += len(chunk)
                    if downloaded_bytes > max_bytes:
                        raise ValueError(f"响应超过大小上限 {max_bytes:,} bytes")
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())

        if owned_temporary is None or not looks_like_station_csv(owned_temporary):
            raise ValueError("响应内容不是具有有效表头和数据行的站点 CSV")

        if overwrite:
            os.replace(owned_temporary, destination)
            owned_temporary = None
        else:
            try:
                os.link(owned_temporary, destination)
            except FileExistsError as error:
                raise FileExistsError("并发写入检测：拒绝覆盖刚创建的目标文件") from error
        return "downloaded"
    finally:
        if owned_temporary is not None:
            owned_temporary.unlink(missing_ok=True)


def iter_dates(start: date, end: date):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def main() -> None:
    args = parse_args()
    try:
        validate_args(args)
    except ValueError as error:
        raise SystemExit(f"参数错误：{error}") from None
    plan = list(iter_dates(args.start, args.end))
    print(f"计划：{args.start} 至 {args.end}，共 {len(plan)} 天")
    print(f"输出目录：{args.output_dir}")

    if args.dry_run:
        for current in plan:
            filename = f"china_sites_{current:%Y%m%d}.csv"
            print(f"[计划] {URL_TEMPLATE.format(date=current.strftime('%Y%m%d'))} -> {filename}")
        print("dry-run 完成：未联网、未创建目录、未写入文件")
        return

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    session = build_session(args.retries)
    succeeded = skipped = 0
    failed: list[tuple[str, str]] = []

    for index, current in enumerate(plan):
        date_token = current.strftime("%Y%m%d")
        filename = f"china_sites_{date_token}.csv"
        if not FILENAME_PATTERN.fullmatch(filename):
            raise ValueError(f"拒绝不安全的文件名：{filename}")
        destination = output_dir / filename
        url = URL_TEMPLATE.format(date=date_token)

        if destination.exists() and not args.overwrite:
            if looks_like_station_csv(destination):
                print(f"[跳过] 已存在有效文件：{filename}")
                skipped += 1
            else:
                reason = "拒绝覆盖已有文件；请检查文件或明确使用 --overwrite"
                print(f"[失败] {filename}：{reason}")
                failed.append((filename, reason))
            continue

        print(f"[下载] {url}")
        try:
            download_file(
                session,
                url,
                destination,
                args.timeout,
                args.overwrite,
                args.max_file_mib * 1024 * 1024,
            )
            succeeded += 1
            print(f"[成功] {filename}，{destination.stat().st_size:,} bytes")
        except Exception as error:  # 汇总单日失败并继续其他日期
            failed.append((filename, str(error)))
            print(f"[失败] {filename}：{error}")

        if index < len(plan) - 1:
            time.sleep(args.delay)

    print(f"完成：成功 {succeeded}；跳过 {skipped}；失败 {len(failed)}")
    for filename, reason in failed:
        print(f"  - {filename}: {reason}")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
