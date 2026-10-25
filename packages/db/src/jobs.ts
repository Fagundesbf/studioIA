// Fila persistente no banco (spec §7/§10): sem Redis. Lease + heartbeat permitem retomar jobs abandonados.
import { randomUUID } from 'node:crypto';
import type { Job, JobType } from '@rs/contracts';
import { backoffMs, DomainError } from '@rs/domain';
import type { Db } from './database.ts';

interface JobRow {
  id: string; project_id: string; type: string; input_hash: string; idempotency_key: string | null; payload: string;
  status: string; attempt: number; max_attempts: number; progress: number | null; stage: string | null;
  error_code: string | null; error_message: string | null; result: string | null; heartbeat_at: string | null;
  lease_until: string | null; run_after: string; cancel_requested: number; created_at: string; updated_at: string;
}

const toJob = (r: JobRow): Job => ({
  id: r.id, projectId: r.project_id, type: r.type as JobType, inputHash: r.input_hash, idempotencyKey: r.idempotency_key,
  payload: JSON.parse(r.payload), status: r.status as Job['status'], attempt: r.attempt, maxAttempts: r.max_attempts,
  progress: r.progress, stage: r.stage, errorCode: r.error_code, errorMessage: r.error_message,
  result: r.result ? JSON.parse(r.result) : null, heartbeatAt: r.heartbeat_at, leaseUntil: r.lease_until,
  runAfter: r.run_after, cancelRequested: !!r.cancel_requested, createdAt: r.created_at, updatedAt: r.updated_at,
});

const now = () => new Date().toISOString();

export class JobQueue {
  constructor(private readonly db: Db) {}

  /**
   * Enfileira um job. A mesma Idempotency-Key devolve o mesmo job (AC-012);
   * um job ativo/concluído com o mesmo inputHash também é reaproveitado (nada é reprocessado).
   */
  enqueue(args: { projectId: string; type: JobType; payload: Record<string, unknown>; inputHash: string; idempotencyKey?: string | null; maxAttempts?: number }): { job: Job; reused: boolean } {
    return this.db.tx(() => {
      if (args.idempotencyKey) {
        const existing = this.db.sql.prepare('SELECT * FROM jobs WHERE project_id = ? AND type = ? AND idempotency_key = ?')
          .get(args.projectId, args.type, args.idempotencyKey) as JobRow | undefined;
        if (existing) {
          if (existing.input_hash !== args.inputHash) {
            throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key já usada com outro conteúdo', 409);
          }
          return { job: toJob(existing), reused: true };
        }
      }
      const same = this.db.sql.prepare("SELECT * FROM jobs WHERE project_id = ? AND type = ? AND input_hash = ? AND status IN ('queued','running','succeeded') ORDER BY created_at DESC LIMIT 1")
        .get(args.projectId, args.type, args.inputHash) as JobRow | undefined;
      if (same) return { job: toJob(same), reused: true };

      const t = now();
      const id = randomUUID();
      this.db.sql.prepare(`INSERT INTO jobs (id, project_id, type, input_hash, idempotency_key, payload, status, attempt, max_attempts, run_after, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`)
        .run(id, args.projectId, args.type, args.inputHash, args.idempotencyKey ?? null, JSON.stringify(args.payload), args.maxAttempts ?? 3, t, t, t);
      return { job: this.get(id)!, reused: false };
    });
  }

  get(id: string): Job | undefined {
    const r = this.db.sql.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return r ? toJob(r) : undefined;
  }

  listByProject(projectId: string, limit = 50): Job[] {
    return (this.db.sql.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as unknown as JobRow[]).map(toJob);
  }

  listRecent(limit = 20): Job[] {
    return (this.db.sql.prepare('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as JobRow[]).map(toJob);
  }

  /** Pega o próximo job pronto, ou um job "running" com lease vencido (worker caiu — AC-009). */
  claim(workerId: string, leaseMs: number): Job | undefined {
    return this.db.tx(() => {
      const t = now();
      const r = this.db.sql.prepare(`SELECT * FROM jobs
        WHERE (status = 'queued' AND run_after <= ?) OR (status = 'running' AND lease_until < ?)
        ORDER BY created_at LIMIT 1`).get(t, t) as JobRow | undefined;
      if (!r) return undefined;
      if (r.status === 'running' && r.attempt >= r.max_attempts) {
        this.db.sql.prepare("UPDATE jobs SET status='failed', error_code='WORKER_LOST', error_message='Worker interrompido e tentativas esgotadas', updated_at=? WHERE id=?").run(t, r.id);
        return undefined;
      }
      const lease = new Date(Date.now() + leaseMs).toISOString();
      this.db.sql.prepare(`UPDATE jobs SET status='running', attempt=attempt+1, locked_by=?, heartbeat_at=?, lease_until=?, error_code=NULL, error_message=NULL, updated_at=? WHERE id=?`)
        .run(workerId, t, lease, t, r.id);
      return this.get(r.id);
    });
  }

  heartbeat(id: string, leaseMs: number, progress?: number | null, stage?: string | null): { cancelRequested: boolean } {
    const t = now();
    this.db.sql.prepare(`UPDATE jobs SET heartbeat_at=?, lease_until=?, progress=COALESCE(?, progress), stage=COALESCE(?, stage), updated_at=? WHERE id=? AND status='running'`)
      .run(t, new Date(Date.now() + leaseMs).toISOString(), progress ?? null, stage ?? null, t, id);
    const r = this.db.sql.prepare('SELECT cancel_requested FROM jobs WHERE id=?').get(id) as { cancel_requested: number } | undefined;
    return { cancelRequested: !!r?.cancel_requested };
  }

  succeed(id: string, result: Record<string, unknown>) {
    this.db.sql.prepare(`UPDATE jobs SET status='succeeded', progress=1, stage='concluído', result=?, lease_until=NULL, updated_at=? WHERE id=?`)
      .run(JSON.stringify(result), now(), id);
  }

  /** Erro transitório volta para a fila com backoff+jitter; erro de entrada/autorização falha direto. */
  fail(id: string, code: string, message: string, transient: boolean) {
    const job = this.get(id);
    if (!job) return;
    const t = now();
    if (transient && job.attempt < job.maxAttempts) {
      const runAfter = new Date(Date.now() + backoffMs(job.attempt)).toISOString();
      this.db.sql.prepare(`UPDATE jobs SET status='queued', error_code=?, error_message=?, run_after=?, lease_until=NULL, updated_at=? WHERE id=?`)
        .run(code, message, runAfter, t, id);
    } else {
      this.db.sql.prepare(`UPDATE jobs SET status='failed', error_code=?, error_message=?, lease_until=NULL, updated_at=? WHERE id=?`)
        .run(code, message, t, id);
    }
  }

  markCancelled(id: string) {
    this.db.sql.prepare(`UPDATE jobs SET status='cancelled', stage='cancelado', lease_until=NULL, updated_at=? WHERE id=?`).run(now(), id);
  }

  requestCancel(id: string): Job {
    const job = this.get(id);
    if (!job) throw new DomainError('NOT_FOUND', 'Job não encontrado', 404);
    if (job.status === 'queued') this.markCancelled(id);
    else if (job.status === 'running') this.db.sql.prepare('UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?').run(now(), id);
    else throw new DomainError('JOB_FINISHED', `Job já está "${job.status}"`, 409);
    return this.get(id)!;
  }

  retry(id: string): Job {
    const job = this.get(id);
    if (!job) throw new DomainError('NOT_FOUND', 'Job não encontrado', 404);
    if (job.status !== 'failed' && job.status !== 'cancelled') throw new DomainError('JOB_NOT_RETRYABLE', 'Só é possível repetir jobs com falha ou cancelados', 409);
    this.db.sql.prepare(`UPDATE jobs SET status='queued', attempt=0, cancel_requested=0, error_code=NULL, error_message=NULL, progress=NULL, stage=NULL, run_after=?, updated_at=? WHERE id=?`)
      .run(now(), now(), id);
    return this.get(id)!;
  }
}
