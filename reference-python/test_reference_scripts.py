from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import requests
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


downloader = load_module("reference_downloader", "download_station_daily.py")
extractor = load_module("reference_extractor", "extract_station_hourly.py")


class FakeResponse:
    def __init__(self, chunks=(), content_length=None, status_error=None):
        self.chunks = list(chunks)
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)
        self.status_error = status_error

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def raise_for_status(self):
        if self.status_error:
            raise self.status_error

    def iter_content(self, chunk_size):
        del chunk_size
        yield from self.chunks


class FakeSession:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.error:
            raise self.error
        return self.response


VALID_CSV = b"date,hour,type,3329A\n20241101,0,SO2,3\n"


class DownloaderTests(unittest.TestCase):
    def assert_no_parts(self, directory: Path):
        self.assertEqual(list(directory.glob("*.part")), [])

    def test_rejects_content_length_over_cap_without_writing(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            destination = folder / "china_sites_20241101.csv"
            session = FakeSession(FakeResponse([VALID_CSV], content_length=101))
            with self.assertRaisesRegex(ValueError, "超过大小上限"):
                downloader.download_file(session, "https://example.test/data.csv", destination, 5, False, 100)
            self.assertFalse(destination.exists())
            self.assert_no_parts(folder)

    def test_enforces_streamed_byte_cap_and_cleans_owned_temp(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            destination = folder / "china_sites_20241101.csv"
            session = FakeSession(FakeResponse([b"a" * 60, b"b" * 60]))
            with self.assertRaisesRegex(ValueError, "超过大小上限"):
                downloader.download_file(session, "https://example.test/data.csv", destination, 5, False, 100)
            self.assertFalse(destination.exists())
            self.assert_no_parts(folder)

    def test_rejects_invalid_header_or_empty_content_and_cleans_temp(self):
        for payload in [
            b"not,a,station,csv\n1,2,3,4\n",
            b"date,hour,type,3329A\n",
            b"date,hour,type,3329A\n20241101,0,SO2,3\n20241101,1,NO2\n",
            b"date,hour,type,3329A\n,0,SO2,3\n",
        ]:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as temporary:
                folder = Path(temporary)
                destination = folder / "china_sites_20241101.csv"
                session = FakeSession(FakeResponse([payload]))
                with self.assertRaisesRegex(ValueError, "有效"):
                    downloader.download_file(session, "https://example.test/data.csv", destination, 5, False, 1000)
                self.assert_no_parts(folder)

    def test_timeout_leaves_no_file_or_owned_temp(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            destination = folder / "china_sites_20241101.csv"
            session = FakeSession(error=requests.Timeout("slow"))
            with self.assertRaises(requests.Timeout):
                downloader.download_file(session, "https://example.test/data.csv", destination, 7, False, 1000)
            self.assertEqual(session.calls[0][1]["timeout"], (10, 7))
            self.assertFalse(destination.exists())
            self.assert_no_parts(folder)

    def test_no_overwrite_finalization_is_race_safe(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            destination = folder / "china_sites_20241101.csv"
            session = FakeSession(FakeResponse([VALID_CSV]))

            def concurrent_destination(_source, final):
                Path(final).write_bytes(b"concurrent-writer")
                raise FileExistsError("race")

            with patch.object(os, "link", side_effect=concurrent_destination):
                with self.assertRaisesRegex(FileExistsError, "并发"):
                    downloader.download_file(session, "https://example.test/data.csv", destination, 5, False, 1000)
            self.assertEqual(destination.read_bytes(), b"concurrent-writer")
            self.assert_no_parts(folder)

    def test_success_and_explicit_overwrite_have_deterministic_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            destination = folder / "china_sites_20241101.csv"
            first = FakeSession(FakeResponse([VALID_CSV]))
            self.assertEqual(
                downloader.download_file(first, "https://example.test/data.csv", destination, 5, False, 1000),
                "downloaded",
            )
            destination.write_bytes(b"old")
            second = FakeSession(FakeResponse([VALID_CSV]))
            self.assertEqual(
                downloader.download_file(second, "https://example.test/data.csv", destination, 5, True, 1000),
                "downloaded",
            )
            self.assertEqual(destination.read_bytes(), VALID_CSV)
            self.assert_no_parts(folder)

    def test_existing_destination_is_refused_before_network_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            destination = folder / "china_sites_20241101.csv"
            destination.write_bytes(b"existing")
            session = FakeSession(FakeResponse([VALID_CSV]))
            with self.assertRaisesRegex(FileExistsError, "拒绝覆盖"):
                downloader.download_file(session, "https://example.test/data.csv", destination, 5, False, 1000)
            self.assertEqual(session.calls, [])
            self.assertEqual(destination.read_bytes(), b"existing")

    def test_retry_configuration_is_bounded_and_includes_expected_statuses(self):
        session = downloader.build_session(3)
        retry = session.get_adapter("https://").max_retries
        self.assertEqual(retry.total, 3)
        self.assertEqual(retry.connect, 3)
        self.assertEqual(retry.read, 3)
        self.assertIn(429, retry.status_forcelist)
        self.assertIn(503, retry.status_forcelist)


class ExtractorTests(unittest.TestCase):
    def write(self, folder: Path, name: str, text: str):
        (folder / name).write_text(text, encoding="utf-8")

    def test_committed_fixture_matches_browser_values_exactly(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            shutil.copy(ROOT / "tests/fixtures/china_sites_20241101-small.csv", folder / "china_sites_20241101.csv")
            result = extractor.extract_station_files(folder, "3329A")
            self.assertFalse(result.has_errors)
            row = result.frame.iloc[0]
            self.assertEqual(row["时间"].strftime("%Y-%m-%d %H:%M:%S"), "2024-11-01 00:00:00")
            self.assertEqual(
                [row[column] for column in extractor.OUTPUT_COLUMNS.values()],
                [3, 21, 92, 0.6, 89, 49],
            )
            self.assertEqual([(item.filename, item.status) for item in result.outcomes], [("china_sites_20241101.csv", "processed")])

    def test_every_candidate_has_an_auditable_outcome(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            self.write(folder, "china_sites_bad.csv", "date,hour,type,3329A\n20241101,0,SO2,1\n")
            self.write(folder, "china_sites_20241101.csv", "date,hour,type\n20241101,0,SO2\n")
            self.write(folder, "china_sites_20241102.csv", "date,hour,type,3329A\n20241102,0,SO2,2\n")
            result = extractor.extract_station_files(folder, "3329A")
            self.assertEqual(
                [(item.filename, item.status) for item in result.outcomes],
                [
                    ("china_sites_20241101.csv", "error"),
                    ("china_sites_20241102.csv", "processed"),
                    ("china_sites_bad.csv", "error"),
                ],
            )
            self.assertTrue(result.has_errors)
            self.assertTrue(any("站点列不存在" in item.detail for item in result.outcomes))

    def test_missing_structural_column_is_an_explicit_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            self.write(folder, "china_sites_20241101.csv", "date,type,3329A\n20241101,SO2,1\n")
            result = extractor.extract_station_files(folder, "3329A")
            self.assertTrue(result.has_errors)
            self.assertIn("必要列不存在：hour", result.outcomes[0].detail)

    def test_rejects_filename_date_mismatch_and_noninteger_or_out_of_range_hours_for_all_records(self):
        bad_rows = [
            "20241102,0,AQI,1",
            "20241101,1.5,AQI,1",
            "20241101,24,SO2,1",
        ]
        for row in bad_rows:
            with self.subTest(row=row), tempfile.TemporaryDirectory() as temporary:
                folder = Path(temporary)
                self.write(folder, "china_sites_20241101.csv", f"date,hour,type,3329A\n{row}\n")
                result = extractor.extract_station_files(folder, "3329A")
                self.assertTrue(result.has_errors)
                self.assertEqual(result.outcomes[0].status, "error")

    def test_first_finite_duplicate_wins_and_invalid_values_are_audited(self):
        csv = "\n".join([
            "date,hour,type,3329A",
            "20241101,0,SO2,",
            "20241101,0,SO2,bad",
            "20241101,0,SO2,0",
            "20241101,0,SO2,7",
            "20241101,0,NO2,Infinity",
            "20241101,0,NO2,2",
        ])
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            self.write(folder, "china_sites_20241101.csv", csv)
            result = extractor.extract_station_files(folder, "3329A")
            self.assertFalse(result.has_errors)
            self.assertEqual(result.frame.iloc[0]["SO2_μg_m3"], 0)
            self.assertEqual(result.frame.iloc[0]["NO2_μg_m3"], 2)
            self.assertTrue(any("数值无效" in warning and "bad" in warning for warning in result.warnings))
            self.assertTrue(any("数值无效" in warning and "Infinity" in warning for warning in result.warnings))
            self.assertTrue(any("保留首次有限值 0" in warning for warning in result.warnings))

    def test_timeline_cap_is_checked_before_date_range_allocation(self):
        records = [
            {"timestamp": "2024-01-01 00:00:00", "SO2": 1.0},
            {"timestamp": "2025-01-01 00:00:00", "SO2": 2.0},
        ]
        with patch.object(extractor.pd, "date_range") as date_range:
            with self.assertRaisesRegex(ValueError, "8784"):
                extractor.build_continuous_frame(records)
            date_range.assert_not_called()

    def test_continuous_timeline_preserves_missing_hour_and_zero(self):
        records = [
            {"timestamp": "2024-11-01 00:00:00", "SO2": 0.0},
            {"timestamp": "2024-11-01 02:00:00", "SO2": 2.0},
        ]
        frame = extractor.build_continuous_frame(records)
        self.assertEqual(len(frame), 3)
        self.assertEqual(frame.iloc[0]["SO2_μg_m3"], 0)
        self.assertTrue(pd.isna(frame.iloc[1]["SO2_μg_m3"]))
        self.assertEqual(frame.iloc[1]["数据状态"], "存在缺测")

    def test_rejects_more_than_366_candidate_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            for index in range(367):
                (folder / f"china_sites_candidate_{index:03d}.csv").touch()
            with self.assertRaisesRegex(ValueError, "366"):
                extractor.discover_candidates(folder)

    def test_output_success_uses_atomic_no_clobber_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            output = folder / "hourly.csv"
            frame = pd.DataFrame([{"时间": pd.Timestamp("2024-11-01"), "SO2_μg_m3": 0}])
            extractor.write_extraction_csv(frame, output, overwrite=False)
            written = output.read_text(encoding="utf-8-sig")
            self.assertIn("SO2_μg_m3", written)
            self.assertIn(",0", written)
            self.assertEqual(list(folder.glob("*.part")), [])

    def test_output_interruption_cleans_only_owned_temp(self):
        class FailingFrame:
            def to_csv(self, handle, **_kwargs):
                handle.write("partial")
                raise OSError("interrupted")

        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            output = folder / "hourly.csv"
            unrelated = folder / "unrelated.part"
            unrelated.write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(OSError, "interrupted"):
                extractor.write_extraction_csv(FailingFrame(), output, overwrite=False)
            self.assertFalse(output.exists())
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "keep")
            self.assertEqual(list(folder.glob("hourly.csv.*.part")), [])

    def test_output_no_overwrite_detects_concurrent_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            output = folder / "hourly.csv"
            frame = pd.DataFrame([{"时间": pd.Timestamp("2024-11-01"), "SO2_μg_m3": 1}])

            def concurrent_destination(_source, final):
                Path(final).write_text("concurrent", encoding="utf-8")
                raise FileExistsError("race")

            with patch.object(os, "link", side_effect=concurrent_destination):
                with self.assertRaisesRegex(FileExistsError, "并发"):
                    extractor.write_extraction_csv(frame, output, overwrite=False)
            self.assertEqual(output.read_text(encoding="utf-8"), "concurrent")
            self.assertEqual(list(folder.glob("*.part")), [])

    def test_output_explicit_overwrite_atomically_replaces_existing_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            output = folder / "hourly.csv"
            output.write_text("old", encoding="utf-8")
            frame = pd.DataFrame([{"时间": pd.Timestamp("2024-11-01"), "SO2_μg_m3": 2}])
            extractor.write_extraction_csv(frame, output, overwrite=True)
            self.assertNotEqual(output.read_text(encoding="utf-8-sig"), "old")
            self.assertEqual(list(folder.glob("*.part")), [])


class CliErrorTests(unittest.TestCase):
    def test_invalid_downloader_arguments_are_concise_without_traceback(self):
        completed = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("download_station_daily.py")),
                "--start", "2024-01-02",
                "--end", "2024-01-01",
                "--output-dir", "unused",
                "--dry-run",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertNotIn("Traceback", completed.stderr)
        self.assertIn("参数错误", completed.stderr)

    def test_extractor_input_errors_are_concise_without_traceback(self):
        with tempfile.TemporaryDirectory() as temporary:
            missing = Path(temporary) / "missing"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("extract_station_hourly.py")),
                    "--input-dir", str(missing),
                    "--station", "3329A",
                    "--output", str(Path(temporary) / "output.csv"),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertNotEqual(completed.returncode, 0)
        self.assertNotIn("Traceback", completed.stderr)
        self.assertIn("输入错误", completed.stderr)


if __name__ == "__main__":
    unittest.main()
