import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffprobeStatic from 'ffprobe-static';
import { Catalog, CatalogStream } from './types.js';

ffmpeg.setFfprobePath(ffprobeStatic.path);

const STREAM_MAP: Record<string, string> = {
  'WELD-A1': 'a1.mp4',
  'WELD-A2': 'a2.mp4',
  'WELD-A3': 'a3.mp4',
  'WELD-A4': 'a4.mp4',
};

function parseFps(rate: string): number {
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return 0;
  return num / den;
}

export async function buildCatalog(mediaDir: string): Promise<Catalog> {
  const streams: CatalogStream[] = [];
  for (const [streamKey, filename] of Object.entries(STREAM_MAP)) {
    const filePath = path.join(mediaDir, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const metadata = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
    const streamInfo = metadata.streams.find(s => s.codec_type === 'video');
    const width = streamInfo?.width ?? 0;
    const height = streamInfo?.height ?? 0;
    const fps = streamInfo?.avg_frame_rate
      ? parseFps(streamInfo.avg_frame_rate)
      : 0;
    const durationSec = Number(metadata.format.duration ?? 0);
    streams.push({
      streamKey,
      path: filePath,
      codec: streamInfo?.codec_name ?? 'unknown',
      width,
      height,
      fps,
      durationSec,
    });
  }
  return { streams };
}
