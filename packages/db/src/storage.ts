// Armazenamento local com interface substituível por object storage (spec §7).
// storageKey é sempre relativo à raiz; nunca aceitamos caminho vindo do cliente.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@rs/domain';

export const AREAS = ['originals', 'proxies', 'thumbs', 'renders', 'exports', 'tmp'] as const;
export type Area = (typeof AREAS)[number];

export class LocalStorage {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir, 'storage');
    for (const a of AREAS) fs.mkdirSync(path.join(this.root, a), { recursive: true });
  }

  /** Converte storageKey em caminho absoluto, bloqueando traversal e links para fora da raiz. */
  resolve(key: string): string {
    if (!key || key.includes('\0') || path.isAbsolute(key)) throw new DomainError('INVALID_STORAGE_KEY', 'Chave de armazenamento inválida', 400);
    const abs = path.resolve(this.root, key);
    if (!abs.startsWith(this.root + path.sep)) throw new DomainError('PATH_TRAVERSAL', 'Acesso fora da pasta permitida', 400);
    if (fs.existsSync(abs)) {
      const real = fs.realpathSync(abs);
      if (!real.startsWith(fs.realpathSync(this.root) + path.sep)) throw new DomainError('PATH_TRAVERSAL', 'Acesso fora da pasta permitida', 400);
    }
    return abs;
  }

  key(area: Area, ...parts: string[]): string {
    for (const p of parts) {
      if (!/^[A-Za-z0-9._-]+$/.test(p) || p === '.' || p === '..') throw new DomainError('INVALID_STORAGE_KEY', 'Nome de arquivo inválido', 400);
    }
    return [area, ...parts].join('/');
  }

  exists(key: string) { return fs.existsSync(this.resolve(key)); }

  async ensureDir(key: string) { await fsp.mkdir(this.resolve(key), { recursive: true }); }

  /** Promove um arquivo temporário (rename atômico no mesmo disco). */
  async promote(tmpAbs: string, key: string) {
    const dest = this.resolve(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(tmpAbs, dest);
    return dest;
  }

  /** Originais são imutáveis: somente leitura após importados (RF-002). */
  async storeOriginal(tmpAbs: string, key: string) {
    const dest = this.resolve(key);
    if (fs.existsSync(dest)) { await fsp.rm(tmpAbs, { force: true }); return dest; }
    await this.promote(tmpAbs, key);
    await fsp.chmod(dest, 0o444);
    return dest;
  }

  async writeText(key: string, content: string) {
    const dest = this.resolve(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, dest);
    return dest;
  }

  tmpPath(name: string) {
    return this.resolve(this.key('tmp', name));
  }

  async freeBytes(): Promise<number> {
    const s = await fsp.statfs(this.root);
    return s.bavail * s.bsize;
  }
}
