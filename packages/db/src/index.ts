import path from 'node:path';
import { loadConfig, type StudioConfig } from './config.ts';
import { Db } from './database.ts';
import { JobQueue } from './jobs.ts';
import { LocalStorage } from './storage.ts';

export * from './config.ts';
export * from './database.ts';
export * from './jobs.ts';
export * from './storage.ts';

export interface Studio {
  config: StudioConfig;
  db: Db;
  jobs: JobQueue;
  storage: LocalStorage;
}

/** Abre banco + armazenamento a partir da configuração. Usado pela API, pelo worker e pelos testes. */
export function openStudio(config: StudioConfig = loadConfig()): Studio {
  const db = new Db(path.join(config.dataDir, 'studio.db'));
  return { config, db, jobs: new JobQueue(db), storage: new LocalStorage(config.dataDir) };
}
