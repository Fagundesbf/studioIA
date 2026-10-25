// API HTTP /api/v1 (spec §11). Fina: valida entrada com Zod e delega aos casos de uso.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import {
  CreateApprovalInput, CreateEventInput, CreateExportInput, CreateProjectInput, CreateRenderInput, CreateTimelineInput,
  formatIssues, PatchEventInput, RightsDeclaration, ScriptInput, TimelineRevisionInput, VoiceRequest, z,
} from '@rs/contracts';
import { DomainError, toVtt } from '@rs/domain';
import type { Studio } from '@rs/db';
import { StudioService } from '@rs/application';
import { makeThumbnail } from '@rs/video-engine';

const ContentTypes: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.srt': 'application/x-subrip', '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg' };

const Pagination = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
const IdParam = z.object({ id: z.uuid() });

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new DomainError('VALIDATION_ERROR', 'Dados inválidos', 400, formatIssues(r.error));
  return r.data;
}

function idem(req: FastifyRequest): string | null {
  const v = req.headers['idempotency-key'];
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;
}

/** Envia arquivo gerenciado com suporte a Range (preview em <video>). Nunca recebe caminho do cliente. */
async function sendFile(req: FastifyRequest, reply: FastifyReply, abs: string, downloadName?: string) {
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat) throw new DomainError('NOT_FOUND', 'Arquivo não encontrado', 404);
  const type = ContentTypes[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', type).header('Cache-Control', 'private, no-store');
  if (downloadName) reply.header('Content-Disposition', `attachment; filename="${downloadName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  const range = req.headers.range;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m) {
    let start = m[1] ? Number(m[1]) : NaN, end = m[2] ? Number(m[2]) : stat.size - 1;
    if (Number.isNaN(start)) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
    if (start > end || start >= stat.size) return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
    end = Math.min(end, stat.size - 1);
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${stat.size}`).header('Content-Length', end - start + 1);
    return reply.send(fs.createReadStream(abs, { start, end }));
  }
  reply.header('Content-Length', stat.size);
  return reply.send(fs.createReadStream(abs));
}

export async function buildApp(studio: Studio, opts: { logger?: boolean } = {}) {
  const svc = new StudioService(studio);
  const app = Fastify({
    logger: opts.logger ? { level: 'warn', redact: ['req.headers.authorization'] } : false,
    genReqId: () => randomUUID(),
    bodyLimit: 5 * 1024 * 1024,
  });
  await app.register(multipart, { limits: { fileSize: studio.config.maxImportBytes, files: 1, fields: 20 } });

  // ---------- Autenticação (spec §16): token local obrigatório, exceto /health ----------
  const expected = Buffer.from(studio.config.token);
  app.addHook('onRequest', async (req) => {
    if (req.url === '/api/v1/health') return;
    if (!studio.config.token) throw new DomainError('SERVER_NOT_CONFIGURED', 'STUDIO_TOKEN não configurado. Rode `npm run setup`.', 500);
    const h = req.headers.authorization ?? '';
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new DomainError('UNAUTHORIZED', 'Token ausente ou inválido', 401);
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { code?: string; statusCode?: number; httpStatus?: number; details?: unknown };
    if (err instanceof DomainError) {
      req.log.warn({ code: err.code, url: req.url, method: req.method, details: err.details }, err.message);
      return reply.code(err.httpStatus).send({ code: err.code, message: err.message, requestId: req.id, details: err.details });
    }
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ code: 'FILE_TOO_LARGE', message: 'Arquivo acima do limite configurado (MAX_IMPORT_MB).', requestId: req.id });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ code: e.code ?? 'BAD_REQUEST', message: e.message, requestId: req.id });
    req.log.error(err);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Erro interno. Veja os logs da API.', requestId: req.id });
  });

  const api = '/api/v1';

  // ---------- Saúde e capacidades (M0) ----------
  app.get(`${api}/health`, async () => ({ status: 'ok', time: new Date().toISOString(), db: 'sqlite', version: '0.1.0' }));
  app.get(`${api}/providers/capabilities`, async () => svc.capabilities());
  app.get(`${api}/dashboard`, async () => svc.dashboard());

  // ---------- Projetos ----------
  app.post(`${api}/projects`, async (req, reply) => reply.code(201).send(svc.createProject(parse(CreateProjectInput, req.body))));
  app.get(`${api}/projects`, async (req) => { const q = parse(Pagination, req.query); return { items: svc.listProjects(q.limit, q.offset), ...q }; });
  app.get(`${api}/projects/:id`, async (req) => svc.overview(parse(IdParam, req.params).id));

  // ---------- Assets ----------
  app.post(`${api}/projects/:id/assets`, async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    svc.project(id);
    const file = await req.file();
    if (!file) throw new DomainError('NO_FILE', 'Envie um arquivo no campo "file"', 400);
    const fields = Object.fromEntries(Object.entries(file.fields).map(([k, v]) => [k, (v as { value?: unknown })?.value]));
    const rights = parse(RightsDeclaration, { owner: fields.rightsOwner, usage: fields.rightsUsage, notes: fields.rightsNotes ?? '' });
    const tmp = studio.storage.tmpPath(`upload-${randomUUID()}${path.extname(file.filename).toLowerCase().replace(/[^.a-z0-9]/g, '')}`);
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(file.file, new Transform({ transform(chunk, _e, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } }), fs.createWriteStream(tmp));
    if (file.file.truncated) { await fsp.rm(tmp, { force: true }); throw new DomainError('FILE_TOO_LARGE', 'Arquivo acima do limite configurado (MAX_IMPORT_MB).', 413); }
    const tags = typeof fields.tags === 'string' ? fields.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 30) : [];
    const result = await svc.importAsset({ projectId: id, tmpPath: tmp, originalName: file.filename, sizeBytes: size, sha256: hash.digest('hex'), rights, carLabel: typeof fields.carLabel === 'string' && fields.carLabel ? fields.carLabel : null, tags });
    return reply.code(result.job ? 202 : 201).send(result);
  });
  app.get(`${api}/projects/:id/assets`, async (req) => ({ items: svc.listAssets(parse(IdParam, req.params).id) }));
  app.patch(`${api}/assets/:id`, async (req) => svc.updateAsset(parse(IdParam, req.params).id, parse(z.object({ carLabel: z.string().max(100).nullable().optional(), tags: z.array(z.string().max(60)).max(30).optional() }), req.body)));
  app.get(`${api}/assets/:id/proxy`, async (req, reply) => {
    const a = svc.asset(parse(IdParam, req.params).id);
    const key = a.kind === 'video' ? a.proxyKey : a.storageKey;
    if (!key) throw new DomainError('PROXY_NOT_READY', 'Proxy ainda em processamento', 409);
    return sendFile(req, reply, studio.storage.resolve(key));
  });
  // Quadro de um instante do vídeo (prévia do enquadramento). Gerado a partir do proxy e guardado em cache.
  app.get(`${api}/assets/:id/frame`, async (req, reply) => {
    const a = svc.asset(parse(IdParam, req.params).id);
    const { t } = parse(z.object({ t: z.coerce.number().int().min(0) }), req.query);
    if (a.kind !== 'video' || !a.proxyKey) throw new DomainError('PROXY_NOT_READY', 'Vídeo ainda em processamento', 409);
    const ms = Math.min(Math.round(t / 100) * 100, Math.max(0, (a.durationMs ?? 0) - 100));
    const key = studio.storage.key('thumbs', `${a.id}-${ms}.jpg`);
    if (!studio.storage.exists(key)) {
      const tmp = studio.storage.tmpPath(`frame-${randomUUID()}.jpg`);
      await makeThumbnail({ ffmpeg: studio.config.ffmpegPath, ffprobe: studio.config.ffprobePath }, studio.storage.resolve(a.proxyKey), tmp, ms);
      await studio.storage.promote(tmp, key);
    }
    return sendFile(req, reply, studio.storage.resolve(key));
  });
  app.get(`${api}/assets/:id/thumbnail`, async (req, reply) => {
    const a = svc.asset(parse(IdParam, req.params).id);
    const key = a.kind === 'image' ? a.storageKey : a.thumbnailKey;
    if (!key) throw new DomainError('NOT_READY', 'Miniatura ainda não gerada', 409);
    return sendFile(req, reply, studio.storage.resolve(key));
  });

  // ---------- Análise e eventos ----------
  app.post(`${api}/projects/:id/analysis`, async (req, reply) => reply.code(202).send(svc.requestAnalysis(parse(IdParam, req.params).id, idem(req))));
  app.get(`${api}/projects/:id/events`, async (req) => ({ items: svc.listEvents(parse(IdParam, req.params).id) }));
  app.post(`${api}/projects/:id/events`, async (req, reply) => reply.code(201).send(svc.createEvent(parse(IdParam, req.params).id, parse(CreateEventInput, req.body))));
  app.patch(`${api}/events/:id`, async (req) => svc.patchEvent(parse(IdParam, req.params).id, parse(PatchEventInput, req.body)));

  // ---------- Roteiro ----------
  app.post(`${api}/projects/:id/scripts`, async (req, reply) => reply.code(201).send(svc.saveScript(parse(IdParam, req.params).id, parse(ScriptInput, req.body))));
  app.get(`${api}/projects/:id/scripts`, async (req) => ({ items: svc.listScripts(parse(IdParam, req.params).id) }));
  app.get(`${api}/scripts/:id`, async (req) => svc.script(parse(IdParam, req.params).id));
  app.post(`${api}/scripts/:id/revisions`, async (req, reply) => {
    const base = svc.script(parse(IdParam, req.params).id);
    return reply.code(201).send(svc.saveScript(base.projectId, parse(ScriptInput, req.body)));
  });

  // ---------- Voz (RF-008) ----------
  app.post(`${api}/scripts/:id/voice`, async (req, reply) => reply.code(202).send(await svc.requestVoice(parse(IdParam, req.params).id, parse(VoiceRequest, req.body ?? {}), idem(req))));
  app.get(`${api}/scripts/:id/narration`, async (req) => svc.generatedNarration(parse(IdParam, req.params).id));
  app.post(`${api}/scripts/:id/fit-narration`, async (req, reply) => {
    const body = parse(z.object({ narration: z.record(z.string(), z.uuid()), paddingMs: z.number().int().min(0).max(5000).default(600) }), req.body);
    return reply.code(201).send(svc.fitScenesToNarration(parse(IdParam, req.params).id, body.narration, body.paddingMs));
  });

  // ---------- Timeline ----------
  app.post(`${api}/projects/:id/timelines`, async (req, reply) => reply.code(201).send(svc.createTimeline(parse(IdParam, req.params).id, parse(CreateTimelineInput, req.body))));
  app.get(`${api}/timelines/:id`, async (req) => svc.timeline(parse(IdParam, req.params).id));
  app.post(`${api}/timelines/:id/revisions`, async (req, reply) => reply.code(201).send(svc.reviseTimeline(parse(IdParam, req.params).id, parse(TimelineRevisionInput, req.body))));
  app.get(`${api}/timelines/:id/captions.vtt`, async (req, reply) => reply.type('text/vtt; charset=utf-8').send(toVtt(svc.timeline(parse(IdParam, req.params).id).captions)));

  // ---------- Render ----------
  app.post(`${api}/timelines/:id/renders`, async (req, reply) => {
    const body = parse(CreateRenderInput, req.body ?? {});
    return reply.code(202).send(await svc.requestRender(parse(IdParam, req.params).id, body.profile, idem(req)));
  });
  app.get(`${api}/renders/:id`, async (req) => svc.render(parse(IdParam, req.params).id));
  app.get(`${api}/renders/:id/file`, async (req, reply) => {
    const r = svc.render(parse(IdParam, req.params).id);
    if (r.status !== 'succeeded' || !r.outputKey) throw new DomainError('RENDER_NOT_READY', 'Render não concluído', 409);
    const q = req.query as { download?: string };
    return sendFile(req, reply, studio.storage.resolve(r.outputKey), q.download ? `render-${r.profile}-${r.id.slice(0, 8)}.mp4` : undefined);
  });

  // ---------- Aprovação, exportação, publicação ----------
  app.post(`${api}/projects/:id/approvals`, async (req, reply) => reply.code(201).send(svc.approve(parse(IdParam, req.params).id, parse(CreateApprovalInput, req.body))));
  app.get(`${api}/projects/:id/approvals`, async (req) => ({ items: svc.listApprovals(parse(IdParam, req.params).id) }));
  app.post(`${api}/projects/:id/exports`, async (req, reply) => reply.code(202).send(svc.requestExport(parse(IdParam, req.params).id, parse(CreateExportInput, req.body).approvalId, idem(req))));
  app.get(`${api}/exports/:id`, async (req) => svc.exportRecord(parse(IdParam, req.params).id));
  app.get(`${api}/exports/:id/files/:name`, async (req, reply) => {
    const { id, name } = parse(z.object({ id: z.uuid(), name: z.string().regex(/^[A-Za-z0-9._-]+$/) }), req.params);
    const rec = svc.exportRecord(id);
    if (!rec.files.some((f) => f.name === name)) throw new DomainError('NOT_FOUND', 'Arquivo não faz parte do pacote', 404);
    return sendFile(req, reply, studio.storage.resolve(`${rec.folderKey}/${name}`), name);
  });
  app.post(`${api}/projects/:id/publications`, async (req) => svc.requestPublication(parse(IdParam, req.params).id, (req.body as { approvalId?: string } | undefined)?.approvalId));

  // ---------- Jobs ----------
  app.get(`${api}/jobs/:id`, async (req) => {
    const j = studio.jobs.get(parse(IdParam, req.params).id);
    if (!j) throw new DomainError('NOT_FOUND', 'Job não encontrado', 404);
    return j;
  });
  app.post(`${api}/jobs/:id/cancel`, async (req) => studio.jobs.requestCancel(parse(IdParam, req.params).id));
  app.post(`${api}/jobs/:id/retry`, async (req) => studio.jobs.retry(parse(IdParam, req.params).id));

  return app;
}
