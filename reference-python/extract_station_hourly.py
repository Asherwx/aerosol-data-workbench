"""Extract one station's six conventional pollutants into an audited hourly table."""

from __future__ import annotations

import argparse
import math
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pandas as pd


POLLUTANTS = ("SO2", "NO2", "O3", "CO", "PM10", "PM2.5")
OUTPUT_COLUMNS = {
    "SO2": "SO2_μg_m3",
    "NO2": "NO2_μg_m3",
    "O3": "O3_μg_m3",
    "CO": "CO_mg_m3",
    "PM10": "PM10_μg_m3",
    "PM2.5": "PM2.5_μg_m3",
}
CANDIDATE_PATTERN = re.compile(r"^china_sites_.*\.csv$", re.IGNORECASE)
SOURCE_PATTERN = re.compile(r"^china_sites_(\d{8})\.csv$", re.IGNORECASE)
STATION_PATTERN = re.compile(r"^[0-9A-Za-z_-]{1,32}$")
COMPACT_DATE_PATTERN = re.compile(r"^\d{8}$")
INTEGER_HOUR_PATTERN = re.compile(r"^(?:[0-9]|1[0-9]|2[0-3])$")
MAX_SOURCE_FILES = 366
MAX_TIMELINE_HOURS = 366 * 24
REQUIRED_COLUMNS = ("date", "hour", "type")


@dataclass(frozen=True)
class FileOutcome:
    filename: str
    status: str
    detail: str
    records: int = 0


@dataclass
class ExtractionResult:
    frame: pd.DataFrame
    outcomes: list[FileOutcome]
    warnings: list[str]

    @property
    def has_errors(self) -> bool:
        return any(item.status == "error" for item in self.outcomes)


def validate_station_id(value: str) -> str:
    station = value.strip()
    if not STATION_PATTERN.fullmatch(station):
        raise argparse.ArgumentTypeError("站点编号只能包含字母、数字、下划线或连字符")
    return station


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从逐日 CSV 提取指定站点的逐时六常规污染物")
    parser.add_argument("--input-dir", type=Path, required=True, help="逐日 CSV 文件夹")
    parser.add_argument("--station", type=validate_station_id, required=True, help="站点编号，例如 3329A")
    parser.add_argument("--output", type=Path, required=True, help="输出 CSV 文件")
    parser.add_argument("--overwrite", action="store_true", help="明确允许覆盖已有输出文件")
    return parser.parse_args()


def discover_candidates(input_dir: Path) -> list[Path]:
    if not input_dir.is_dir():
        raise FileNotFoundError(f"输入目录不存在：{input_dir}")
    candidates = sorted(
        (path for path in input_dir.iterdir() if path.is_file() and CANDIDATE_PATTERN.fullmatch(path.name)),
        key=lambda path: path.name,
    )
    if not candidates:
        raise FileNotFoundError("没有找到 china_sites_*.csv 候选文件")
    if len(candidates) > MAX_SOURCE_FILES:
        raise ValueError(f"单次最多处理 {MAX_SOURCE_FILES} 个逐日文件")
    return candidates


def parse_compact_date(value: str) -> pd.Timestamp | None:
    if not COMPACT_DATE_PATTERN.fullmatch(value):
        return None
    parsed = pd.to_datetime(value, format="%Y%m%d", errors="coerce")
    return None if pd.isna(parsed) else parsed


def parse_measurement(raw_value) -> tuple[str, float | None, str]:
    if pd.isna(raw_value) or str(raw_value).strip() == "":
        return "missing", None, ""
    text = str(raw_value).strip()
    try:
        value = float(text)
    except ValueError:
        return "invalid", None, text
    if not math.isfinite(value):
        return "invalid", None, text
    return "finite", value, text


def build_continuous_frame(records: list[dict]) -> pd.DataFrame:
    columns = ["时间", *OUTPUT_COLUMNS.values(), "缺测项目", "数据状态"]
    if not records:
        return pd.DataFrame(columns=columns)

    minimum = min(record["timestamp"] for record in records)
    maximum = max(record["timestamp"] for record in records)
    start = pd.Timestamp(minimum)
    end = pd.Timestamp(maximum)
    hour_count = int((end - start) / pd.Timedelta(hours=1)) + 1
    if hour_count > MAX_TIMELINE_HOURS:
        raise ValueError(f"连续时间轴超过安全上限 {MAX_TIMELINE_HOURS} 小时")

    timeline = pd.date_range(start, end, freq="h")
    indexed: dict[pd.Timestamp, dict] = {}
    for record in records:
        timestamp = pd.Timestamp(record["timestamp"])
        row = indexed.setdefault(timestamp, {})
        for pollutant in POLLUTANTS:
            value = record.get(pollutant)
            if value is not None and math.isfinite(value) and pollutant not in row:
                row[pollutant] = value

    rows = []
    for timestamp in timeline:
        source = indexed.get(timestamp, {})
        row = {"时间": timestamp}
        missing = []
        for pollutant, output_column in OUTPUT_COLUMNS.items():
            value = source.get(pollutant)
            row[output_column] = value if value is not None and math.isfinite(value) else pd.NA
            if pd.isna(row[output_column]):
                missing.append(pollutant)
        row["缺测项目"] = "、".join(missing)
        row["数据状态"] = "完整" if not missing else "存在缺测"
        rows.append(row)
    return pd.DataFrame(rows, columns=columns)


def parse_candidate(file: Path, station: str) -> tuple[list[dict], list[str]]:
    name_match = SOURCE_PATTERN.fullmatch(file.name)
    if not name_match:
        raise ValueError("文件名必须严格符合 china_sites_YYYYMMDD.csv")
    expected_date = name_match.group(1)
    if parse_compact_date(expected_date) is None:
        raise ValueError("文件名日期无效")

    data = pd.read_csv(file, dtype=str, keep_default_na=False)
    missing_columns = [column for column in (*REQUIRED_COLUMNS, station) if column not in data.columns]
    if missing_columns:
        if station in missing_columns:
            raise ValueError(f"站点列不存在：{station}；缺少列：{'、'.join(missing_columns)}")
        raise ValueError(f"必要列不存在：{'、'.join(missing_columns)}")

    file_warnings: list[str] = []
    records_by_time: dict[str, dict] = {}
    seen: dict[tuple[str, str], tuple[bool, str]] = {}

    for index, row in data.iterrows():
        csv_row = index + 2
        raw_date = str(row["date"]).strip()
        if raw_date != expected_date:
            raise ValueError(f"第 {csv_row} 行日期与文件名不一致：预期 {expected_date}，实际 {raw_date}")
        parsed_date = parse_compact_date(raw_date)
        if parsed_date is None:
            raise ValueError(f"第 {csv_row} 行日期无效：{raw_date}")
        raw_hour = str(row["hour"]).strip()
        if not INTEGER_HOUR_PATTERN.fullmatch(raw_hour):
            raise ValueError(f"第 {csv_row} 行小时必须是 0..23 的整数：{raw_hour}")

        pollutant = str(row["type"]).strip()
        if pollutant not in POLLUTANTS:
            continue
        timestamp = f"{parsed_date:%Y-%m-%d} {int(raw_hour):02d}:00:00"
        record = records_by_time.setdefault(timestamp, {"timestamp": timestamp})
        kind, value, raw_measurement = parse_measurement(row[station])
        key = (timestamp, pollutant)

        if kind == "invalid":
            file_warnings.append(
                f"{file.name} 第 {csv_row} 行 {timestamp} {pollutant} 数值无效：{raw_measurement}；按缺测处理"
            )

        prior = seen.get(key)
        if prior is None:
            seen[key] = (kind == "finite", kind)
            if kind == "finite":
                record[pollutant] = value
            continue

        has_finite, initial_kind = prior
        if not has_finite and kind == "finite":
            record[pollutant] = value
            seen[key] = (True, initial_kind)
            file_warnings.append(
                f"{file.name} 第 {csv_row} 行 {timestamp} {pollutant} 重复；用首次有限值替换先前{initial_kind}值"
            )
        elif has_finite and kind == "finite":
            first_value = record[pollutant]
            if first_value != value:
                file_warnings.append(
                    f"{file.name} 第 {csv_row} 行 {timestamp} {pollutant} 存在不同重复有限值；保留首次有限值 {first_value}，忽略 {value}"
                )
        else:
            file_warnings.append(
                f"{file.name} 第 {csv_row} 行 {timestamp} {pollutant} 重复；未获得新的有限值"
            )

    return list(records_by_time.values()), file_warnings


def extract_station_files(input_dir: Path, station: str) -> ExtractionResult:
    station = validate_station_id(station)
    candidates = discover_candidates(input_dir)
    outcomes: list[FileOutcome] = []
    warnings: list[str] = []
    records: list[dict] = []

    for file in candidates:
        try:
            file_records, file_warnings = parse_candidate(file, station)
            records.extend(file_records)
            warnings.extend(file_warnings)
            outcomes.append(FileOutcome(file.name, "processed", "处理完成", len(file_records)))
        except (OSError, UnicodeError, pd.errors.ParserError, ValueError) as error:
            outcomes.append(FileOutcome(file.name, "error", str(error), 0))

    frame = build_continuous_frame(records)
    return ExtractionResult(frame=frame, outcomes=outcomes, warnings=warnings)


def write_extraction_csv(frame: pd.DataFrame, output: Path, overwrite: bool) -> None:
    """Atomically publish a CSV while cleaning only this call's temporary file."""
    if output.exists() and not overwrite:
        raise FileExistsError("拒绝覆盖已有文件；请明确使用 --overwrite")
    output.parent.mkdir(parents=True, exist_ok=True)

    owned_temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="x",
            encoding="utf-8-sig",
            newline="",
            prefix=f"{output.name}.",
            suffix=".part",
            dir=output.parent,
            delete=False,
        ) as handle:
            owned_temporary = Path(handle.name)
            frame.to_csv(handle, index=False, date_format="%Y-%m-%d %H:%M:%S")
            handle.flush()
            os.fsync(handle.fileno())

        if overwrite:
            os.replace(owned_temporary, output)
            owned_temporary = None
        else:
            try:
                os.link(owned_temporary, output)
            except FileExistsError as error:
                raise FileExistsError("并发写入检测：拒绝覆盖刚创建的输出文件") from error
    finally:
        if owned_temporary is not None:
            owned_temporary.unlink(missing_ok=True)


def main() -> None:
    args = parse_args()
    try:
        result = extract_station_files(args.input_dir.resolve(), args.station)
    except (FileNotFoundError, OSError, ValueError) as error:
        raise SystemExit(f"输入错误：{error}") from None
    print("文件审计汇总：")
    for outcome in result.outcomes:
        print(f"  [{outcome.status}] {outcome.filename}: {outcome.detail}；记录 {outcome.records}")
    for warning in result.warnings:
        print(f"  [warning] {warning}")
    if result.has_errors:
        raise SystemExit("存在错误文件，已拒绝输出；请根据审计汇总修正后重试")
    if result.frame.empty:
        raise SystemExit(f"未找到站点 {args.station} 的六常规有效记录")

    output = args.output.resolve()
    if output.suffix.lower() != ".csv":
        raise SystemExit("--output 必须是 .csv 文件")
    try:
        write_extraction_csv(result.frame, output, args.overwrite)
    except OSError as error:
        raise SystemExit(f"输出错误：{error}") from None
    print(f"输出小时数：{len(result.frame)}；输出文件：{output}")
    print("各污染物缺测小时数：")
    print(result.frame[list(OUTPUT_COLUMNS.values())].isna().sum().to_string())


if __name__ == "__main__":
    main()
