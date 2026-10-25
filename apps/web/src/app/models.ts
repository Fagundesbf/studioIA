// Tipos espelhados de packages/contracts (a UI não importa Zod para manter o bundle leve).
export type ProjectStatus = 'draft' | 'media_ready' | 'analyzing' | 'events_review' | 'scripting' | 'script_review' | 'producing' | 'render_review' | 'approved' | 'exported';

export interface Project { id: string; title: string; gameLabel: string; template: 'gameplay_narrado' | 'short'; objective: string; status: ProjectStatus; createdAt: string }

export interface Asset {
  id: string; projectId: string; kind: 'video' | 'image' | 'audio'; originalName: string; sha256: string; sizeBytes: number;
  durationMs: number | null; width: number | null; height: number | null; fps: number | null; videoCodec: string | null; audioCodec: string | null;
  hasAudio: boolean; carLabel: string | null; tags: string[]; rightsDeclaration: { owner: string; usage: string; notes: string };
  proxyKey: string | null; thumbnailKey: string | null; status: 'processing' | 'ready' | 'failed'; duplicateOf: string | null; createdAt: string;
}

export interface StudioEvent {
  id: string; assetId: string; startMs: number; endMs: number; type: string; description: string; confidence: number;
  origin: 'manual' | 'model' | 'heuristic'; evidenceFrames: { timestampMs: number }[]; review: 'pending' | 'confirmed' | 'rejected';
  reviewedBy: string | null; reviewedAt: string | null;
}

export interface SourceRef { assetId: string; startMs: number; endMs: number; eventId?: string }
export interface FactualClaim { text: string; sourceRefs: SourceRef[]; reviewed: boolean }
export type SegmentRole = 'gancho' | 'contexto' | 'desenvolvimento' | 'fechamento';
export interface Segment { id?: string; role: SegmentRole; narrationText: string; isOpinion: boolean; sourceRefs: SourceRef[]; targetDurationMs: number; overlayText?: string; notes?: string; factualClaims: FactualClaim[] }
export interface ScriptVersion { id: string; version: number; segments: (Segment & { id: string })[]; status: 'draft' | 'reviewed'; hash: string; createdAt: string }

export interface Crop { x: number; y: number; width: number; height: number }
export interface Clip { id: string; segmentId: string; sourceRef: SourceRef; timelineStartMs: number; durationMs: number; crop: Crop; playbackRate: number }
export interface Caption { id?: string; startMs: number; endMs: number; text: string }
export interface Timeline {
  id: string; version: number; scriptVersionId: string; format: 'horizontal' | 'vertical'; clips: Clip[];
  audioTracks: { segmentId: string; assetId: string; timelineStartMs: number; durationMs: number }[];
  captions: Caption[]; captionsOrigin: 'estimated_from_script' | 'edited'; stale: boolean; createdAt: string;
  mix: { gameVolume: number; duckedGameVolume: number; narrationVolume: number; targetLufs: number; truePeakDb: number };
}

export interface Render {
  id: string; timelineVersionId: string; profile: 'preview' | 'final'; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  jobId: string | null; sha256: string | null; durationMs: number | null; diagnostics: Record<string, any>; createdAt: string;
}

export interface Approval { id: string; renderId: string; packageHash: string; approvedBy: string; approvedAt: string; invalidatedAt: string | null; invalidationReason: string | null; manifest: Record<string, any> }

export interface Job {
  id: string; projectId: string; type: 'ingest' | 'analyze' | 'voice' | 'render' | 'export'; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number; maxAttempts: number; progress: number | null; stage: string | null; errorCode: string | null; errorMessage: string | null;
  result: Record<string, any> | null; createdAt: string; updatedAt: string;
}

export interface ExportRecord { id: string; approvalId: string; packageHash: string; files: { name: string; sha256: string; sizeBytes: number }[]; createdAt: string }

export interface Overview {
  project: Project; assets: Asset[]; events: StudioEvent[]; latestScript: ScriptVersion | null;
  scripts: { id: string; version: number; status: string; createdAt: string }[];
  latestTimeline: Timeline | null; timelines: { id: string; version: number; format: string; stale: boolean }[];
  renders: Render[]; approvals: Approval[]; exports: ExportRecord[]; jobs: Job[];
}

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: 'Rascunho', media_ready: 'Mídia pronta', analyzing: 'Analisando', events_review: 'Revisão de cenas', scripting: 'Roteiro',
  script_review: 'Revisão do roteiro', producing: 'Produção', render_review: 'Revisão do render', approved: 'Aprovado', exported: 'Exportado',
};

export const JOB_LABEL: Record<Job['type'], string> = { ingest: 'Processar mídia', analyze: 'Analisar cenas', voice: 'Gerar narração', render: 'Renderizar', export: 'Exportar pacote' };
export const JOB_STATUS_LABEL: Record<Job['status'], string> = { queued: 'Na fila', running: 'Executando', succeeded: 'Concluído', failed: 'Falhou', cancelled: 'Cancelado' };
export const ROLE_LABEL: Record<SegmentRole, string> = { gancho: 'Gancho', contexto: 'Contexto', desenvolvimento: 'Desenvolvimento', fechamento: 'Fechamento' };

export const EVENT_TYPES = [
  ['ultrapassagem', 'Ultrapassagem'], ['largada', 'Largada'], ['chegada', 'Chegada'], ['colisao', 'Colisão'], ['volta_rapida', 'Volta rápida'],
  ['drift', 'Drift'], ['erro', 'Erro / rodada'], ['paisagem', 'Paisagem / cena bonita'], ['outro', 'Outro'],
] as const;

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 100))}`;
}

export function fmtBytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
