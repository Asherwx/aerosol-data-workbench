import { buildDownloadLinks } from '../core/downloadLinks'
import { mergeHourly } from '../core/hourlyMerge'
import { parseIonWorkbook } from '../core/ionWorkbook'
import { downloadStationRange } from '../core/onlineStationDownload'
import { buildMergedQcArtifacts, buildStationQcArtifacts } from '../core/qcModeExports'
import { qualityControl } from '../core/qualityControl'
import { qualityControlStation, type StationQualityControlResult } from '../core/stationQualityControl'
import { buildHourlySeries } from '../core/stationSeries'
import { parseStationFiles, parseStationInputs } from '../workers/workerClient'
import type { PipelineServices } from './pipelineTypes'

export const defaultPipelineServices: PipelineServices = {
  buildDownloadLinks,
  downloadStationRange,
  parseStationInputs,
  buildHourlySeries,
  createExportArtifacts: async ({ signal, mode, qcResult, metadata, parsedUserDataset, userMergeResult }) => {
    if (mode === 'station') {
      return await buildStationQcArtifacts({
        qcResult: qcResult as unknown as StationQualityControlResult,
        metadata,
      }, { signal }) as unknown as Awaited<ReturnType<NonNullable<PipelineServices['createExportArtifacts']>>>
    }
    return await buildMergedQcArtifacts({
      qcResult: qcResult as Parameters<typeof buildMergedQcArtifacts>[0]['qcResult'],
      metadata,
      variables: parsedUserDataset?.variables ?? userMergeResult?.variables ?? [],
      mapping: parsedUserDataset?.mapping,
      unmatchedTimestamps: userMergeResult?.unmatchedUserTimestamps ?? [],
      warningTotal: userMergeResult?.warningTotal,
    }, { signal }) as unknown as Awaited<ReturnType<NonNullable<PipelineServices['createExportArtifacts']>>>
  },
  parseStationFiles,
  parseIonWorkbook,
  mergeHourly,
  runQualityControl: qualityControl,
  runQcMode: (mode, input) => {
    if (mode !== 'station') throw new Error('Merged quality control is not available in the default pipeline service')
    return qualityControlStation(input.stationRows) as ReturnType<typeof qualityControl>
  },
}

export function defaultStationEndpoint(): string | undefined {
  const configured = import.meta.env.VITE_STATION_API_URL?.trim()
  return configured || undefined
}
