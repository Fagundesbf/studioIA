// Regras de domínio puras (sem I/O). UI, API, worker e futuro MCP usam estas mesmas funções.
import { createHash, randomUUID } from 'node:crypto';
import type {
  Asset, Caption, Clip, AudioTrack, Crop, Event, FormatId, MixSettings, ProjectStatus,
  ScriptInput, Segment, SourceRef,
} from '@rs/contracts';

// ---------- Erros ----------
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 422,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

// ---------- Hash canônico ----------
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export const hashOf = (value: unknown) => sha256(stableStringify(value));

// ---------- Estados do projeto (spec §10) ----------
export const PROJECT_FLOW: ProjectStatus[] = [
  'draft', 'media_ready', 'analyzing', 'events_review', 'scripting',
  'script_review', 'producing', 'render_review', 'approved', 'exported',
];

/**
 * Avança o estado editorial. Uma revisão pode voltar a uma etapa anterior (J3),
 * mas nunca pular direto para approved/exported — isso só acontece pelos casos de uso.
 */
export function nextStatus(current: ProjectStatus, target: ProjectStatus): ProjectStatus {
  if (target === 'approved' && current !== 'render_review' && current !== 'approved' && current !== 'exported') {
    throw new DomainError('INVALID_TRANSITION', `Não é possível aprovar a partir de "${current}"`, 409);
  }
  if (target === 'exported' && current !== 'approved' && current !== 'exported') {
    throw new DomainError('INVALID_TRANSITION', `Exportação exige aprovação válida (estado atual: "${current}")`, 409);
  }
  return target;
}

/** Só avança: usado quando uma etapa é concluída, sem regredir o projeto. */
export function forwardStatus(current: ProjectStatus, reached: ProjectStatus): ProjectStatus {
  return PROJECT_FLOW.indexOf(reached) > PROJECT_FLOW.indexOf(current) ? reached : current;
}

// ---------- Mídia ----------
export const ALLOWED_IMPORT_EXT: Record<string, Asset['kind']> = {
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video',
  '.wav': 'audio', '.mp3': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio', '.ogg': 'audio',
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image',
};

export function frameMs(fps: number | null | undefined): number {
  return fps && fps > 0 ? 1000 / fps : 1000 / 30;
}

export function assertRefInsideAsset(ref: SourceRef, asset: Pick<Asset, 'id' | 'durationMs' | 'kind'> | undefined, path: string) {
  if (!asset) throw new DomainError('UNKNOWN_ASSET', `Asset inexistente em ${path}`, 422, { path, assetId: ref.assetId });
  if (asset.kind !== 'video') throw new DomainError('INVALID_SOURCE', `A fonte em ${path} não é um vídeo`, 422, { path });
  if (asset.durationMs == null) throw new DomainError('ASSET_NOT_READY', `O vídeo em ${path} ainda não foi processado`, 409, { path });
  if (ref.endMs > asset.durationMs) {
    throw new DomainError('SOURCE_OUT_OF_RANGE',
      `Tempo fora da fonte em ${path}: fim ${ref.endMs} ms > duração ${asset.durationMs} ms`, 422,
      { path, endMs: ref.endMs, durationMs: asset.durationMs });
  }
}

// ---------- Roteiro (RF-006, AC-004, AC-005) ----------
export interface ScriptContext {
  assets: Map<string, Pick<Asset, 'id' | 'durationMs' | 'kind' | 'projectId'>>;
  events: Map<string, Pick<Event, 'id' | 'assetId' | 'review' | 'projectId'>>;
  projectId: string;
}

export interface ScriptIssue { path: string; code: string; message: string }

/**
 * Valida integridade do roteiro. Erros bloqueiam o salvamento (IDs/tempos inexistentes);
 * pendências (afirmações não revisadas) bloqueiam apenas a marcação "revisado" e o render.
 */
export function validateScript(input: ScriptInput, ctx: ScriptContext): { segments: Segment[]; pending: ScriptIssue[]; sourceEventIds: string[] } {
  const pending: ScriptIssue[] = [];
  const eventIds = new Set<string>();

  const checkRef = (ref: SourceRef, path: string) => {
    const asset = ctx.assets.get(ref.assetId);
    if (asset && asset.projectId !== ctx.projectId) {
      throw new DomainError('UNKNOWN_ASSET', `Asset de outro projeto em ${path}`, 422, { path });
    }
    assertRefInsideAsset(ref, asset, path);
    if (ref.eventId) {
      const ev = ctx.events.get(ref.eventId);
      if (!ev || ev.projectId !== ctx.projectId) {
        throw new DomainError('UNKNOWN_EVENT', `Evento inexistente em ${path}`, 422, { path, eventId: ref.eventId });
      }
      if (ev.assetId !== ref.assetId) {
        throw new DomainError('EVENT_ASSET_MISMATCH', `O evento em ${path} pertence a outro vídeo`, 422, { path });
      }
      eventIds.add(ev.id);
      return ev;
    }
    return undefined;
  };

  const segments: Segment[] = input.segments.map((s, i) => {
    s.sourceRefs.forEach((r, j) => checkRef(r, `segments.${i}.sourceRefs.${j}`));
    s.factualClaims.forEach((c, k) => {
      c.sourceRefs.forEach((r, j) => {
        const path = `segments.${i}.factualClaims.${k}.sourceRefs.${j}`;
        const ev = checkRef(r, path);
        if (!ev) {
          pending.push({ path, code: 'CLAIM_WITHOUT_EVENT', message: 'Afirmação sobre gameplay precisa apontar para um evento revisado' });
        } else if (ev.review === 'rejected') {
          pending.push({ path, code: 'CLAIM_ON_REJECTED_EVENT', message: 'Afirmação aponta para evento rejeitado' });
        } else if (ev.review === 'pending') {
          pending.push({ path, code: 'CLAIM_ON_PENDING_EVENT', message: 'Evento ainda pendente: não pode ser narrado como fato' });
        }
      });
      if (!c.reviewed) {
        pending.push({ path: `segments.${i}.factualClaims.${k}`, code: 'CLAIM_NOT_REVIEWED', message: 'Afirmação factual ainda não revisada' });
      }
    });
    return { ...s, id: s.id ?? randomUUID(), isOpinion: s.isOpinion ?? false };
  });

  if (input.status === 'reviewed' && pending.length > 0) {
    throw new DomainError('SCRIPT_HAS_PENDING_CLAIMS',
      'O roteiro tem afirmações factuais pendentes e não pode ser marcado como revisado', 422, pending);
  }
  return { segments, pending, sourceEventIds: [...eventIds] };
}

/** Estimativa simples de fala pt-BR (~150 palavras/min). Apenas estimativa, nunca usada para cortar fala. */
export function estimateNarrationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / 150) * 60_000);
}

// ---------- Recorte e formato (RF-011, §15: nunca esticar) ----------
export const FORMATS: Record<FormatId, { width: number; height: number; fps: number }> = {
  horizontal: { width: 1920, height: 1080, fps: 30 },
  vertical: { width: 1080, height: 1920, fps: 30 },
};

/** Maior recorte centralizado com a proporção do formato de saída, em coordenadas normalizadas. */
export function defaultCrop(format: FormatId, srcW: number, srcH: number): Crop {
  const target = FORMATS[format].width / FORMATS[format].height;
  const src = srcW / srcH;
  if (Math.abs(src - target) < 0.01) return { x: 0, y: 0, width: 1, height: 1 };
  if (src > target) {
    const w = target / src;
    return { x: round6((1 - w) / 2), y: 0, width: round6(w), height: 1 };
  }
  const h = src / target;
  return { x: 0, y: round6((1 - h) / 2), width: 1, height: round6(h) };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function assertCropInside(c: Crop, path: string) {
  if (c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0 || c.x + c.width > 1 + 1e-6 || c.y + c.height > 1 + 1e-6) {
    throw new DomainError('CROP_OUT_OF_FRAME', `Recorte fora do quadro em ${path}`, 422, { path, crop: c });
  }
}

// ---------- Timeline (RF-010, AC-006) ----------
export function clipDurationMs(ref: SourceRef, playbackRate: number): number {
  return Math.round((ref.endMs - ref.startMs) / playbackRate);
}

export function assertClipDuration(clip: Pick<Clip, 'sourceRef' | 'playbackRate' | 'durationMs'>, fps: number | null) {
  const expected = (clip.sourceRef.endMs - clip.sourceRef.startMs) / clip.playbackRate;
  if (Math.abs(expected - clip.durationMs) > frameMs(fps)) {
    throw new DomainError('CLIP_DURATION_MISMATCH', 'Duração do clip difere de (fim-início)/velocidade além de 1 frame', 422,
      { expected, actual: clip.durationMs });
  }
}

export interface BuildTimelineArgs {
  segments: Segment[];
  format: FormatId;
  assets: Map<string, Pick<Asset, 'id' | 'width' | 'height' | 'durationMs' | 'kind' | 'fps'>>;
  narration: Record<string, { assetId: string; durationMs: number; kind: Asset['kind'] }>;
  crops: Record<string, Crop>;
}

export function buildTimeline(args: BuildTimelineArgs): { clips: Clip[]; audioTracks: AudioTrack[]; captions: Caption[]; totalMs: number } {
  const clips: Clip[] = [];
  const audioTracks: AudioTrack[] = [];
  const captions: Caption[] = [];
  const tooLong: unknown[] = [];
  let cursor = 0;

  args.segments.forEach((seg, i) => {
    const segStart = cursor;
    seg.sourceRefs.forEach((ref, j) => {
      const asset = args.assets.get(ref.assetId);
      assertRefInsideAsset(ref, asset as Asset | undefined, `segments.${i}.sourceRefs.${j}`);
      const crop = args.crops[seg.id] ?? defaultCrop(args.format, asset!.width ?? 1920, asset!.height ?? 1080);
      assertCropInside(crop, `crops.${seg.id}`);
      const durationMs = clipDurationMs(ref, 1);
      clips.push({ id: randomUUID(), segmentId: seg.id, sourceRef: ref, timelineStartMs: cursor, durationMs, crop, playbackRate: 1 });
      cursor += durationMs;
    });
    const available = cursor - segStart;
    const voice = args.narration[seg.id];
    if (voice) {
      if (voice.kind !== 'audio' && voice.kind !== 'video') {
        throw new DomainError('INVALID_NARRATION', `Narração do trecho ${i + 1} não é áudio`, 422);
      }
      if (voice.durationMs > available) {
        // Nunca cortar palavras (spec §10): bloqueia com ação clara.
        tooLong.push({
          segmentIndex: i, segmentId: seg.id, narrationMs: voice.durationMs, availableMs: available,
          missingMs: voice.durationMs - available,
          suggestion: 'Estenda as cenas do trecho, adicione outra cena ou encurte o texto e regrave a narração.',
        });
        return;
      }
      audioTracks.push({ id: randomUUID(), kind: 'narration', segmentId: seg.id, assetId: voice.assetId, timelineStartMs: segStart, durationMs: voice.durationMs });
      captions.push(...splitCaptions(seg.narrationText, segStart, voice.durationMs));
    }
  });

  if (tooLong.length) {
    throw new DomainError('NARRATION_TOO_LONG', 'A narração é maior que as cenas de um ou mais trechos. Nada foi cortado.', 422, tooLong);
  }
  if (clips.length === 0) throw new DomainError('EMPTY_TIMELINE', 'Nenhum clip para montar', 422);
  return { clips, audioTracks, captions, totalMs: cursor };
}

// ---------- Legendas (RF-009, §15: máx. 2 linhas) ----------
export const CAPTION_LINE_CHARS = 42;

export function wrapCaption(text: string, maxChars = CAPTION_LINE_CHARS): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (!line) line = w;
    else if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Distribui o texto da narração pela duração real do áudio, proporcional ao número de caracteres.
 * É uma ESTIMATIVA (não é transcrição); o usuário pode corrigir na tela de montagem.
 */
export function splitCaptions(text: string, startMs: number, durationMs: number): Caption[] {
  const lines = wrapCaption(text.trim());
  if (!lines.length || durationMs <= 0) return [];
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 2) blocks.push(lines.slice(i, i + 2).join('\n'));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  let t = startMs;
  return blocks.map((b, i) => {
    const end = i === blocks.length - 1 ? startMs + durationMs : t + Math.max(500, Math.round((b.length / total) * durationMs));
    const cap = { id: randomUUID(), startMs: t, endMs: Math.min(end, startMs + durationMs), text: b };
    t = cap.endMs;
    return cap;
  }).filter((c) => c.endMs > c.startMs);
}

export function assertCaptionsValid(captions: Pick<Caption, 'startMs' | 'endMs' | 'text'>[], totalMs: number) {
  captions.forEach((c, i) => {
    if (c.endMs > totalMs) throw new DomainError('CAPTION_OUT_OF_RANGE', `Legenda ${i + 1} termina depois do vídeo`, 422, { index: i });
    if (c.text.split('\n').length > 2) throw new DomainError('CAPTION_TOO_MANY_LINES', `Legenda ${i + 1} tem mais de 2 linhas`, 422, { index: i });
  });
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function srtTime(ms: number, sep = ','): string {
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(captions: Pick<Caption, 'startMs' | 'endMs' | 'text'>[]): string {
  return captions.map((c, i) => `${i + 1}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${c.text}\n`).join('\n');
}

export function toVtt(captions: Pick<Caption, 'startMs' | 'endMs' | 'text'>[]): string {
  return 'WEBVTT\n\n' + captions.map((c) => `${srtTime(c.startMs, '.')} --> ${srtTime(c.endMs, '.')}\n${c.text}\n`).join('\n');
}

// ---------- Shorts (RF-012) ----------
export function selectShortCandidates<T extends Pick<Event, 'review' | 'startMs' | 'endMs'>>(events: T[], requested: number, maxShortMs = 60_000) {
  const usable = events.filter((e) => e.review === 'confirmed' && e.endMs - e.startMs <= maxShortMs);
  const selected = usable.slice(0, requested);
  return {
    selected,
    warning: selected.length < requested
      ? `Só existem ${selected.length} cena(s) confirmada(s) adequada(s) para ${requested} Short(s). Nenhuma cena foi repetida.`
      : null,
  };
}

// ---------- Aprovação e pacote (RF-014, RF-015, AC-008, AC-011) ----------
export interface PackageParts {
  renderId: string;
  renderSha256: string;
  srtSha256: string | null;
  metadata: unknown;
  thumbnailSha256: string | null;
  channel: string | null;
  scriptVersionId: string;
  scriptHash: string;
  timelineHash: string;
}

export function packageHash(parts: PackageParts): string {
  return hashOf(parts);
}

export function assertApprovalValid(
  approval: { invalidatedAt: string | null; packageHash: string } | undefined,
  currentPackageHash: string,
) {
  if (!approval) throw new DomainError('APPROVAL_REQUIRED', 'É necessária uma aprovação registrada', 409);
  if (approval.invalidatedAt) throw new DomainError('APPROVAL_INVALIDATED', 'A aprovação foi invalidada por uma alteração posterior', 409);
  if (approval.packageHash !== currentPackageHash) {
    throw new DomainError('APPROVAL_VERSION_MISMATCH', 'O pacote atual difere da versão aprovada', 409);
  }
}

// ---------- Retry (spec §10) ----------
export const TRANSIENT_ERRORS = new Set(['ETIMEDOUT', 'EBUSY', 'EAGAIN', 'PROVIDER_UNAVAILABLE', 'WORKER_LOST']);

export function backoffMs(attempt: number, baseMs = 2000, random = Math.random): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.round(exp / 2 + random() * (exp / 2)); // jitter "equal"
}

export type { MixSettings };
