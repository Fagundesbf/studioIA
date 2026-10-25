// Banco SQLite em arquivo via `node:sqlite` (embutido no Node 22). Ver docs/adr/ADR-001-sqlite.md.
// Entidades são guardadas como documento JSON + colunas indexadas; a fila de jobs usa colunas reais.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'inicial',
    sql: `
      CREATE TABLE projects   (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE assets     (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), sha256 TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX assets_project ON assets(project_id);
      CREATE INDEX assets_sha ON assets(sha256);
      CREATE TABLE events     (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX events_project ON events(project_id);
      CREATE TABLE scripts    (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id, version));
      CREATE TABLE timelines  (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id, version));
      CREATE TABLE renders    (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX renders_project ON renders(project_id);
      CREATE TABLE approvals  (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX approvals_project ON approvals(project_id);
      CREATE TABLE exports    (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE publications (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE provider_configs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE audit_log  (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, project_id TEXT, details TEXT NOT NULL);
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        type TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        idempotency_key TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        progress REAL,
        stage TEXT,
        error_code TEXT,
        error_message TEXT,
        result TEXT,
        heartbeat_at TEXT,
        lease_until TEXT,
        locked_by TEXT,
        run_after TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX jobs_idem ON jobs(project_id, type, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX jobs_claim ON jobs(status, run_after);
    `,
  },
];

export type Table = 'projects' | 'assets' | 'events' | 'scripts' | 'timelines' | 'renders' | 'approvals' | 'exports' | 'publications' | 'provider_configs';

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate(): number[] {
    this.sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const done = new Set((this.sql.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      this.tx(() => {
        this.sql.exec(m.sql);
        this.sql.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
      });
      applied.push(m.id);
    }
    return applied;
  }

  /** Transação síncrona com BEGIN IMMEDIATE (evita corrida entre API e worker). */
  tx<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.sql.exec('COMMIT');
      return r;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- Documentos ----------
  insert<T extends { id: string; createdAt: string }>(table: Table, doc: T, extra: Record<string, string | number | null> = {}): T {
    const cols = ['id', 'created_at', 'data', ...Object.keys(extra)];
    const vals = [doc.id, doc.createdAt, JSON.stringify(doc), ...Object.values(extra)];
    this.sql.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    return doc;
  }

  update<T extends { id: string }>(table: Table, doc: T, extra: Record<string, string | number | null> = {}): T {
    const sets = ['data = ?', ...Object.keys(extra).map((k) => `${k} = ?`)];
    this.sql.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(JSON.stringify(doc), ...Object.values(extra), doc.id);
    return doc;
  }

  get<T>(table: Table, id: string): T | undefined {
    const row = this.sql.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  list<T>(table: Table, where = '1=1', params: (string | number)[] = [], order = 'created_at DESC', limit = 200, offset = 0): T[] {
    const rows = this.sql.prepare(`SELECT data FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  audit(actor: string, action: string, projectId: string | null, details: unknown) {
    this.sql.prepare('INSERT INTO audit_log (at, actor, action, project_id, details) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), actor, action, projectId, JSON.stringify(details));
  }

  close() { this.sql.close(); }
}
