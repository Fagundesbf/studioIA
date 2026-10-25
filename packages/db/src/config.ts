import path from 'node:path';

export interface StudioConfig {
  rootDir: string;
  dataDir: string;
  apiHost: string;
  apiPort: number;
  token: string;
  user: string;
  maxImportBytes: number;
  maxImportDurationMs: number;
  minFreeDiskBytes: number;
  workerConcurrency: number;
  ffmpegPath: string;
  ffprobePath: string;
  confidenceThreshold: number;
}

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

/** Lê a configuração do ambiente (.env carregado pelo `tsx --env-file`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, rootDir = findRoot()): StudioConfig {
  const dataDir = path.resolve(rootDir, env.DATA_DIR || './data');
  return {
    rootDir,
    dataDir,
    apiHost: env.API_HOST || '127.0.0.1',
    apiPort: num(env.API_PORT, 4310),
    token: env.STUDIO_TOKEN || '',
    user: env.STUDIO_USER || 'usuario-local',
    maxImportBytes: num(env.MAX_IMPORT_MB, 8192) * 1024 * 1024,
    maxImportDurationMs: num(env.MAX_IMPORT_DURATION_MIN, 120) * 60_000,
    minFreeDiskBytes: num(env.MIN_FREE_DISK_MB, 2048) * 1024 * 1024,
    workerConcurrency: Math.max(1, num(env.WORKER_CONCURRENCY, 1)),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    confidenceThreshold: num(env.CONFIDENCE_TRIAGE_THRESHOLD, 0.8),
  };
}

function findRoot(): string {
  // packages/db/src -> raiz do monorepo
  return path.resolve(import.meta.dirname, '../../..');
}
