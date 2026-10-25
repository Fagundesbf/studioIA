// `npm run demo:video` — gera arquivos SINTÉTICOS (padrão de teste do FFmpeg) para experimentar o fluxo
// sem usar gravações reais. Não é gameplay real e não deve ser publicado como tal.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { c, readEnv, ROOT } from './lib.mjs';

const env = readEnv();
const ffmpeg = env.FFMPEG_PATH || 'ffmpeg';
const out = path.join(ROOT, 'data', 'demo');
fs.mkdirSync(out, { recursive: true });

const run = (args) => {
  const r = spawnSync(ffmpeg, ['-y', '-v', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) { console.log(c.bad(r.stderr || 'ffmpeg falhou')); process.exit(1); }
};

run(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=180:sample_rate=48000:duration=40',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(out, 'DEMO-gameplay-sintetica.mp4')]);
run(['-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=48000:duration=4', '-ac', '2', path.join(out, 'DEMO-narracao-trecho1.wav')]);
run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-ac', '2', path.join(out, 'DEMO-narracao-trecho2.wav')]);
run(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720', '-frames:v', '1', path.join(out, 'DEMO-thumbnail.png')]);

console.log(c.ok(`Arquivos de demonstração criados em ${out}`));
console.log('  • DEMO-gameplay-sintetica.mp4 (40 s, 1080p, com áudio)');
console.log('  • DEMO-narracao-trecho1.wav (4 s) e DEMO-narracao-trecho2.wav (3 s)');
console.log('  • DEMO-thumbnail.png');
console.log(c.warn('São sinais de teste, não gameplay real. Use para aprender o fluxo; depois importe suas gravações.'));
