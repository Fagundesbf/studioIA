import { loadConfig, openStudio } from '@rs/db';
import { StudioService, Worker } from '@rs/application';

const studio = openStudio(loadConfig());
const worker = new Worker(new StudioService(studio));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { console.log('Encerrando worker após os jobs em andamento...'); worker.stop(); });
}

await worker.loop();
studio.db.close();
