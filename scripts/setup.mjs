// `npm run setup` — prepara o projeto na primeira vez (pode rodar de novo sem problemas).
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { c, doctor, ENV_FILE, nodeOk, ROOT } from './lib.mjs';

console.log(c.title('Racing Studio AI — setup'));
if (!nodeOk()) {
  console.log(c.bad(`Node.js ${process.versions.node} é antigo. Rode "nvm install 22 && nvm use 22" e depois "npm run setup" de novo.`));
  process.exit(1);
}

// 1. .env com token aleatório (nunca sobrescreve um .env existente).
if (!fs.existsSync(ENV_FILE)) {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  fs.writeFileSync(ENV_FILE, example.replace('STUDIO_TOKEN=troque-por-um-token-aleatorio', `STUDIO_TOKEN=${randomBytes(24).toString('hex')}`), { mode: 0o600 });
  console.log(c.ok('Arquivo .env criado com um token local aleatório.'));
} else {
  console.log(c.ok('.env já existe — mantido como está.'));
}

// 2. Dependências.
if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  console.log('Instalando dependências (pode levar alguns minutos)...');
  const r = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.log(c.bad('npm install falhou.')); process.exit(1); }
}

// 3. Pastas de dados.
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

// 4. Diagnóstico.
const ok = doctor();
console.log(ok ? c.title('Tudo pronto! Rode agora:  npm run dev   e abra http://127.0.0.1:4200') : c.title('Corrija os itens com ✘ acima e rode "npm run setup" de novo.'));
process.exit(ok ? 0 : 1);
