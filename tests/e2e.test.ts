// E2E do fluxo manual M1 com mídia sintética (sem material protegido):
// importar → marcar cenas → roteiro → voz importada → timeline → render → aprovar → exportar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, openStudio, type Studio } from '@rs/db';
import { StudioService, Worker } from '@rs/application';
import { makeSyntheticTone, makeSyntheticVideo, probe } from '@rs/video-engine';
import { buildApp } from '../apps/api/src/app.ts';

const TOKEN = 'token-de-teste';
let dir: string;
let studio: Studio;
let app: FastifyInstance;
let worker: Worker;
const bins = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
const auth = { authorization: `Bearer ${TOKEN}` };

function multipart(fields: Record<string, string>, file: { name: string; data: Buffer }) {
  const boundary = '----rs' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const rights = { rightsOwner: 'Fabio (teste)', rightsUsage: 'proprio' };

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await app.inject({ method, url: `/api/v1${url}`, payload: body as object, headers: { ...auth, ...headers } });
  return { status: r.statusCode, body: r.headers['content-type']?.toString().includes('json') ? r.json() : r.body };
}

async function upload(projectId: string, file: string, extra: Record<string, string> = {}) {
  const m = multipart({ ...rights, ...extra }, { name: path.basename(file), data: fs.readFileSync(file) });
  const r = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/assets`, payload: m.payload, headers: m.headers });
  return { status: r.statusCode, body: r.json() };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-e2e-'));
  studio = openStudio({ ...loadConfig({ DATA_DIR: path.join(dir, 'data'), STUDIO_TOKEN: TOKEN, MIN_FREE_DISK_MB: '1' }), user: 'tester' });
  app = await buildApp(studio);
  worker = new Worker(new StudioService(studio), { log: () => {} });
  await makeSyntheticVideo(bins, path.join(dir, 'corrida.mp4'), { seconds: 20 });
  await makeSyntheticTone(bins, path.join(dir, 'narracao1.wav'), 3);
  await makeSyntheticTone(bins, path.join(dir, 'narracao-longa.wav'), 9);
  fs.writeFileSync(path.join(dir, 'corrompido.mp4'), Buffer.from('isto não é um vídeo'));
});

afterAll(async () => {
  await app?.close();
  studio?.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('M1 fluxo manual completo', () => {
  let projectId: string, videoId: string, voiceId: string, longVoiceId: string, eventId: string;
  let scriptId: string, segmentIds: string[], timelineId: string, finalRenderId: string, approvalId: string;

  it('M0: health público e API autenticada', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects' })).statusCode).toBe(401);
    const caps = await call('GET', '/providers/capabilities');
    expect(caps.body.media.ffmpeg.available).toBe(true);
    expect(caps.body.providers.vision.configured).toBe(false);
    expect(JSON.stringify(caps.body)).not.toContain(TOKEN);
  });

  it('cria projeto', async () => {
    const r = await call('POST', '/projects', { title: 'Teste FH5', gameLabel: 'Forza Horizon 5', objective: 'Primeiro vídeo' });
    expect(r.status).toBe(201);
    projectId = r.body.id;
  });

  it('AC-001: importa vídeo, persiste hash/metadados e não altera o original', async () => {
    const src = path.join(dir, 'corrida.mp4');
    const before = fs.readFileSync(src);
    const r = await upload(projectId, src, { carLabel: 'Porsche 911 GT3', tags: 'teste, sintetico' });
    expect(r.status).toBe(202);
    videoId = r.body.asset.id;
    expect(r.body.asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.body.asset.durationMs).toBe(20_000);
    expect(r.body.asset.width).toBe(1280);
    await worker.drain();
    const asset = (await call('GET', `/projects/${projectId}/assets`)).body.items[0];
    expect(asset.status).toBe('ready');
    expect(asset.proxyKey).toBeTruthy();
    const stored = studio.storage.resolve(asset.storageKey);
    expect(fs.readFileSync(stored).equals(before)).toBe(true);
    expect(fs.statSync(stored).mode & 0o222).toBe(0); // somente leitura
    expect(fs.readFileSync(src).equals(before)).toBe(true);
    // duplicata por hash é alertada
    const dup = await upload(projectId, src);
    expect(dup.body.warnings[0]).toMatch(/SHA-256/);
  });

  it('AC-002: arquivo corrompido, extensão inválida e traversal são rejeitados', async () => {
    const bad = await upload(projectId, path.join(dir, 'corrompido.mp4'));
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('MEDIA_UNREADABLE');
    const m = multipart(rights, { name: '../../etc/passwd.exe', data: Buffer.from('x') });
    const trav = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/assets`, payload: m.payload, headers: m.headers });
    expect(trav.statusCode).toBe(422);
    expect(trav.json().code).toBe('UNSUPPORTED_EXTENSION');
    expect(() => studio.storage.resolve('../studio.db')).toThrow(/fora da pasta/);
    expect(fs.readdirSync(studio.storage.resolve('tmp'))).toHaveLength(0); // sem lixo temporário
  });

  it('importa narrações (voz importada, RF-008)', async () => {
    voiceId = (await upload(projectId, path.join(dir, 'narracao1.wav'))).body.asset.id;
    longVoiceId = (await upload(projectId, path.join(dir, 'narracao-longa.wav'))).body.asset.id;
    expect(voiceId && longVoiceId).toBeTruthy();
  });

  it('AC-003/RF-005: análise heurística só gera candidatos pendentes; marcação manual funciona', async () => {
    const a = await call('POST', `/projects/${projectId}/analysis`, {});
    expect(a.status).toBe(202);
    await worker.drain();
    const evs = (await call('GET', `/projects/${projectId}/events`)).body.items;
    expect(evs.every((e: { review: string; origin: string }) => e.review === 'pending' && e.origin === 'heuristic')).toBe(true);
    const r = await call('POST', `/projects/${projectId}/events`, { assetId: videoId, startMs: 2000, endMs: 6000, type: 'ultrapassagem', description: 'Passa o carro vermelho na curva 3' });
    expect(r.status).toBe(201);
    expect(r.body.review).toBe('confirmed');
    eventId = r.body.id;
    const out = await call('POST', `/projects/${projectId}/events`, { assetId: videoId, startMs: 19_000, endMs: 25_000, type: 'x' });
    expect(out.body.code).toBe('SOURCE_OUT_OF_RANGE');
  });

  it('AC-004/AC-005: pendências e IDs inexistentes no roteiro', async () => {
    const pendingEv = (await call('POST', `/projects/${projectId}/events`, { assetId: videoId, startMs: 8000, endMs: 12000, type: 'possivel_colisao' })).body;
    await call('PATCH', `/events/${pendingEv.id}`, { review: 'pending' });
    const bad = await call('POST', `/projects/${projectId}/scripts`, { status: 'reviewed', segments: [{ role: 'gancho', narrationText: 'Bateu?', sourceRefs: [{ assetId: videoId, startMs: 8000, endMs: 12000 }], targetDurationMs: 4000, factualClaims: [{ text: 'Houve colisão', reviewed: true, sourceRefs: [{ assetId: videoId, startMs: 8000, endMs: 12000, eventId: pendingEv.id }] }] }] });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('SCRIPT_HAS_PENDING_CLAIMS');
    const ghost = await call('POST', `/projects/${projectId}/scripts`, { segments: [{ role: 'gancho', narrationText: 'x', sourceRefs: [{ assetId: videoId, startMs: 0, endMs: 99_000 }], targetDurationMs: 1, factualClaims: [] }] });
    expect(ghost.body.code).toBe('SOURCE_OUT_OF_RANGE');
  });

  it('salva roteiro revisado com fonte em evento confirmado', async () => {
    const r = await call('POST', `/projects/${projectId}/scripts`, {
      status: 'reviewed',
      segments: [
        { role: 'gancho', narrationText: 'Olha só essa ultrapassagem na curva três!', sourceRefs: [{ assetId: videoId, startMs: 2000, endMs: 6000, eventId }], targetDurationMs: 4000, factualClaims: [{ text: 'Passa o carro vermelho', reviewed: true, sourceRefs: [{ assetId: videoId, startMs: 2000, endMs: 6000, eventId }] }] },
        { role: 'fechamento', narrationText: 'Valeu por assistir.', sourceRefs: [{ assetId: videoId, startMs: 14_000, endMs: 17_000 }], targetDurationMs: 3000, factualClaims: [], isOpinion: true },
      ],
    });
    expect(r.status).toBe(201);
    scriptId = r.body.script.id;
    segmentIds = r.body.script.segments.map((s: { id: string }) => s.id);
  });

  it('AC-006: narração maior que o trecho bloqueia sem cortar', async () => {
    const r = await call('POST', `/projects/${projectId}/timelines`, { scriptVersionId: scriptId, format: 'horizontal', narration: { [segmentIds[0]!]: longVoiceId } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NARRATION_TOO_LONG');
    expect(r.body.details[0].suggestion).toBeTruthy();
  });

  it('AC-007: render vertical de preview e final horizontal decodificam com proporções corretas', async () => {
    const v = await call('POST', `/projects/${projectId}/timelines`, { scriptVersionId: scriptId, format: 'vertical', narration: { [segmentIds[0]!]: voiceId } });
    expect(v.status).toBe(201);
    const vr = await call('POST', `/timelines/${v.body.timeline.id}/renders`, { profile: 'preview' });
    await worker.drain();
    const vRender = (await call('GET', `/renders/${vr.body.render.id}`)).body;
    expect(vRender.status).toBe('succeeded');
    expect(vRender.diagnostics.check.width).toBe(540);
    expect(vRender.diagnostics.check.height).toBe(960);

    const h = await call('POST', `/projects/${projectId}/timelines`, { scriptVersionId: scriptId, format: 'horizontal', narration: { [segmentIds[0]!]: voiceId } });
    timelineId = h.body.timeline.id;
    // correção de crop/legendas antes do final gera nova versão
    const rev = await call('POST', `/timelines/${timelineId}/revisions`, { captions: [{ startMs: 0, endMs: 2500, text: 'Olha só essa ultrapassagem!' }] });
    expect(rev.status).toBe(201);
    timelineId = rev.body.timeline.id;
    const fr = await call('POST', `/timelines/${timelineId}/renders`, { profile: 'final' }, { 'idempotency-key': 'render-final-1' });
    const again = await call('POST', `/timelines/${timelineId}/renders`, { profile: 'final' }, { 'idempotency-key': 'render-final-1' });
    expect(again.body.render.id).toBe(fr.body.render.id); // AC-012 (jobs)
    await worker.drain();
    const final = (await call('GET', `/renders/${fr.body.render.id}`)).body;
    expect(final.status).toBe('succeeded');
    expect(final.diagnostics.check.ok).toBe(true);
    expect(final.diagnostics.check.width).toBe(1920);
    expect(final.durationMs).toBe(7000);
    expect(Math.abs(final.diagnostics.loudness.integratedLufs - -14)).toBeLessThan(1.5);
    finalRenderId = final.id;
    const file = studio.storage.resolve(final.outputKey);
    const p = await probe(bins, file);
    expect(p.videoCodec).toBe('h264');
    expect(p.audioCodec).toBe('aac');
    const ranged = await app.inject({ method: 'GET', url: `/api/v1/renders/${finalRenderId}/file`, headers: { ...auth, range: 'bytes=0-99' } });
    expect(ranged.statusCode).toBe(206);
  });

  it('RF-014: aprova o pacote exato e AC-011 bloqueia publicação/divergência', async () => {
    const pre = await call('POST', `/projects/${projectId}/publications`, {});
    expect(pre.body.code).toBe('APPROVAL_REQUIRED');
    const r = await call('POST', `/projects/${projectId}/approvals`, { renderId: finalRenderId, metadata: { title: 'Ultrapassagem na curva 3', description: 'Gameplay narrado', tags: ['fh5'] }, checklistConfirmed: true });
    expect(r.status).toBe(201);
    approvalId = r.body.id;
    expect(r.body.approvedBy).toBe('tester');
    const pub = await call('POST', `/projects/${projectId}/publications`, { approvalId });
    expect(pub.status).toBe(501); // aprovação válida, mas nenhuma integração falsa
  });

  it('RF-015/AC-015: exporta pacote com manifesto e sem segredos', async () => {
    const e1 = await call('POST', `/projects/${projectId}/exports`, { approvalId }, { 'idempotency-key': 'exp-1' });
    const e2 = await call('POST', `/projects/${projectId}/exports`, { approvalId }, { 'idempotency-key': 'exp-1' });
    expect(e2.body.job.id).toBe(e1.body.job.id);
    await worker.drain();
    const job = (await call('GET', `/jobs/${e1.body.job.id}`)).body;
    expect(job.status).toBe('succeeded');
    const rec = (await call('GET', `/exports/${job.result.exportId}`)).body;
    expect(rec.files.map((f: { name: string }) => f.name).sort()).toEqual(['legendas.srt', 'manifesto.json', 'metadados.json', 'roteiro.json', 'video.mp4']);
    const folder = studio.storage.resolve(rec.folderKey);
    const all = fs.readdirSync(folder).map((f) => fs.readFileSync(path.join(folder, f))).map((b) => b.toString('latin1')).join('');
    expect(all).not.toContain(TOKEN);
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifesto.json'), 'utf8'));
    expect(manifest.approval.id).toBe(approvalId);
    expect(manifest.assets[0].rightsDeclaration.owner).toBe('Fabio (teste)');
    expect((await call('GET', `/projects/${projectId}`)).body.project.status).toBe('exported');
  });

  it('AC-008: alterar o roteiro após aprovação invalida dependências e bloqueia exportação', async () => {
    const r = await call('POST', `/scripts/${scriptId}/revisions`, {
      status: 'reviewed',
      segments: [{ role: 'gancho', narrationText: 'Texto novo', sourceRefs: [{ assetId: videoId, startMs: 2000, endMs: 6000, eventId }], targetDurationMs: 4000, factualClaims: [] }],
    });
    expect(r.status).toBe(201);
    expect(r.body.invalidated.some((x: string) => x.startsWith('approval:'))).toBe(true);
    const ex = await call('POST', `/projects/${projectId}/exports`, { approvalId });
    expect(ex.body.code).toBe('APPROVAL_INVALIDATED');
    const pub = await call('POST', `/projects/${projectId}/publications`, { approvalId });
    expect(pub.body.code).toBe('APPROVAL_INVALIDATED');
    const stale = await call('POST', `/timelines/${timelineId}/renders`, { profile: 'final' });
    expect(stale.body.code).toBe('TIMELINE_STALE');
  });

  it('AC-009: worker que cai no meio é retomado sem duplicar saída', async () => {
    const latest = (await call('GET', `/projects/${projectId}`)).body.latestScript;
    const t = await call('POST', `/projects/${projectId}/timelines`, { scriptVersionId: latest.id, format: 'horizontal', narration: {} });
    const req = await call('POST', `/timelines/${t.body.timeline.id}/renders`, { profile: 'preview' });
    const crashed = studio.jobs.claim('worker-que-caiu', 1); // pega o job e "morre" sem heartbeat
    expect(crashed?.id).toBe(req.body.render.jobId);
    await new Promise((r) => setTimeout(r, 20));
    await worker.drain();
    const job = studio.jobs.get(req.body.render.jobId)!;
    expect(job.status).toBe('succeeded');
    expect(job.attempt).toBe(2);
    const renders = (await call('GET', `/projects/${projectId}`)).body.renders.filter((r: { timelineVersionId: string }) => r.timelineVersionId === t.body.timeline.id);
    expect(renders).toHaveLength(1);
    expect(fs.readdirSync(studio.storage.resolve('renders')).filter((f) => f.startsWith(req.body.render.id) && f.endsWith('.mp4'))).toHaveLength(1);
  });

  it('AC-013: falha de dependência é clara, não finge sucesso, e pode ser retomada', async () => {
    const broken = new StudioService({ ...studio, config: { ...studio.config, ffmpegPath: '/caminho/inexistente/ffmpeg' } });
    const latest = (await call('GET', `/projects/${projectId}`)).body.latestTimeline;
    const req = await call('POST', `/timelines/${latest.id}/renders`, { profile: 'final' });
    await new Worker(broken, { log: () => {} }).drain();
    const failed = studio.jobs.get(req.body.render.jobId)!;
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('FFMPEG_NOT_FOUND');
    expect((await call('GET', `/renders/${req.body.render.id}`)).body.status).toBe('failed');
    await call('POST', `/jobs/${failed.id}/retry`);
    await worker.drain();
    expect(studio.jobs.get(failed.id)!.status).toBe('succeeded');
  });
});
