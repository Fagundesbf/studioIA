// Utilidades compartilhadas pelos scripts de setup/dev/doctor (sem dependências externas).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const ENV_FILE = path.join(ROOT, '.env');

export const c = {
  ok: (s) => `\x1b[32m✔\x1b[0m ${s}`,
  bad: (s) => `\x1b[31m✘\x1b[0m ${s}`,
  warn: (s) => `\x1b[33m!\x1b[0m ${s}`,
  title: (s) => `\n\x1b[1m${s}\x1b[0m`,
};

export function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

export function nodeOk() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 12);
}

export function which(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.split('\n')[0] ?? '').trim() : null;
}

/** Executa o diagnóstico e devolve true se tudo que é obrigatório estiver OK. */
export function doctor({ quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  let ok = true;
  log(c.title('Obrigatórios'));
  if (nodeOk()) log(c.ok(`Node.js ${process.versions.node}`));
  else { ok = false; log(c.bad(`Node.js ${process.versions.node} — precisa ser 22.12 ou maior. Rode: nvm install 22 && nvm use 22`)); }
  const env = readEnv();
  const ff = which(env.FFMPEG_PATH || 'ffmpeg');
  const fp = which(env.FFPROBE_PATH || 'ffprobe');
  if (ff) log(c.ok(ff)); else { ok = false; log(c.bad('FFmpeg não encontrado. macOS: brew install ffmpeg · Windows: winget install Gyan.FFmpeg')); }
  if (fp) log(c.ok('ffprobe disponível')); else { ok = false; log(c.bad('ffprobe não encontrado (vem junto com o FFmpeg).')); }
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) log(c.ok('Dependências instaladas (node_modules)'));
  else { ok = false; log(c.bad('Dependências não instaladas. Rode: npm install')); }
  if (env.STUDIO_TOKEN && env.STUDIO_TOKEN !== 'troque-por-um-token-aleatorio') log(c.ok('.env configurado com token local'));
  else { ok = false; log(c.bad('.env ausente ou sem token. Rode: npm run setup')); }

  log(c.title('Opcionais (o estúdio funciona sem eles)'));
  log(c.warn('Provedor de texto (LLM): não configurado — roteiro escrito por você (M2 adiciona assistência).'));
  log(c.warn('Provedor de voz: não configurado — importe o áudio da narração.'));
  log(c.warn('Publicação no YouTube: não configurada — exportação manual (P1).'));
  return ok;
}
