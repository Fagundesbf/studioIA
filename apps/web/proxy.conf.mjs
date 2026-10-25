// Proxy do servidor de desenvolvimento: encaminha /api para a API local e
// injeta o token do .env — assim o token nunca vai para o código do navegador.
import fs from 'node:fs';
import path from 'node:path';

const envFile = path.resolve(import.meta.dirname, '../../.env');
const env = Object.fromEntries(
  (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

export default {
  '/api': {
    target: `http://${env.API_HOST || '127.0.0.1'}:${env.API_PORT || 4310}`,
    secure: false,
    changeOrigin: false,
    headers: { Authorization: `Bearer ${env.STUDIO_TOKEN || ''}` },
  },
};
