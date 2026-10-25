// Contratos compartilhados entre web, API e worker (spec §8 e §9).
// Convenções: IDs UUID; datas ISO-8601 UTC; intervalos em ms inteiros [início, fim).
import { z } from 'zod';

export const Id = z.uuid();
export const Ms = z.number().int().nonnegative();
export const Confidence = z.number().min(0).max(1);
export const IsoDate = z.iso.datetime();

// ---------- Estados (spec §10) ----------
export const ProjectStatus = z.enum([
  'draft', 'media_ready', 'analyzing', 'events_review', 'scripting',
  'script_review', 'producing', 'render_review', 'approved', 'exported',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobType = z.enum(['ingest', 'analyze', 'voice', 'render', 'export']);
export type JobType = z.infer<typeof JobType>;

export const FormatId = z.enum(['horizontal', 'vertical']);
export type FormatId = z.infer<typeof FormatId>;

// ---------- Project ----------
export const Project = z.object({
  id: Id,
  title: z.string().min(1).max(200),
  kind: z.literal('gameplay'),
  template: z.enum(['gameplay_narrado', 'short']),
  gameLabel: z.string().min(1).max(100),
  objective: z.string().max(2000),
  language: z.literal('pt-BR'),
  status: ProjectStatus,
  createdAt: IsoDate,
});
export type Project = z.infer<typeof Project>;

export const CreateProjectInput = z.object({
  title: z.string().trim().min(1, 'Informe um título').max(200),
  gameLabel: z.string().trim().min(1, 'Informe o jogo').max(100),
  template: z.enum(['gameplay_narrado', 'short']).default('gameplay_narrado'),
  objective: z.string().trim().max(2000).default(''),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

// ---------- Asset ----------
export const RightsDeclaration = z.object({
  owner: z.string().trim().min(1, 'Declare quem é o dono/autor do material').max(200),
  usage: z.enum(['proprio', 'licenciado', 'outro']),
  notes: z.string().max(1000).default(''),
});
export type RightsDeclaration = z.infer<typeof RightsDeclaration>;

export const AssetKind = z.enum(['video', 'image', 'audio']);
export const Asset = z.object({
  id: Id,
  projectId: Id,
  kind: AssetKind,
  originalName: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storageKey: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: Ms.nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  fps: z.number().positive().nullable(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  hasAudio: z.boolean(),
  carLabel: z.string().nullable(),
  tags: z.array(z.string()),
  rightsDeclaration: RightsDeclaration,
  proxyKey: z.string().nullable(),
  thumbnailKey: z.string().nullable(),
  status: z.enum(['processing', 'ready', 'failed']),
  duplicateOf: Id.nullable(),
  createdAt: IsoDate,
});
export type Asset = z.infer<typeof Asset>;

// ---------- Event (spec §8/§9) ----------
export const EventOrigin = z.enum(['manual', 'model', 'heuristic']);
export const EventReview = z.enum(['pending', 'confirmed', 'rejected']);
export const EvidenceFrame = z.object({ timestampMs: Ms, storageKey: z.string().optional() });

export const Event = z.object({
  id: Id,
  projectId: Id,
  assetId: Id,
  startMs: Ms,
  endMs: Ms,
  type: z.string().min(1).max(60),
  description: z.string().max(1000),
  confidence: Confidence,
  origin: EventOrigin,
  evidenceFrames: z.array(EvidenceFrame),
  review: EventReview,
  reviewedBy: z.string().nullable(),
  reviewedAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type Event = z.infer<typeof Event>;

const intervalOk = (v: { startMs: number; endMs: number }) => v.endMs > v.startMs;

export const CreateEventInput = z.object({
  assetId: Id,
  startMs: Ms,
  endMs: Ms,
  type: z.string().trim().min(1).max(60),
  description: z.string().trim().max(1000).default(''),
  evidenceFrames: z.array(EvidenceFrame).max(20).default([]),
}).refine(intervalOk, { message: 'Fim deve ser maior que o início', path: ['endMs'] });
export type CreateEventInput = z.infer<typeof CreateEventInput>;

export const PatchEventInput = z.object({
  review: EventReview.optional(),
  startMs: Ms.optional(),
  endMs: Ms.optional(),
  type: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(1000).optional(),
});
export type PatchEventInput = z.infer<typeof PatchEventInput>;

// ---------- Script (spec §9) ----------
export const SourceRef = z.object({
  assetId: Id,
  startMs: Ms,
  endMs: Ms,
  eventId: Id.optional(),
}).refine(intervalOk, { message: 'Intervalo da fonte inválido (fim <= início)' });
export type SourceRef = z.infer<typeof SourceRef>;

export const FactualClaim = z.object({
  text: z.string().trim().min(1).max(500),
  sourceRefs: z.array(SourceRef).min(1, 'Toda afirmação precisa de fonte'),
  reviewed: z.boolean(),
});
export type FactualClaim = z.infer<typeof FactualClaim>;

export const SegmentRole = z.enum(['gancho', 'contexto', 'desenvolvimento', 'fechamento']);
export type SegmentRole = z.infer<typeof SegmentRole>;

export const Segment = z.object({
  id: Id,
  role: SegmentRole,
  narrationText: z.string().max(4000),
  isOpinion: z.boolean().default(false),
  sourceRefs: z.array(SourceRef).min(1, 'Cada trecho precisa de ao menos uma cena de origem'),
  targetDurationMs: Ms,
  overlayText: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  factualClaims: z.array(FactualClaim),
});
export type Segment = z.infer<typeof Segment>;

export const ScriptVersion = z.object({
  id: Id,
  projectId: Id,
  version: z.number().int().positive(),
  segments: z.array(Segment),
  sourceEventIds: z.array(Id),
  hash: z.string(),
  status: z.enum(['draft', 'reviewed']),
  createdAt: IsoDate,
});
export type ScriptVersion = z.infer<typeof ScriptVersion>;

export const SegmentInput = Segment.omit({ id: true }).extend({ id: Id.optional() });
export const ScriptInput = z.object({
  segments: z.array(SegmentInput).min(1, 'O roteiro precisa de pelo menos um trecho'),
  status: z.enum(['draft', 'reviewed']).default('draft'),
});
export type ScriptInput = z.infer<typeof ScriptInput>;

// ---------- Timeline (spec §9) ----------
export const Crop = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
}).refine((c) => c.x + c.width <= 1 + 1e-9 && c.y + c.height <= 1 + 1e-9, {
  message: 'O recorte precisa permanecer dentro do quadro',
});
export type Crop = z.infer<typeof Crop>;

export const Clip = z.object({
  id: Id,
  segmentId: Id,
  sourceRef: SourceRef,
  timelineStartMs: Ms,
  durationMs: Ms,
  crop: Crop,
  playbackRate: z.number().min(0.25).max(4),
});
export type Clip = z.infer<typeof Clip>;

export const AudioTrack = z.object({
  id: Id,
  kind: z.enum(['narration']),
  segmentId: Id,
  assetId: Id,
  timelineStartMs: Ms,
  durationMs: Ms,
});
export type AudioTrack = z.infer<typeof AudioTrack>;

export const Caption = z.object({
  id: Id,
  startMs: Ms,
  endMs: Ms,
  text: z.string().min(1).max(200),
}).refine(intervalOk, { message: 'Legenda com fim <= início' });
export type Caption = z.infer<typeof Caption>;

export const MixSettings = z.object({
  gameVolume: z.number().min(0).max(2).default(1),
  duckedGameVolume: z.number().min(0).max(2).default(0.25),
  narrationVolume: z.number().min(0).max(4).default(1),
  targetLufs: z.number().min(-40).max(-5).default(-14),
  truePeakDb: z.number().min(-9).max(0).default(-1),
});
export type MixSettings = z.infer<typeof MixSettings>;

export const TimelineVersion = z.object({
  id: Id,
  projectId: Id,
  version: z.number().int().positive(),
  scriptVersionId: Id,
  format: FormatId,
  clips: z.array(Clip),
  audioTracks: z.array(AudioTrack),
  captions: z.array(Caption),
  captionsOrigin: z.enum(['estimated_from_script', 'edited']),
  mix: MixSettings,
  hash: z.string(),
  stale: z.boolean(),
  createdAt: IsoDate,
});
export type TimelineVersion = z.infer<typeof TimelineVersion>;

export const CreateTimelineInput = z.object({
  scriptVersionId: Id,
  format: FormatId,
  // segmentId -> assetId do áudio de narração importado (RF-008, voz importada no M1).
  narration: z.record(z.string(), Id).default({}),
  // segmentId -> recorte (opcional; padrão centralizado sem esticar).
  crops: z.record(z.string(), Crop).default({}),
  mix: MixSettings.default(MixSettings.parse({})),
});
export type CreateTimelineInput = z.infer<typeof CreateTimelineInput>;

export const TimelineRevisionInput = z.object({
  crops: z.record(z.string(), Crop).optional(),
  captions: z.array(z.object({ startMs: Ms, endMs: Ms, text: z.string().trim().min(1).max(200) })
    .refine(intervalOk, { message: 'Legenda com fim <= início' })).optional(),
  mix: MixSettings.optional(),
});
export type TimelineRevisionInput = z.infer<typeof TimelineRevisionInput>;

// ---------- Render / Approval / Export ----------
export const RenderStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const RenderProfile = z.enum(['preview', 'final']);
export const Render = z.object({
  id: Id,
  timelineVersionId: Id,
  profile: RenderProfile,
  status: RenderStatus,
  jobId: Id.nullable(),
  outputKey: z.string().nullable(),
  srtKey: z.string().nullable(),
  sha256: z.string().nullable(),
  durationMs: Ms.nullable(),
  diagnostics: z.record(z.string(), z.unknown()),
  createdAt: IsoDate,
});
export type Render = z.infer<typeof Render>;

export const CreateRenderInput = z.object({ profile: RenderProfile.default('preview') });

export const VideoMetadata = z.object({
  title: z.string().trim().min(1, 'Informe um título').max(100),
  description: z.string().max(5000).default(''),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  channel: z.string().max(200).nullable().default(null),
});
export type VideoMetadata = z.infer<typeof VideoMetadata>;

export const Approval = z.object({
  id: Id,
  projectId: Id,
  renderId: Id,
  packageHash: z.string(),
  manifest: z.record(z.string(), z.unknown()),
  approvedBy: z.string(),
  approvedAt: IsoDate,
  invalidatedAt: IsoDate.nullable(),
  invalidationReason: z.string().nullable(),
  createdAt: IsoDate,
});
export type Approval = z.infer<typeof Approval>;

export const CreateApprovalInput = z.object({
  renderId: Id,
  metadata: VideoMetadata,
  thumbnailAssetId: Id.nullable().default(null),
  checklistConfirmed: z.literal(true, { error: 'Confirme o checklist antes de aprovar' }),
});
export type CreateApprovalInput = z.infer<typeof CreateApprovalInput>;

export const CreateExportInput = z.object({ approvalId: Id });

// ---------- Job ----------
export const Job = z.object({
  id: Id,
  projectId: Id,
  type: JobType,
  inputHash: z.string(),
  idempotencyKey: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  status: JobStatus,
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  progress: z.number().min(0).max(1).nullable(),
  stage: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  heartbeatAt: IsoDate.nullable(),
  leaseUntil: IsoDate.nullable(),
  runAfter: IsoDate,
  cancelRequested: z.boolean(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Job = z.infer<typeof Job>;

// ---------- Erros padronizados (spec §11) ----------
export const ApiError = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/** Formata erros do Zod em lista legível (pt-BR) para `details`. */
export function formatIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export { z };

// ---------- Voz (RF-008) ----------
export const VoiceRequest = z.object({
  provider: z.literal('macos-say').default('macos-say'),
  voice: z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} ()._-]+$/u, 'Nome de voz inválido'),
  // Palavras por minuto (o padrão do macOS é ~175).
  rate: z.number().int().min(90).max(300).default(175),
  segmentIds: z.array(Id).optional(),
});
export type VoiceRequest = z.infer<typeof VoiceRequest>;
