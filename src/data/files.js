// Demo file inventory per bucket. In production:
//   POST {apiUrl}/b2api/v4/b2_list_file_versions
//   body: { bucketId, prefix?, startFileName?, startFileId?, maxFileCount }
// Reference: https://www.backblaze.com/apidocs/b2-list-file-versions
//
// b2_list_file_versions returns: fileId, fileName, contentLength, contentType,
// uploadTimestamp, action ('upload' | 'hide' | 'start' | 'folder'),
// serverSideEncryption, fileInfo (custom metadata).
//
// File counts/sizes per bucket here are realistic enough to drive the demo
// UI but only ~20 files each — production buckets contain millions.

const now = new Date('2026-04-25T19:00:00Z').getTime();
const days = (n) => now - n * 86400_000;

function fileId(bucketId, idx) {
  return `4_z${bucketId.slice(0, 16)}_f1${idx.toString(16).padStart(8, '0')}_d2026_m1900`;
}

function gen(bucketId, prefix, names, mime, baseSize, sizeJitter) {
  return names.map((name, i) => ({
    fileId: fileId(bucketId, i + 1),
    fileName: prefix + name,
    contentLength: Math.round(baseSize * (1 + (Math.sin(i) * sizeJitter))),
    contentType: mime,
    uploadTimestamp: days(i % 12),
    action: 'upload',
    serverSideEncryption: { mode: 'SSE-B2', algorithm: 'AES256' },
    fileInfo: {},
  }));
}

// Per-bucket file lists. Fewer than reality but representative shape.
export const FILES_BY_BUCKET = {
  // lumora-training-checkpoints
  '4a8b1d3f7c2e9a0b6d4e3f51': [
    ...gen('4a8b1d3f7c2e9a0b6d4e3f51', 'checkpoints/', [
      'llama3-70b-step-58200.pt', 'llama3-70b-step-58100.pt', 'llama3-70b-step-58000.pt',
      'llama3-70b-step-57900.pt', 'mixtral-8x22b-step-12400.pt', 'mixtral-8x22b-step-12300.pt',
      'mixtral-8x22b-step-12200.pt',
    ], 'application/octet-stream', 142_000_000_000, 0.18),
    ...gen('4a8b1d3f7c2e9a0b6d4e3f51', 'experiments/', [
      'rlhf-run-2188/optimizer.bin', 'rlhf-run-2188/scheduler.bin',
      'rlhf-run-2189/optimizer.bin', 'rlhf-run-2190/optimizer.bin',
    ], 'application/octet-stream', 8_400_000_000, 0.4),
  ],
  // lumora-training-data-lake
  '6f1c8a2b4d5e7f9a3b8c0d1e': [
    ...gen('6f1c8a2b4d5e7f9a3b8c0d1e', 'raw/common-crawl/', [
      'shard-00000.parquet', 'shard-00001.parquet', 'shard-00002.parquet',
      'shard-00003.parquet', 'shard-00004.parquet',
    ], 'application/octet-stream', 1_840_000_000, 0.12),
    ...gen('6f1c8a2b4d5e7f9a3b8c0d1e', 'raw/wikipedia/', [
      'enwiki-20260301.tar.zst', 'frwiki-20260301.tar.zst', 'jawiki-20260301.tar.zst',
    ], 'application/zstd', 24_000_000_000, 0.3),
    ...gen('6f1c8a2b4d5e7f9a3b8c0d1e', 'staged/', [
      'tokenized/shard-0001.bin', 'tokenized/shard-0002.bin', 'tokenized/shard-0003.bin',
    ], 'application/octet-stream', 4_200_000_000, 0.08),
  ],
  // northwind-render-frames-prod
  '8d2e7f1a3b4c5d6e9f0a8b1c': [
    ...gen('8d2e7f1a3b4c5d6e9f0a8b1c', 'job-7821/', [
      'frame-0420.exr', 'frame-0421.exr', 'frame-0422.exr', 'frame-0423.exr',
      'frame-0424.exr', 'frame-0425.exr',
    ], 'image/x-exr', 142_000_000, 0.22),
    ...gen('8d2e7f1a3b4c5d6e9f0a8b1c', 'job-7822/', [
      'frame-0001.exr', 'frame-0002.exr', 'frame-0003.exr',
    ], 'image/x-exr', 168_000_000, 0.18),
    ...gen('8d2e7f1a3b4c5d6e9f0a8b1c', 'previews/', [
      'job-7821-preview.mp4', 'job-7822-preview.mp4',
    ], 'video/mp4', 412_000_000, 0.5),
  ],
  // northwind-archive-deliveries
  '1a3b5c7d9e0f2a4b6c8d0e1f': [
    ...gen('1a3b5c7d9e0f2a4b6c8d0e1f', '2025-Q4/', [
      'final-renders.tar', 'source-assets.tar.zst', 'audio-mixdowns.zip',
    ], 'application/octet-stream', 18_400_000_000, 0.4),
  ],
  // mercato-customer-objects
  '2b4c6d8e0f1a3b5c7d9e1f3a': [
    ...gen('2b4c6d8e0f1a3b5c7d9e1f3a', 'tenants/acme/', [
      'inventory.json', 'thumbnails/sku-1042.jpg', 'thumbnails/sku-1043.jpg',
      'docs/contract-2026.pdf',
    ], 'application/json', 4_800_000, 0.6),
    ...gen('2b4c6d8e0f1a3b5c7d9e1f3a', 'tenants/globex/', [
      'export-20260424.csv', 'export-20260423.csv', 'logs/api-20260425.log',
    ], 'text/csv', 88_000_000, 0.3),
  ],
  // halcyon-foundation-checkpoints
  '3c5d7e9f1a2b4c6d8e0f2a4b': [
    ...gen('3c5d7e9f1a2b4c6d8e0f2a4b', 'checkpoints/v1/', [
      'foundation-180b-step-92000.pt', 'foundation-180b-step-91000.pt',
      'foundation-180b-step-90000.pt', 'foundation-180b-step-89000.pt',
    ], 'application/octet-stream', 360_000_000_000, 0.05),
    ...gen('3c5d7e9f1a2b4c6d8e0f2a4b', 'checkpoints/v2/', [
      'sft-32b-step-44200.pt', 'sft-32b-step-44100.pt',
    ], 'application/octet-stream', 64_000_000_000, 0.08),
  ],
  // halcyon-pretrain-corpus
  '4d6e8f0a1b3c5d7e9f1a3b5c': [
    ...gen('4d6e8f0a1b3c5d7e9f1a3b5c', 'shards/', [
      'shard-00042.parquet', 'shard-00043.parquet', 'shard-00044.parquet',
      'shard-00045.parquet', 'shard-00046.parquet', 'shard-00047.parquet',
    ], 'application/octet-stream', 1_920_000_000, 0.04),
  ],
  // tessera-vector-snapshots
  '5e7f9a1b2c4d6e8f0a2b4c6d': [
    ...gen('5e7f9a1b2c4d6e8f0a2b4c6d', 'snapshots/', [
      '2026-04-25.bin', '2026-04-24.bin', '2026-04-23.bin', '2026-04-22.bin',
    ], 'application/octet-stream', 41_000_000_000, 0.06),
  ],
  // aerie-stream-origin
  '6f8a0b1c3d5e7f9a1b3c5d7e': [
    ...gen('6f8a0b1c3d5e7f9a1b3c5d7e', 'live/episode-241/', [
      'master.m3u8', 'segment-000001.ts', 'segment-000002.ts', 'segment-000003.ts',
    ], 'video/mp2t', 6_200_000, 0.3),
    ...gen('6f8a0b1c3d5e7f9a1b3c5d7e', 'thumbnails/', [
      'ep241-thumb-001.jpg', 'ep241-thumb-002.jpg', 'ep241-thumb-003.jpg',
    ], 'image/jpeg', 184_000, 0.6),
    ...gen('6f8a0b1c3d5e7f9a1b3c5d7e', 'archive/', [
      'episode-240.mp4', 'episode-239.mp4', 'episode-238.mp4',
    ], 'video/mp4', 4_200_000_000, 0.2),
  ],
  // boreal-genomics-archive
  '7a9b1c2d4e6f8a0b2c4d6e8f': [
    ...gen('7a9b1c2d4e6f8a0b2c4d6e8f', 'sequencing-runs/2026-W17/', [
      'sample-A1.fastq.gz', 'sample-A2.fastq.gz', 'sample-B1.fastq.gz',
      'sample-B2.fastq.gz',
    ], 'application/gzip', 4_200_000_000, 0.4),
    ...gen('7a9b1c2d4e6f8a0b2c4d6e8f', 'reports/', [
      'qc-report-W17.pdf', 'variant-calls-W17.vcf.gz',
    ], 'application/pdf', 18_400_000, 0.5),
  ],
  // pylon-sensor-fleet-data
  '8b0c2d3e5f7a9b1c3d5e7f9a': [
    ...gen('8b0c2d3e5f7a9b1c3d5e7f9a', 'lidar/run-0421/', [
      'frame-000001.las', 'frame-000002.las', 'frame-000003.las',
      'frame-000004.las', 'frame-000005.las',
    ], 'application/octet-stream', 184_000_000, 0.18),
    ...gen('8b0c2d3e5f7a9b1c3d5e7f9a', 'camera/run-0421/', [
      'cam-front-000001.png', 'cam-rear-000001.png', 'cam-left-000001.png',
    ], 'image/png', 6_200_000, 0.3),
  ],
};

// Build a synthetic file list for newly created buckets.
export function emptyFileList(bucketId) {
  return [];
}
