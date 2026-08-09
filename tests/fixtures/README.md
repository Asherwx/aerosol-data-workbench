# Test fixtures

Fixture files committed in this directory are synthetic. The gated parity test contains only the minimum reviewed expectations and aggregate counts needed to detect pipeline drift; it never embeds or generates a raw-data extract.

The real-data parity suite is opt-in. Set both environment variables to run it:

- `PRIVATE_STATION_FIXTURES`: directory containing the 61 daily files named exactly `china_sites_20241101.csv` through `china_sites_20241231.csv`.
- `PRIVATE_ION_WORKBOOK`: path to the private water-soluble-ion workbook.

Leave both primary variables unset to skip the private parity suite. Setting exactly one is treated as a configuration error and fails with a bilingual remediation message. `PRIVATE_CITY_SIX_POLLUTANT_CSV` is independent: it may be set alone without triggering the primary station/ion suite.

An independent source comparison is also available when `PRIVATE_CITY_SIX_POLLUTANT_CSV` points to the private city six-pollutant CSV. That file records a six-zero event for station `3329A` at `2024-11-15 18:00`; the daily station files record `6, 38, 42, 0.8, 101, 73` at the same timestamp. They are different source datasets and must not be treated as interchangeable parity expectations.

Example for PowerShell, using private paths only in the local shell session:

```powershell
$env:PRIVATE_STATION_FIXTURES = '<private station CSV directory>'
$env:PRIVATE_ION_WORKBOOK = '<private ion workbook path>'
$env:PRIVATE_CITY_SIX_POLLUTANT_CSV = '<optional private city CSV path>'
npm test -- tests/integration/realDataParity.test.ts
```

Never copy or commit real CSV/XLSX inputs, bulk measurements, absolute private paths, or generated extracts. Keep local summaries under the ignored `artifacts/` directory, and run `npm run audit:privacy` before committing. The repository also ignores `tests/private-fixtures/` and `research-data/` as additional safeguards.

## Verified parity baseline

For the current private November-December 2024 inputs, the browser's full nine-variable QC keeps 1,300 rows and rejects 164. In the current result, 100 rows have at least one station pollutant missing, 71 have at least one ion missing, and 7 belong to both groups (`100 + 71 - 7 = 164`). The earlier Python report kept 1,328 and rejected 136, but it used a different core-variable set, so its aggregate cannot be reconstructed by applying the current nine-variable rule to only one current subgroup. The 28-row aggregate difference documents a rule-set comparison, not a data correction or a reason to alter the browser QC.
