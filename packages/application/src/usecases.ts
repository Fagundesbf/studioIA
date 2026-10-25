// Casos de uso (spec §7): HTTP, UI e o futuro MCP chamam estas mesmas funções.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  type Approval, type Asset, type CreateApprovalInput, type CreateEventInput, type CreateProjectInput,
  type CreateTimelineInput, type Event, type Job, type PatchEventInput, type Project, type Render,
  type RightsDeclaration, type ScriptInput, type ScriptVersion, type TimelineRevisionInput, type TimelineVersion,
  type VoiceRequest, MixSettings,
} from '@rs/contracts';
import { VOICE_PROVIDERS } from '@rs/providers';
import {
  ALLOWED_IMPORT_EXT, assertApprovalValid, assertCaptionsValid, assertCropInside, buildTimeline, DomainError,
  forwardStatus, hashOf, nextStatus, packageHash, sha256, toSrt, validateScript,
} from '@rs/domain';
import type { Studio } from '@rs/db';
import { assertDecodable, detectCapabilities, probe } from '@rs/video-engine';

const now = () => new Date().toISOString();
const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} não encontrado(a)`, 404);

export class StudioService {
  constructor(readonly s: Studio) {}

  get bins() { return { ffmpeg: this.s.config.ffmpegPath, ffprobe: this.s.config.ffprobePath }; }
  get actor() { return this.s.config.user; }

  // ---------- Projetos ----------
  createProject(input: CreateProjectInput): Project {
    const p: Project = { id: randomUUID(), title: input.title, kind: 'gameplay', template: input.template, gameLabel: input.gameLabel, objective: input.objective, language: 'pt-BR', status: 'draft', createdAt: now() };
    this.s.db.insert('projects', p, { status: p.status });
    this.s.db.audit(this.actor, 'project.create', p.id, { title: p.title });
    return p;
  }

  listProjects(limit = 50, offset = 0): Project[] { return this.s.db.list<Project>('projects', '1=1', [], 'created_at DESC', limit, offset); }

  project(id: string): Project {
    const p = this.s.db.get<Project>('projects', id);
    if (!p) throw notFound('Projeto');
    return p;
  }

  private setStatus(p: Project, status: Project['status']) {
    if (p.status === status) return p;
    const updated = { ...p, status };
    this.s.db.update('projects', updated, { status });
    return updated;
  }

  private advance(projectId: string, reached: Project['status']) {
    const p = this.project(projectId);
    return this.setStatus(p, forwardStatus(p.status, reached));
  }

  /** Visão consolidada para a tela do projeto. */
  overview(projectId: string) {
    const project = this.project(projectId);
    const scripts = this.listScripts(projectId);
    const timelines = this.s.db.list<TimelineVersion>('timelines', 'project_id = ?', [projectId], 'version DESC', 20);
    return {
      project,
      assets: this.listAssets(projectId),
      events: this.listEvents(projectId),
      latestScript: scripts[0] ?? null,
      scripts: scripts.map((s) => ({ id: s.id, version: s.version, status: s.status, createdAt: s.createdAt })),
      latestTimeline: timelines[0] ?? null,
      timelines: timelines.map((t) => ({ id: t.id, version: t.version, format: t.format, stale: t.stale, scriptVersionId: t.scriptVersionId, createdAt: t.createdAt })),
      renders: this.s.db.list<Render>('renders', 'project_id = ?', [projectId], 'created_at DESC', 20),
      approvals: this.listApprovals(projectId),
      exports: this.s.db.list<ExportRecord>('exports', 'project_id = ?', [projectId], 'created_at DESC', 20),
      jobs: this.s.jobs.listByProject(projectId, 20),
    };
  }

  dashboard() {
    const projects = this.listProjects(20);
    const jobs = this.s.jobs.listRecent(20);
    return {
      projects,
      recentJobs: jobs,
      blocked: jobs.filter((j) => j.status === 'failed').map((j) => ({ jobId: j.id, projectId: j.projectId, type: j.type, errorCode: j.errorCode, errorMessage: j.errorMessage })),
      // Custos: nenhum provedor pago configurado no M1 — custo conhecido = 0, nada estimado.
      costs: { knownTotal: 0, currency: 'BRL', note: 'Nenhum provedor pago habilitado.' },
    };
  }

  // ---------- Assets (RF-001, RF-002, RF-003) ----------
  /** Recebe um arquivo já gravado em tmp pelo HTTP (stream + hash) e o importa. */
  async importAsset(args: { projectId: string; tmpPath: string; originalName: string; sizeBytes: number; sha256: string; rights: RightsDeclaration; carLabel?: string | null; tags?: string[] }) {
    const project = this.project(args.projectId);
    const ext = path.extname(args.originalName).toLowerCase();
    const kind = ALLOWED_IMPORT_EXT[ext];
    const reject = async (code: string, message: string, details?: unknown) => {
      await fsp.rm(args.tmpPath, { force: true });
      throw new DomainError(code, message, 422, details);
    };
    if (!kind) return reject('UNSUPPORTED_EXTENSION', `Extensão "${ext || '(nenhuma)'}" não suportada. Use MP4, MOV ou MKV para vídeo; WAV/MP3/M4A para áudio; JPG/PNG para imagem.`);
    if (args.sizeBytes === 0) return reject('EMPTY_FILE', 'Arquivo vazio.');

    // Inspeção real: o conteúdo precisa corresponder à extensão (bloqueia extensão enganosa).
    let info;
    try {
      info = await probe(this.bins, args.tmpPath);
      if (kind !== 'image') await assertDecodable(this.bins, args.tmpPath);
    } catch (e) {
      return reject((e as DomainError).code ?? 'MEDIA_UNREADABLE', (e as Error).message, (e as DomainError).details);
    }
    if (kind === 'video' && !info.hasVideo) return reject('NO_VIDEO_STREAM', 'O arquivo não contém trilha de vídeo decodificável.');
    if (kind === 'audio' && !info.hasAudio) return reject('NO_AUDIO_STREAM', 'O arquivo não contém trilha de áudio.');
    if (kind !== 'image' && (info.durationMs == null || info.durationMs <= 0)) return reject('NO_DURATION', 'Não foi possível determinar a duração.');
    if (info.durationMs && info.durationMs > this.s.config.maxImportDurationMs) {
      return reject('TOO_LONG', `Duração acima do limite configurado (${Math.round(this.s.config.maxImportDurationMs / 60000)} min).`);
    }

    const duplicate = this.s.db.sql.prepare('SELECT id FROM assets WHERE sha256 = ? LIMIT 1').get(args.sha256) as { id: string } | undefined;
    const storageKey = this.s.storage.key('originals', `${args.sha256}${ext}`);
    await this.s.storage.storeOriginal(args.tmpPath, storageKey);

    const asset: Asset = {
      id: randomUUID(), projectId: project.id, kind, originalName: path.basename(args.originalName).slice(0, 255), sha256: args.sha256,
      storageKey, sizeBytes: args.sizeBytes, durationMs: kind === 'image' ? null : info.durationMs, width: info.width, height: info.height,
      fps: info.fps, videoCodec: info.videoCodec, audioCodec: info.audioCodec, hasAudio: info.hasAudio,
      carLabel: args.carLabel ?? null, tags: args.tags ?? [], rightsDeclaration: args.rights,
      proxyKey: null, thumbnailKey: null, status: kind === 'video' ? 'processing' : 'ready', duplicateOf: duplicate?.id ?? null, createdAt: now(),
    };
    this.s.db.insert('assets', asset, { project_id: project.id, sha256: asset.sha256 });
    this.s.db.audit(this.actor, 'asset.import', project.id, { assetId: asset.id, sha256: asset.sha256, rights: args.rights });

    let job: Job | null = null;
    if (kind === 'video') {
      job = this.s.jobs.enqueue({ projectId: project.id, type: 'ingest', payload: { assetId: asset.id }, inputHash: hashOf({ ingest: asset.id }) }).job;
    } else {
      this.advance(project.id, 'media_ready');
    }
    return {
      asset, job,
      warnings: duplicate ? [`Arquivo idêntico (mesmo SHA-256) já importado como asset ${duplicate.id}.`] : [],
    };
  }

  listAssets(projectId: string): Asset[] { return this.s.db.list<Asset>('assets', 'project_id = ?', [projectId], 'created_at ASC'); }

  asset(id: string): Asset {
    const a = this.s.db.get<Asset>('assets', id);
    if (!a) throw notFound('Asset');
    return a;
  }

  updateAsset(id: string, patch: { carLabel?: string | null; tags?: string[] }) {
    const a = this.asset(id);
    const updated = { ...a, ...(patch.carLabel !== undefined ? { carLabel: patch.carLabel } : {}), ...(patch.tags ? { tags: patch.tags } : {}) };
    return this.s.db.update('assets', updated);
  }

  // ---------- Análise assistida (RF-005) ----------
  requestAnalysis(projectId: string, idempotencyKey: string | null) {
    const assets = this.listAssets(projectId).filter((a) => a.kind === 'video' && a.status === 'ready');
    if (!assets.length) throw new DomainError('NO_READY_VIDEO', 'Importe um vídeo e aguarde o processamento antes de analisar.', 409);
    const p = this.project(projectId);
    this.setStatus(p, forwardStatus(p.status, 'analyzing'));
    return this.s.jobs.enqueue({
      projectId, type: 'analyze', payload: { assetIds: assets.map((a) => a.id) },
      inputHash: hashOf({ analyze: assets.map((a) => a.sha256), method: 'scene-change-v1' }), idempotencyKey,
    });
  }

  // ---------- Voz (RF-008) ----------
  async voiceCapability() {
    const p = VOICE_PROVIDERS['macos-say']!;
    const voices = await p.listVoices();
    return voices.length
      ? { configured: true, mode: 'generate+import', provider: p.id, voices, costPerJob: p.costPerJob, note: `${p.label}: ${voices.length} voz(es) pt-BR. Também é possível importar áudio gravado.` }
      : { configured: false, mode: 'import', voices: [], note: 'Nenhum sintetizador local com voz pt-BR encontrado (macOS "say"). Importe o áudio da narração.' };
  }

  /** Marcadores que ligam um áudio gerado ao trecho e ao texto exato que ele fala. */
  static textTag(text: string) { return `texto:${sha256(text.trim()).slice(0, 16)}`; }

  static voiceTags(segmentId: string, text: string, voice: string, rate: number) {
    return ['narracao-gerada', `segmento:${segmentId}`, StudioService.textTag(text), `voz:${voice}`, `velocidade:${rate}`];
  }

  async requestVoice(scriptId: string, input: VoiceRequest, idempotencyKey: string | null) {
    const script = this.script(scriptId);
    const latest = this.listScripts(script.projectId)[0];
    if (latest?.id !== script.id) throw new DomainError('SCRIPT_OUTDATED', `Gere a voz a partir da versão mais recente do roteiro (v${latest?.version})`, 409);
    if (script.status !== 'reviewed') throw new DomainError('SCRIPT_NOT_REVIEWED', 'Marque o roteiro como revisado antes de gerar a voz (a voz não altera o texto).', 409);
    const provider = VOICE_PROVIDERS[input.provider];
    if (!provider || !(await provider.available())) throw new DomainError('PROVIDER_UNAVAILABLE', 'Sintetizador de voz indisponível nesta máquina. Importe o áudio da narração.', 422);
    const segments = script.segments.filter((s) => s.narrationText.trim() && (!input.segmentIds || input.segmentIds.includes(s.id)));
    if (!segments.length) throw new DomainError('NOTHING_TO_SAY', 'Nenhum trecho com texto de narração.', 422);
    return this.s.jobs.enqueue({
      projectId: script.projectId, type: 'voice', idempotencyKey,
      payload: { scriptId, provider: input.provider, voice: input.voice, rate: input.rate, segmentIds: segments.map((s) => s.id) },
      inputHash: hashOf({ voice: segments.map((s) => [s.id, s.narrationText]), v: input.voice, r: input.rate, p: input.provider }),
    });
  }

  /** Áudio gerado mais recente de cada trecho cujo texto ainda é o atual (texto mudou = voz antiga não vale). */
  generatedNarration(scriptId: string): Record<string, { assetId: string; durationMs: number | null; voice: string }> {
    const script = this.script(scriptId);
    const audios = this.listAssets(script.projectId).filter((a) => a.kind === 'audio' && a.tags.includes('narracao-gerada')).reverse();
    const out: Record<string, { assetId: string; durationMs: number | null; voice: string }> = {};
    for (const seg of script.segments) {
      const match = audios.find((a) => a.tags.includes(`segmento:${seg.id}`) && a.tags.includes(StudioService.textTag(seg.narrationText)));
      if (match) out[seg.id] = { assetId: match.id, durationMs: match.durationMs, voice: match.tags.find((t) => t.startsWith('voz:'))?.slice(4) ?? '' };
    }
    return out;
  }

  /**
   * Estende as cenas dos trechos cuja narração não cabe (AC-006: nunca cortar fala).
   * Gera nova versão do roteiro com o mesmo texto/IDs; só o intervalo da última cena do trecho muda.
   */
  fitScenesToNarration(scriptId: string, narration: Record<string, string>, paddingMs = 600) {
    const script = this.script(scriptId);
    const assets = new Map(this.listAssets(script.projectId).map((a) => [a.id, a]));
    const changes: { segmentIndex: number; fromMs: number; toMs: number }[] = [];
    const problems: string[] = [];
    const segments = script.segments.map((seg, i) => {
      const audio = narration[seg.id] ? assets.get(narration[seg.id]!) : undefined;
      if (!audio?.durationMs) return seg;
      const sceneMs = seg.sourceRefs.reduce((n, r) => n + (r.endMs - r.startMs), 0);
      const need = audio.durationMs + paddingMs - sceneMs;
      if (need <= 0) return seg;
      const refs = seg.sourceRefs.map((r) => ({ ...r }));
      const last = refs[refs.length - 1]!;
      const video = assets.get(last.assetId);
      const max = video?.durationMs ?? last.endMs;
      const forward = Math.min(need, max - last.endMs);
      last.endMs += forward;
      const backward = Math.min(need - forward, last.startMs);
      last.startMs -= backward;
      if (forward + backward < need) problems.push(`Trecho ${i + 1}: o vídeo não tem material suficiente (faltam ${((need - forward - backward) / 1000).toFixed(1)} s). Encurte o texto.`);
      changes.push({ segmentIndex: i, fromMs: sceneMs, toMs: sceneMs + forward + backward });
      return { ...seg, sourceRefs: refs, targetDurationMs: refs.reduce((n, r) => n + (r.endMs - r.startMs), 0) };
    });
    if (!changes.length) return { changed: false, changes, problems, script };
    const saved = this.saveScript(script.projectId, { status: script.status, segments });
    return { changed: true, changes, problems, script: saved.script };
  }

  /** Grava um áudio gerado como asset do projeto (mesmas regras de imutabilidade e hash dos originais). */
  async storeGeneratedAudio(projectId: string, wavPath: string, name: string, tags: string[], rightsNotes: string) {
    const { createHash } = await import('node:crypto');
    const buf = await fsp.readFile(wavPath);
    const hash = createHash('sha256').update(buf).digest('hex');
    const info = await probe(this.bins, wavPath);
    const storageKey = this.s.storage.key('originals', `${hash}.wav`);
    await this.s.storage.storeOriginal(wavPath, storageKey);
    const asset: Asset = {
      id: randomUUID(), projectId, kind: 'audio', originalName: name, sha256: hash, storageKey, sizeBytes: buf.length,
      durationMs: info.durationMs, width: null, height: null, fps: null, videoCodec: null, audioCodec: info.audioCodec, hasAudio: true,
      carLabel: null, tags, rightsDeclaration: { owner: 'Voz sintética gerada pelo estúdio', usage: 'proprio', notes: rightsNotes },
      proxyKey: null, thumbnailKey: null, status: 'ready', duplicateOf: null, createdAt: now(),
    };
    this.s.db.insert('assets', asset, { project_id: projectId, sha256: hash });
    this.s.db.audit(this.actor, 'asset.generate', projectId, { assetId: asset.id, tags });
    return asset;
  }

  // ---------- Eventos (RF-004) ----------
  listEvents(projectId: string): Event[] { return this.s.db.list<Event>('events', 'project_id = ?', [projectId], 'created_at ASC', 1000); }

  createEvent(projectId: string, input: CreateEventInput): Event {
    this.project(projectId);
    const asset = this.asset(input.assetId);
    if (asset.projectId !== projectId || asset.kind !== 'video') throw new DomainError('UNKNOWN_ASSET', 'O vídeo não pertence a este projeto', 422);
    if (asset.durationMs == null || input.endMs > asset.durationMs) throw new DomainError('SOURCE_OUT_OF_RANGE', 'Trecho fora da duração do vídeo', 422);
    // Marcação manual é feita pelo próprio usuário: entra como confirmada, com autoria registrada.
    const ev: Event = {
      id: randomUUID(), projectId, assetId: asset.id, startMs: input.startMs, endMs: input.endMs, type: input.type, description: input.description,
      confidence: 1, origin: 'manual', evidenceFrames: input.evidenceFrames, review: 'confirmed', reviewedBy: this.actor, reviewedAt: now(), createdAt: now(),
    };
    this.s.db.insert('events', ev, { project_id: projectId });
    this.advance(projectId, 'events_review');
    return ev;
  }

  patchEvent(id: string, patch: PatchEventInput): Event {
    const ev = this.s.db.get<Event>('events', id);
    if (!ev) throw notFound('Evento');
    const asset = this.asset(ev.assetId);
    const next: Event = { ...ev, ...patch };
    if (next.endMs <= next.startMs) throw new DomainError('INVALID_INTERVAL', 'Fim deve ser maior que o início', 422);
    if (asset.durationMs != null && next.endMs > asset.durationMs) throw new DomainError('SOURCE_OUT_OF_RANGE', 'Trecho fora da duração do vídeo', 422);
    if (patch.review && patch.review !== ev.review) {
      // Revisão é ação humana identificada (spec §12): registra quem e quando.
      next.reviewedBy = this.actor;
      next.reviewedAt = now();
    }
    this.s.db.update('events', next);
    this.s.db.audit(this.actor, 'event.patch', ev.projectId, { eventId: id, patch });
    return next;
  }

  // ---------- Roteiro (RF-006, RF-007) ----------
  listScripts(projectId: string): ScriptVersion[] { return this.s.db.list<ScriptVersion>('scripts', 'project_id = ?', [projectId], 'version DESC', 50); }

  script(id: string): ScriptVersion {
    const s = this.s.db.get<ScriptVersion>('scripts', id);
    if (!s) throw notFound('Roteiro');
    return s;
  }

  saveScript(projectId: string, input: ScriptInput) {
    this.project(projectId);
    const assets = new Map(this.listAssets(projectId).map((a) => [a.id, a]));
    const events = new Map(this.listEvents(projectId).map((e) => [e.id, e]));
    const { segments, pending, sourceEventIds } = validateScript(input, { assets, events, projectId });
    const latest = this.listScripts(projectId)[0];
    const hash = hashOf({ segments: segments.map(({ id: _id, ...rest }) => rest) });
    if (latest && latest.hash === hash && latest.status === input.status) return { script: latest, pending, invalidated: [] as string[], unchanged: true };

    const script: ScriptVersion = { id: randomUUID(), projectId, version: (latest?.version ?? 0) + 1, segments, sourceEventIds, hash, status: input.status, createdAt: now() };
    const invalidated = this.s.db.tx(() => {
      this.s.db.insert('scripts', script, { project_id: projectId, version: script.version });
      // J3/AC-008: roteiro novo invalida voz, legendas, timelines, renders e aprovações dependentes.
      return this.invalidateDownstream(projectId, `Roteiro alterado para v${script.version}`);
    });
    const p = this.project(projectId);
    this.setStatus(p, input.status === 'reviewed' ? 'producing' : 'script_review');
    return { script, pending, invalidated, unchanged: false };
  }

  private invalidateDownstream(projectId: string, reason: string, keepTimelineId?: string): string[] {
    const ids: string[] = [];
    for (const t of this.s.db.list<TimelineVersion>('timelines', 'project_id = ?', [projectId], 'version DESC', 1000)) {
      if (!t.stale && t.id !== keepTimelineId) { this.s.db.update('timelines', { ...t, stale: true }); ids.push(`timeline:${t.id}`); }
    }
    for (const a of this.listApprovals(projectId)) {
      if (!a.invalidatedAt) {
        this.s.db.update('approvals', { ...a, invalidatedAt: now(), invalidationReason: reason });
        ids.push(`approval:${a.id}`);
      }
    }
    if (ids.length) this.s.db.audit(this.actor, 'invalidate', projectId, { reason, ids });
    return ids;
  }

  // ---------- Timeline (RF-010, RF-011, AC-006) ----------
  timeline(id: string): TimelineVersion {
    const t = this.s.db.get<TimelineVersion>('timelines', id);
    if (!t) throw notFound('Timeline');
    return t;
  }

  createTimeline(projectId: string, input: CreateTimelineInput) {
    const script = this.script(input.scriptVersionId);
    if (script.projectId !== projectId) throw notFound('Roteiro');
    const latest = this.listScripts(projectId)[0];
    if (latest?.id !== script.id) throw new DomainError('SCRIPT_OUTDATED', `Use a versão mais recente do roteiro (v${latest?.version})`, 409);
    if (script.status !== 'reviewed') {
      throw new DomainError('SCRIPT_NOT_REVIEWED', 'Marque o roteiro como revisado (sem afirmações pendentes) antes de montar a timeline.', 409);
    }
    const assets = new Map(this.listAssets(projectId).map((a) => [a.id, a]));
    const narration: Record<string, { assetId: string; durationMs: number; kind: Asset['kind'] }> = {};
    for (const [segmentId, assetId] of Object.entries(input.narration)) {
      if (!script.segments.some((s) => s.id === segmentId)) throw new DomainError('UNKNOWN_SEGMENT', `Trecho ${segmentId} não existe no roteiro`, 422);
      const a = assets.get(assetId);
      if (!a || !a.hasAudio || a.durationMs == null || a.kind !== 'audio') throw new DomainError('INVALID_NARRATION', 'Narração precisa ser um áudio importado neste projeto', 422, { segmentId });
      narration[segmentId] = { assetId, durationMs: a.durationMs, kind: a.kind };
    }
    Object.entries(input.crops).forEach(([k, c]) => assertCropInside(c, `crops.${k}`));
    const built = buildTimeline({ segments: script.segments, format: input.format, assets, narration, crops: input.crops });
    return this.saveTimeline(projectId, script.id, input.format, built.clips, built.audioTracks, built.captions, 'estimated_from_script', input.mix);
  }

  private saveTimeline(projectId: string, scriptVersionId: string, format: TimelineVersion['format'], clips: TimelineVersion['clips'], audioTracks: TimelineVersion['audioTracks'], captions: TimelineVersion['captions'], captionsOrigin: TimelineVersion['captionsOrigin'], mix: TimelineVersion['mix']) {
    const last = this.s.db.list<TimelineVersion>('timelines', 'project_id = ?', [projectId], 'version DESC', 1)[0];
    const hash = hashOf({ scriptVersionId, format, clips: clips.map(({ id: _i, ...c }) => c), audioTracks: audioTracks.map(({ id: _i, ...a }) => a), captions: captions.map(({ id: _i, ...c }) => c), mix });
    const t: TimelineVersion = { id: randomUUID(), projectId, version: (last?.version ?? 0) + 1, scriptVersionId, format, clips, audioTracks, captions, captionsOrigin, mix, hash, stale: false, createdAt: now() };
    const invalidated = this.s.db.tx(() => {
      this.s.db.insert('timelines', t, { project_id: projectId, version: t.version });
      return this.invalidateDownstream(projectId, `Timeline alterada para v${t.version}`, t.id);
    });
    this.advance(projectId, 'producing');
    const p = this.project(projectId);
    if (p.status === 'approved' || p.status === 'exported' || p.status === 'render_review') this.setStatus(p, 'producing');
    return { timeline: t, invalidated };
  }

  reviseTimeline(id: string, input: TimelineRevisionInput) {
    const base = this.timeline(id);
    if (base.stale) throw new DomainError('TIMELINE_STALE', 'Esta timeline está desatualizada; crie uma nova a partir do roteiro atual.', 409);
    const clips = base.clips.map((c) => {
      const crop = input.crops?.[c.segmentId] ?? input.crops?.[c.id];
      if (crop) assertCropInside(crop, `crops.${c.segmentId}`);
      return crop ? { ...c, crop } : c;
    });
    const totalMs = clips.reduce((n, c) => n + c.durationMs, 0);
    let captions = base.captions;
    let origin = base.captionsOrigin;
    if (input.captions) {
      assertCaptionsValid(input.captions, totalMs);
      captions = input.captions.map((c) => ({ id: randomUUID(), ...c }));
      origin = 'edited';
    }
    const mix = input.mix ? MixSettings.parse(input.mix) : base.mix;
    return this.saveTimeline(base.projectId, base.scriptVersionId, base.format, clips, base.audioTracks, captions, origin, mix);
  }

  captionsSrt(timelineId: string) { return toSrt(this.timeline(timelineId).captions); }

  // ---------- Render (RF-010) ----------
  async requestRender(timelineId: string, profile: Render['profile'], idempotencyKey: string | null) {
    const t = this.timeline(timelineId);
    if (t.stale) throw new DomainError('TIMELINE_STALE', 'Timeline desatualizada por alteração posterior; crie uma nova.', 409);
    const free = await this.s.storage.freeBytes();
    if (free < this.s.config.minFreeDiskBytes) {
      throw new DomainError('INSUFFICIENT_DISK', `Espaço livre insuficiente (${Math.round(free / 1e6)} MB; mínimo ${Math.round(this.s.config.minFreeDiskBytes / 1e6)} MB).`, 507);
    }
    const inputHash = hashOf({ render: t.hash, profile, engine: 'ffmpeg-v1' });
    const existing = this.s.db.list<Render>('renders', 'project_id = ?', [t.projectId], 'created_at DESC', 200)
      .find((r) => r.timelineVersionId === t.id && r.profile === profile && (r.status === 'succeeded' || r.status === 'queued' || r.status === 'running'));
    if (existing) return { render: existing, reused: true };

    const render: Render = { id: randomUUID(), timelineVersionId: t.id, profile, status: 'queued', jobId: null, outputKey: null, srtKey: null, sha256: null, durationMs: null, diagnostics: {}, createdAt: now() };
    const { job, reused } = this.s.jobs.enqueue({ projectId: t.projectId, type: 'render', payload: { renderId: render.id }, inputHash: `${inputHash}:${render.id}`, idempotencyKey });
    if (reused) {
      const prev = this.s.db.get<Render>('renders', String(job.payload.renderId));
      if (prev) return { render: prev, reused: true };
    }
    render.jobId = job.id;
    this.s.db.insert('renders', render, { project_id: t.projectId });
    return { render, reused: false };
  }

  render(id: string): Render {
    const r = this.s.db.get<Render>('renders', id);
    if (!r) throw notFound('Render');
    return r;
  }

  // ---------- Aprovação (RF-014, AC-008, AC-011) ----------
  listApprovals(projectId: string): Approval[] { return this.s.db.list<Approval>('approvals', 'project_id = ?', [projectId], 'created_at DESC', 100); }

  /** Calcula o hash do pacote exatamente como está agora (render + legendas + metadados + thumbnail + canal). */
  currentPackage(renderId: string, metadata: unknown, thumbnailAssetId: string | null, channel: string | null) {
    const render = this.render(renderId);
    if (render.status !== 'succeeded' || !render.sha256 || !render.outputKey) throw new DomainError('RENDER_NOT_READY', 'O render ainda não foi concluído com sucesso', 409);
    const t = this.timeline(render.timelineVersionId);
    const script = this.script(t.scriptVersionId);
    const srt = render.srtKey && this.s.storage.exists(render.srtKey) ? sha256(fs.readFileSync(this.s.storage.resolve(render.srtKey))) : null;
    const thumb = thumbnailAssetId ? this.asset(thumbnailAssetId) : null;
    if (thumb && (thumb.projectId !== t.projectId || thumb.kind !== 'image')) throw new DomainError('INVALID_THUMBNAIL', 'Thumbnail precisa ser uma imagem deste projeto', 422);
    const parts = { renderId, renderSha256: render.sha256, srtSha256: srt, metadata, thumbnailSha256: thumb?.sha256 ?? null, channel, scriptVersionId: script.id, scriptHash: script.hash, timelineHash: t.hash };
    return { render, timeline: t, script, thumb, parts, hash: packageHash(parts) };
  }

  /** Ação humana autenticada (painel). Não é exposta como ferramenta autônoma de agente (spec §12). */
  approve(projectId: string, input: CreateApprovalInput): Approval {
    const pkg = this.currentPackage(input.renderId, input.metadata, input.thumbnailAssetId, input.metadata.channel);
    if (pkg.timeline.projectId !== projectId) throw notFound('Render');
    if (pkg.render.profile !== 'final') throw new DomainError('FINAL_RENDER_REQUIRED', 'Aprove um render final (o preview serve apenas para revisão).', 409);
    if (pkg.timeline.stale) throw new DomainError('TIMELINE_STALE', 'O render pertence a uma timeline desatualizada.', 409);
    const latestScript = this.listScripts(projectId)[0];
    if (latestScript?.id !== pkg.script.id) throw new DomainError('SCRIPT_OUTDATED', 'O roteiro mudou depois deste render.', 409);

    const p = this.project(projectId);
    nextStatus(p.status === 'producing' ? 'render_review' : p.status, 'approved');
    const approval: Approval = {
      id: randomUUID(), projectId, renderId: pkg.render.id, packageHash: pkg.hash,
      manifest: { ...pkg.parts, metadata: input.metadata, thumbnailAssetId: input.thumbnailAssetId },
      approvedBy: this.actor, approvedAt: now(), invalidatedAt: null, invalidationReason: null, createdAt: now(),
    };
    this.s.db.tx(() => {
      for (const a of this.listApprovals(projectId)) {
        if (!a.invalidatedAt) this.s.db.update('approvals', { ...a, invalidatedAt: now(), invalidationReason: 'Substituída por nova aprovação' });
      }
      this.s.db.insert('approvals', approval, { project_id: projectId });
      this.s.db.audit(this.actor, 'approval.create', projectId, { approvalId: approval.id, packageHash: approval.packageHash });
    });
    this.setStatus(this.project(projectId), 'approved');
    return approval;
  }

  /** Verifica a aprovação contra o estado atual do pacote (bloqueia versão divergente). */
  verifyApproval(projectId: string, approvalId: string): { approval: Approval; pkg: ReturnType<StudioService['currentPackage']> } {
    const approval = this.s.db.get<Approval>('approvals', approvalId);
    if (!approval || approval.projectId !== projectId) throw new DomainError('APPROVAL_REQUIRED', 'Aprovação não encontrada para este projeto', 409);
    const m = approval.manifest as { metadata: { channel: string | null }; thumbnailAssetId: string | null };
    const pkg = this.currentPackage(approval.renderId, m.metadata, m.thumbnailAssetId, m.metadata.channel);
    assertApprovalValid(approval, pkg.hash);
    return { approval, pkg };
  }

  // ---------- Exportação (RF-015) ----------
  requestExport(projectId: string, approvalId: string, idempotencyKey: string | null) {
    const { approval } = this.verifyApproval(projectId, approvalId);
    return this.s.jobs.enqueue({ projectId, type: 'export', payload: { approvalId }, inputHash: hashOf({ export: approval.packageHash }), idempotencyKey });
  }

  exportRecord(id: string): ExportRecord {
    const e = this.s.db.get<ExportRecord>('exports', id);
    if (!e) throw notFound('Exportação');
    return e;
  }

  // ---------- Publicação (P1) ----------
  requestPublication(projectId: string, approvalId: string | undefined) {
    if (!approvalId) throw new DomainError('APPROVAL_REQUIRED', 'Publicação exige approvalId válido', 409);
    this.verifyApproval(projectId, approvalId); // AC-011: bloqueio no domínio vale para API e MCP.
    throw new DomainError('PUBLICATION_NOT_CONFIGURED', 'Nenhuma integração de publicação configurada (YouTube entra no marco M4/P1). Use a exportação manual.', 501);
  }

  // ---------- Capacidades (M0) ----------
  async capabilities() {
    const media = await detectCapabilities(this.bins);
    return {
      media,
      providers: {
        llm: { configured: false, note: 'Roteiro é escrito manualmente no M1. Adaptador de texto (ex.: Ollama) entra no M2.' },
        vision: { configured: false, note: 'Sem modelo visual: use a marcação manual de cenas (AC-003). A heurística de mudança de cena do FFmpeg está disponível e gera apenas candidatos pendentes.' },
        voice: await this.voiceCapability(),
        transcription: { configured: false, note: 'Legendas são estimadas a partir do texto e da duração real do áudio; corrija na montagem. Whisper entra no M2.' },
        publication: { configured: false, note: 'Publicação no YouTube é P1 (M4). Exportação manual disponível.' },
        grokbot: { configured: false, note: 'PENDENTE: produto ainda não identificado (RF-020).' },
      },
      limits: {
        maxImportMb: Math.round(this.s.config.maxImportBytes / 1024 / 1024),
        maxImportDurationMin: Math.round(this.s.config.maxImportDurationMs / 60000),
        minFreeDiskMb: Math.round(this.s.config.minFreeDiskBytes / 1024 / 1024),
        confidenceTriageThreshold: this.s.config.confidenceThreshold,
      },
      storage: { freeMb: Math.round((await this.s.storage.freeBytes()) / 1024 / 1024) },
    };
  }
}

export interface ExportRecord {
  id: string;
  projectId: string;
  approvalId: string;
  packageHash: string;
  folderKey: string;
  files: { name: string; sha256: string; sizeBytes: number }[];
  createdAt: string;
}
