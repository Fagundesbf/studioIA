import { loadConfig, openStudio } from '@rs/db';
import { buildApp } from './app.ts';

const config = loadConfig();
if (config.apiHost !== '127.0.0.1' && config.apiHost !== 'localhost') {
  console.warn('[aviso] API exposta fora do loopback. Use TLS e autenticação adequada (spec §16).');
}
const studio = openStudio(config);
const app = await buildApp(studio, { logger: true });
await app.listen({ host: config.apiHost, port: config.apiPort });
console.log(`\n  Racing Studio AI — API em http://${config.apiHost}:${config.apiPort}/api/v1  (dados em ${config.dataDir})\n`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { await app.close(); studio.db.close(); process.exit(0); });
}
