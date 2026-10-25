// Execução dos jobs pelo worker (spec §10). Cada etapa grava em tmp, valida e só então promove.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Asset, Event, Job, Project, Render } from '@rs/contracts';
import { DomainError, FORMATS, forwardStatus, sha256, stableStringify, toSrt } from '@rs/domain';
import { makeProxy, makeThumbnail, measureLoudness, renderTimeline, run, validateOutput } from '@rs/video-engine';
import { type ExportRecord, StudioService } from './usecases.ts';
import { VOICE_PROVIDERS } from '@rs/providers';

export interface JobContext {
  signal: AbortSignal;
  progress: (p: number | null, stage: string) => void;
  /** Arquivos temporários deste job (removidos em falha/cancelamento). */
  tmp: (name: string) => string;
}

export type Handler = (svc: StudioService, job: Job, ctx: JobContext) => Promise<Record<string, unknown>>;

async function fileSha256(file: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

const now = () => new Date().toISOString();

// ---------- ingest: proxy + thumbnail ----------
const ingest: Handler = async (svc, job, ctx) => {
  const asset = svc.asset(String(job.payload.assetId));
  const src = svc.s.storage.resolve(asset.storageKey);
  const proxyKey = svc.s.storage.key('proxies', `${asset.id}.mp4`);
  const thumbKey = svc.s.storage.key('thumbs', `${asset.id}.jpg`);
  try {
    if (!svc.s.storage.exists(proxyKey)) {
      ctx.progress(0, 'gerando proxy');
      const tmp = ctx.tmp('proxy.mp4');
      await makeProxy(svc.bins, src, tmp, asset.durationMs ?? 0, { signal: ctx.signal, onProgress: (p) => ctx.progress(p * 0.9, 'gerando proxy') });
      await svc.s.storage.promote(tmp, proxyKey);
    }
    ctx.progress(0.92, 'gerando miniatura');
    if (!svc.s.storage.exists(thumbKey)) {
      const tmp = ctx.tmp('thumb.jpg');
      await makeThumbnail(svc.bins, src, tmp, Math.min(3000, Math.floor((asset.durationMs ?? 0) / 2)), { signal: ctx.signal });
      await svc.s.storage.promote(tmp, thumbKey);
    }
  } catch (e) {
    if ((e as DomainError).code !== 'CANCELLED') svc.s.db.update('assets', { ...svc.asset(asset.id), status: 'failed' } satisfies Asset);
    throw e;
  }
  svc.s.db.update('assets', { ...svc.asset(asset.id), proxyKey, thumbnailKey: thumbKey, status: 'ready' } satisfies Asset);
  const p = svc.project(asset.projectId);
  const status = forwardStatus(p.status, 'media_ready');
  if (status !== p.status) svc.s.db.update('projects', { ...p, status } satisfies Project, { status });
  return { assetId: asset.id, proxyKey, thumbnailKey: thumbKey };
};

// ---------- analyze: heurística de mudança de cena (RF-005) ----------
const analyze: Handler = async (svc, job, ctx) => {
  const ids = (job.payload.assetIds as string[]) ?? [];
  const existing = svc.listEvents(job.projectId);
  let created = 0;
  for (const [i, id] of ids.entries()) {
    const asset = svc.asset(id);
    if (!asset.proxyKey || asset.durationMs == null) continue;
    ctx.progress(i / ids.length, `analisando ${asset.originalName}`);
    const r = await run(svc.bins.ffmpeg, ['-hide_banner', '-nostats', '-i', svc.s.storage.resolve(asset.proxyKey), '-an',
      '-vf', "select='gt(scene,0.35)',metadata=print:file=-", '-f', 'null', '-'], { signal: ctx.signal });
    if (r.code !== 0) throw new DomainError('ANALYSIS_FAILED', 'Falha na análise heurística', 422, { stderr: r.stderr.slice(-1000) });
    const hits: { t: number; score: number }[] = [];
    let t: number | null = null;
    for (const line of r.stdout.split('\n')) {
      const pts = /pts_time:([\d.]+)/.exec(line);
      if (pts) t = Number(pts[1]);
      const sc = /lavfi\.scene_score=([\d.]+)/.exec(line);
      if (sc && t != null) { hits.push({ t: Math.round(t * 1000), score: Number(sc[1]) }); t = null; }
    }
    for (const h of hits.slice(0, 200)) {
      const startMs = Math.max(0, h.t - 1500), endMs = Math.min(asset.durationMs, h.t + 1500);
      if (endMs <= startMs) continue;
      if (existing.some((e) => e.assetId === asset.id && e.origin === 'heuristic' && Math.abs(e.startMs - startMs) < 500)) continue;
      const ev: Event = {
        id: randomUUID(), projectId: job.projectId, assetId: asset.id, startMs, endMs, type: 'mudanca_de_cena',
        description: 'Mudança brusca de imagem detectada por heurística. Isso NÃO prova ultrapassagem, colisão ou vitória — revise e descreva o que acontece.',
        confidence: Math.min(1, Math.round(h.score * 1000) / 1000), origin: 'heuristic', evidenceFrames: [{ timestampMs: h.t }],
        review: 'pending', reviewedBy: null, reviewedAt: null, createdAt: now(),
      };
      svc.s.db.insert('events', ev, { project_id: job.projectId });
      created++;
    }
  }
  const p = svc.project(job.projectId);
  const status = forwardStatus(p.status, 'events_review');
  svc.s.db.update('projects', { ...p, status } satisfies Project, { status });
  return { method: 'ffmpeg scene score > 0.35', candidates: created };
};

// ---------- voice: narração sintetizada (RF-008) ----------
const voice: Handler = async (svc, job, ctx) => {
  const script = svc.script(String(job.payload.scriptId));
  const provider = VOICE_PROVIDERS[String(job.payload.provider)];
  if (!provider) throw new DomainError('PROVIDER_UNAVAILABLE', 'Provedor de voz desconhecido', 422);
  const voiceName = String(job.payload.voice);
  const rate = Number(job.payload.rate);
  const ids = job.payload.segmentIds as string[];
  const result: Record<string, string> = {};
  let generated = 0;
  for (const [i, segId] of ids.entries()) {
    const seg = script.segments.find((s) => s.id === segId);
    if (!seg || !seg.narrationText.trim()) continue;
    ctx.progress(i / ids.length, `gerando voz do trecho ${i + 1} de ${ids.length}`);
    const tags = StudioService.voiceTags(seg.id, seg.narrationText, voiceName, rate);
    // Mesmo trecho + mesmo texto + mesma voz/velocidade já gerado: reaproveita (sem reprocessar).
    const existing = svc.listAssets(script.projectId).find((a) => tags.every((t) => a.tags.includes(t)));
    if (existing) { result[seg.id] = existing.id; continue; }
    const aiff = ctx.tmp(`voz-${i}.aiff`);
    const wav = ctx.tmp(`voz-${i}.wav`);
    await provider.synthesize({ text: seg.narrationText, voice: voiceName, rate, outPath: aiff, textFile: ctx.tmp(`voz-${i}.txt`), signal: ctx.signal });
    const conv = await run(svc.bins.ffmpeg, ['-y', '-v', 'error', '-i', aiff, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', wav], { signal: ctx.signal });
    if (conv.code !== 0) throw new DomainError('VOICE_CONVERT_FAILED', 'Falha ao converter o áudio gerado', 422, { stderr: conv.stderr.slice(-1000) });
    const asset = await svc.storeGeneratedAudio(script.projectId, wav, `narracao-trecho${i + 1}-${voiceName.replace(/[^A-Za-z0-9]+/g, '')}.wav`, tags,
      `Gerado por ${provider.label}, voz ${voiceName}, ${rate} palavras/min, a partir do roteiro v${script.version}.`);
    result[seg.id] = asset.id;
    generated++;
  }
  return { narration: result, generated, reused: Object.keys(result).length - generated, costKnown: provider.costPerJob };
};

// ---------- render (RF-010, AC-007, AC-009) ----------
const render: Handler = async (svc, job, ctx) => {
  const r = svc.render(String(job.payload.renderId));
  const t = svc.timeline(r.timelineVersionId);
  const outputKey = svc.s.storage.key('renders', `${r.id}.mp4`);
  const srtKey = svc.s.storage.key('renders', `${r.id}.srt`);
  const fmt = FORMATS[t.format];
  const scale = r.profile === 'preview' ? 0.5 : 1;
  const expect = { width: Math.floor((fmt.width * scale) / 2) * 2, height: Math.floor((fmt.height * scale) / 2) * 2, fps: fmt.fps };
  const totalMs = t.clips.reduce((n, c) => n + c.durationMs, 0);

  const save = (patch: Partial<Render>) => svc.s.db.update('renders', { ...svc.render(r.id), ...patch });
  save({ status: 'running', jobId: job.id });

  // Retomada após queda: se o arquivo final já foi promovido, só revalida — sem render duplicado.
  if (svc.s.storage.exists(outputKey)) {
    ctx.progress(0.95, 'validando saída existente');
    const check = await validateOutput(svc.bins, svc.s.storage.resolve(outputKey), { durationMs: totalMs, ...expect, audio: true }, ctx.signal);
    if (check.ok) {
      const sha = await fileSha256(svc.s.storage.resolve(outputKey));
      save({ status: 'succeeded', outputKey, srtKey, sha256: sha, durationMs: check.durationMs, diagnostics: { ...r.diagnostics, resumed: true, check } });
      setReview(svc, t.projectId);
      return { renderId: r.id, resumed: true };
    }
    await fsp.rm(svc.s.storage.resolve(outputKey), { force: true });
  }

  const sources = new Map<string, { path: string; width: number; height: number; hasAudio: boolean }>();
  for (const c of t.clips) {
    const a = svc.asset(c.sourceRef.assetId);
    sources.set(a.id, { path: svc.s.storage.resolve(a.storageKey), width: a.width ?? 1920, height: a.height ?? 1080, hasAudio: a.hasAudio });
  }
  for (const at of t.audioTracks) {
    const a = svc.asset(at.assetId);
    sources.set(a.id, { path: svc.s.storage.resolve(a.storageKey), width: 0, height: 0, hasAudio: true });
  }

  await svc.s.storage.writeText(srtKey, toSrt(t.captions));
  const caps = await import('@rs/video-engine').then((m) => m.detectCapabilities(svc.bins));
  const tmp = ctx.tmp('render.mp4');
  ctx.progress(0, 'renderizando');
  const started = Date.now();
  await renderTimeline(svc.bins, {
    format: t.format, profile: r.profile, clips: t.clips, audioTracks: t.audioTracks, captions: t.captions, mix: t.mix, sources,
    srtPath: t.captions.length ? svc.s.storage.resolve(srtKey) : null, // M1: legenda vai como faixa embutida + SRT. Gravar na imagem depende de libass (ver capacidades).
    burnCaptions: false,
    output: tmp, signal: ctx.signal, onProgress: (p) => ctx.progress(p * 0.85, 'renderizando'),
  });
  ctx.progress(0.88, 'validando arquivo');
  const check = await validateOutput(svc.bins, tmp, { durationMs: totalMs, ...expect, audio: true }, ctx.signal);
  ctx.progress(0.95, 'medindo loudness');
  const loudness = await measureLoudness(svc.bins, tmp, ctx.signal);
  const diagnostics = { check, loudness, renderMs: Date.now() - started, captions: t.captions.length ? 'faixa mov_text embutida + arquivo SRT' : 'sem legendas', burnInAvailable: caps.burnInCaptions };
  if (!check.ok) {
    save({ status: 'failed', diagnostics });
    throw new DomainError('RENDER_VALIDATION_FAILED', `Render inválido: ${check.problems.join('; ')}`, 422, check);
  }
  await svc.s.storage.promote(tmp, outputKey);
  const sha = await fileSha256(svc.s.storage.resolve(outputKey));
  save({ status: 'succeeded', outputKey, srtKey, sha256: sha, durationMs: check.durationMs, diagnostics });
  setReview(svc, t.projectId);
  return { renderId: r.id, sha256: sha };
};

function setReview(svc: StudioService, projectId: string) {
  const p = svc.project(projectId);
  const status = forwardStatus(p.status, 'render_review');
  if (status !== p.status) svc.s.db.update('projects', { ...p, status } satisfies Project, { status });
}

// ---------- export (RF-015, AC-015) ----------
const exportPackage: Handler = async (svc, job, ctx) => {
  const { approval, pkg } = svc.verifyApproval(job.projectId, String(job.payload.approvalId));
  const exportId = randomUUID();
  const folderKey = svc.s.storage.key('exports', exportId);
  const tmpDir = ctx.tmp('package');
  await fsp.mkdir(tmpDir, { recursive: true });
  const project = svc.project(job.projectId);
  const m = approval.manifest as { metadata: Record<string, unknown>; thumbnailAssetId: string | null };

  ctx.progress(0.1, 'copiando vídeo');
  await fsp.copyFile(svc.s.storage.resolve(pkg.render.outputKey!), path.join(tmpDir, 'video.mp4'));
  if (pkg.render.srtKey && svc.s.storage.exists(pkg.render.srtKey)) await fsp.copyFile(svc.s.storage.resolve(pkg.render.srtKey), path.join(tmpDir, 'legendas.srt'));
  if (pkg.thumb) await fsp.copyFile(svc.s.storage.resolve(pkg.thumb.storageKey), path.join(tmpDir, `thumbnail${path.extname(pkg.thumb.storageKey)}`));

  ctx.progress(0.6, 'gravando roteiro e metadados');
  await fsp.writeFile(path.join(tmpDir, 'roteiro.json'), JSON.stringify(pkg.script, null, 2));
  await fsp.writeFile(path.join(tmpDir, 'metadados.json'), JSON.stringify({ ...m.metadata, note: 'Títulos e descrição são sugestões revisadas pelo usuário (RF-013).' }, null, 2));

  // Manifesto de fontes e direitos: somente dados do projeto, nenhum segredo/configuração.
  const usedAssetIds = new Set([...pkg.timeline.clips.map((c) => c.sourceRef.assetId), ...pkg.timeline.audioTracks.map((a) => a.assetId), ...(pkg.thumb ? [pkg.thumb.id] : [])]);
  const assets = [...usedAssetIds].map((id) => svc.asset(id)).map((a) => ({ id: a.id, kind: a.kind, originalName: a.originalName, sha256: a.sha256, rightsDeclaration: a.rightsDeclaration }));
  const files: ExportRecord['files'] = [];
  for (const name of (await fsp.readdir(tmpDir)).sort()) {
    const abs = path.join(tmpDir, name);
    files.push({ name, sha256: await fileSha256(abs), sizeBytes: (await fsp.stat(abs)).size });
  }
  const manifest = {
    schema: 'racing-studio-ai/package@1',
    generatedAt: now(),
    project: { id: project.id, title: project.title, gameLabel: project.gameLabel },
    approval: { id: approval.id, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, packageHash: approval.packageHash },
    versions: { scriptVersionId: pkg.script.id, scriptVersion: pkg.script.version, scriptHash: pkg.script.hash, timelineVersionId: pkg.timeline.id, timelineVersion: pkg.timeline.version, timelineHash: pkg.timeline.hash, renderId: pkg.render.id, renderSha256: pkg.render.sha256 },
    sources: pkg.timeline.clips.map((c) => ({ ...c.sourceRef, segmentId: c.segmentId, timelineStartMs: c.timelineStartMs, durationMs: c.durationMs })),
    assets,
    captions: { origin: pkg.timeline.captionsOrigin, count: pkg.timeline.captions.length },
    files,
  };
  await fsp.writeFile(path.join(tmpDir, 'manifesto.json'), JSON.stringify(manifest, null, 2));
  files.push({ name: 'manifesto.json', sha256: sha256(await fsp.readFile(path.join(tmpDir, 'manifesto.json'))), sizeBytes: (await fsp.stat(path.join(tmpDir, 'manifesto.json'))).size });

  ctx.progress(0.9, 'finalizando pacote');
  await svc.s.storage.promote(tmpDir, folderKey);
  const record: ExportRecord = { id: exportId, projectId: project.id, approvalId: approval.id, packageHash: approval.packageHash, folderKey, files, createdAt: now() };
  svc.s.db.insert('exports', record as ExportRecord & { createdAt: string }, { project_id: project.id });
  svc.s.db.audit(svc.actor, 'export.create', project.id, { exportId, packageHash: approval.packageHash, fingerprint: sha256(stableStringify(files)) });
  const p = svc.project(project.id);
  svc.s.db.update('projects', { ...p, status: 'exported' } satisfies Project, { status: 'exported' });
  return { exportId, folderKey, files: files.map((f) => f.name) };
};

export const HANDLERS: Record<Job['type'], Handler> = { ingest, analyze, voice, render, export: exportPackage };
