// `npm run dev` — sobe API, worker e interface juntos. Ctrl+C encerra tudo.
import { spawn } from 'node:child_process';
import { c, doctor, readEnv, ROOT } from './lib.mjs';

if (!doctor({ quiet: true })) {
  doctor();
  console.log(c.title('Corrija os itens acima (ou rode "npm run setup") e tente de novo.'));
  process.exit(1);
}

const env = readEnv();
const procs = [
  { name: 'api', color: 36, args: ['run', 'dev', '-w', '@rs/api'] },
  { name: 'worker', color: 35, args: ['run', 'dev', '-w', '@rs/worker'] },
  { name: 'web', color: 33, args: ['run', 'start', '-w', '@rs/web'] },
];

const children = procs.map((p) => {
  const child = spawn('npm', p.args, {
    cwd: ROOT,
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --disable-warning=ExperimentalWarning`.trim(), FORCE_COLOR: '1' },
  });
  const prefix = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => { if (!stopping) console.log(`${prefix}encerrado (código ${code})`); });
  return child;
});

console.log(c.title(`Abrindo... Interface: http://127.0.0.1:4200  ·  API: http://${env.API_HOST || '127.0.0.1'}:${env.API_PORT || 4310}/api/v1/health`));
console.log('Pressione Ctrl+C para parar tudo.\n');

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const ch of children) ch.kill('SIGINT');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
