// `npm run doctor` — verifica se tudo que o estúdio precisa está instalado.
import { c, doctor } from './lib.mjs';
const ok = doctor();
console.log(ok ? c.title('Ambiente OK.') : c.title('Há itens obrigatórios faltando (✘).'));
process.exit(ok ? 0 : 1);
