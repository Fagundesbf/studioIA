// Motor de mídia determinístico (spec §7, §15, §16).
// FFmpeg/ffprobe são executados por spawn com argumentos separados — nunca por shell,
// e nunca com parâmetros gerados livremente por LLM.
import { spawn } from 'node:child_process';
import type { Caption, Clip, AudioTrack, FormatId, MixSettings } from '@rs/contracts';
import { DomainError, FORMATS } from '@rs/domain';

export interface Bins { ffmpeg: string; ffprobe: string }

export class MediaError extends DomainError {
  constructor(code: string, message: string, details?: unknown, public readonly transient = false) {
    super(code, message, 422, details);
  }
}

// ---------- Processo ----------
export function run(bin: string, args: string[], opts: { signal?: AbortSignal; onStdout?: (s: string) => void; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal, timeout: opts.timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { const s = d.toString(); stdout += s; opts.onStdout?.(s); if (stdout.length > 4_000_000) stdout = stdout.slice(-1_000_000); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.name === 'AbortError') reject(new MediaError('CANCELLED', 'Processo cancelado'));
      else if (err.code === 'ENOENT') reject(new MediaError('FFMPEG_NOT_FOUND', `Executável não encontrado: ${bin}. Instale o FFmpeg (veja docs/GUIA_PASSO_A_PASSO.md).`));
      else reject(err);
    });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

// ---------- Capacidades (M0) ----------
export interface MediaCapabilities {
  ffmpeg: { available: boolean; version: string | null; path: string };
  ffprobe: { available: boolean; version: string | null; path: string };
  encoders: { libx264: boolean; h264_videotoolbox: boolean; h264_nvenc: boolean; aac: boolean };
  filters: { subtitles: boolean; drawtext: boolean; loudnorm: boolean; ebur128: boolean };
  burnInCaptions: boolean;
}

export async function detectCapabilities(bins: Bins): Promise<MediaCapabilities> {
  const version = async (bin: string) => {
    try { const r = await run(bin, ['-version'], { timeoutMs: 10_000 }); return r.code === 0 ? (r.stdout.split('\n')[0] ?? '').trim() : null; } catch { return null; }
  };
  const [fv, pv] = await Promise.all([version(bins.ffmpeg), version(bins.ffprobe)]);
  let enc = '', fil = '';
  if (fv) {
    enc = (await run(bins.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 })).stdout;
    fil = (await run(bins.ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 10_000 })).stdout;
  }
  const has = (txt: string, name: string) => new RegExp(`\\s${name}\\s`).test(txt);
  const filters = { subtitles: has(fil, 'subtitles'), drawtext: has(fil, 'drawtext'), loudnorm: has(fil, 'loudnorm'), ebur128: has(fil, 'ebur128') };
  return {
    ffmpeg: { available: !!fv, version: fv, path: bins.ffmpeg },
    ffprobe: { available: !!pv, version: pv, path: bins.ffprobe },
    encoders: { libx264: has(enc, 'libx264'), h264_videotoolbox: has(enc, 'h264_videotoolbox'), h264_nvenc: has(enc, 'h264_nvenc'), aac: has(enc, 'aac') },
    filters,
    burnInCaptions: filters.subtitles,
  };
}

// ---------- Inspeção (RF-001) ----------
export interface ProbeResult {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  formatName: string;
}

interface FfStream { codec_type: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string; pix_fmt?: string; nb_frames?: string; disposition?: { attached_pic?: number } }

function parseRate(r?: string): number | null {
  if (!r) return null;
  const [a, b] = r.split('/').map(Number);
  if (!a || !b) return null;
  return Math.round((a / b) * 1000) / 1000;
}

export async function probe(bins: Bins, file: string): Promise<ProbeResult & { raw: { streams: FfStream[]; format: Record<string, string> } }> {
  const r = await run(bins.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 });
  if (r.code !== 0) {
    throw new MediaError('MEDIA_UNREADABLE', 'Arquivo não pôde ser lido como mídia (corrompido ou formato não suportado pela sua instalação do FFmpeg).', { stderr: r.stderr.slice(0, 2000) });
  }
  const json = JSON.parse(r.stdout || '{}') as { streams?: FfStream[]; format?: Record<string, string> };
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const dur = Number(json.format?.duration ?? v?.duration ?? a?.duration);
  return {
    durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: parseRate(v?.avg_frame_rate) ?? parseRate(v?.r_frame_rate),
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    hasVideo: !!v,
    hasAudio: !!a,
    formatName: json.format?.format_name ?? '',
    raw: { streams, format: json.format ?? {} },
  };
}

/** Decodifica um trecho para garantir que o arquivo é realmente utilizável (não basta o cabeçalho). */
export async function assertDecodable(bins: Bins, file: string, opts: { full?: boolean; signal?: AbortSignal } = {}) {
  const args = ['-v', 'error', ...(opts.full ? [] : ['-t', '5']), '-i', file, '-f', 'null', '-'];
  const r = await run(bins.ffmpeg, args, { signal: opts.signal });
  if (r.code !== 0 || r.stderr.trim()) {
    throw new MediaError('DECODE_FAILED', 'Falha ao decodificar a mídia.', { stderr: r.stderr.slice(0, 2000) });
  }
}

// ---------- Progresso ----------
function progressParser(totalMs: number, onProgress?: (p: number) => void) {
  return (chunk: string) => {
    const m = [...chunk.matchAll(/out_time_us=(\d+)/g)].pop();
    if (m && onProgress && totalMs > 0) onProgress(Math.min(0.99, Number(m[1]) / 1000 / totalMs));
  };
}

// ---------- Proxy e miniatura (RF-003) ----------
export async function makeProxy(bins: Bins, src: string, dst: string, durationMs: number, opts: { signal?: AbortSignal; onProgress?: (p: number) => void } = {}) {
  const r = await run(bins.ffmpeg, [
    '-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'scale=-2:540:flags=bicubic,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', dst,
  ], { signal: opts.signal, onStdout: progressParser(durationMs, opts.onProgress) });
  if (r.code !== 0) throw new MediaError('PROXY_FAILED', 'Falha ao gerar proxy.', { stderr: r.stderr.slice(-2000) });
}

export async function makeThumbnail(bins: Bins, src: string, dst: string, atMs: number, opts: { signal?: AbortSignal } = {}) {
  const r = await run(bins.ffmpeg, ['-y', '-v', 'error', '-ss', (atMs / 1000).toFixed(3), '-i', src, '-frames:v', '1', '-vf', 'scale=-2:360', '-f', 'image2', dst], { signal: opts.signal });
  if (r.code !== 0) throw new MediaError('THUMBNAIL_FAILED', 'Falha ao gerar miniatura.', { stderr: r.stderr.slice(-2000) });
}

// ---------- Render (RF-010, RF-011, §15) ----------
export interface RenderInputs {
  format: FormatId;
  profile: 'preview' | 'final';
  clips: Clip[];
  audioTracks: AudioTrack[];
  captions: Caption[];
  mix: MixSettings;
  /** assetId -> { caminho absoluto, dimensões, possui áudio } */
  sources: Map<string, { path: string; width: number; height: number; hasAudio: boolean }>;
  srtPath: string | null;
  burnCaptions: boolean;
  output: string;
  signal?: AbortSignal;
  onProgress?: (p: number) => void;
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const sec = (ms: number) => (ms / 1000).toFixed(3);

/** Escapa caminho para o filtro `subtitles` (sintaxe de filtergraph, não shell). */
function escapeFilterPath(p: string) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export function buildRenderArgs(inp: RenderInputs): { args: string[]; totalMs: number; outW: number; outH: number } {
  const base = FORMATS[inp.format];
  const scale = inp.profile === 'preview' ? 0.5 : 1;
  const outW = even(base.width * scale), outH = even(base.height * scale);
  const fps = base.fps;

  const args: string[] = ['-y', '-v', 'error'];
  const inputIndex = new Map<string, number>();
  let n = 0;
  const addInput = (key: string, file: string) => {
    if (!inputIndex.has(key)) { args.push('-i', file); inputIndex.set(key, n++); }
    return inputIndex.get(key)!;
  };

  const filters: string[] = [];
  const concatIn: string[] = [];
  let totalMs = 0;

  inp.clips.forEach((clip, k) => {
    const src = inp.sources.get(clip.sourceRef.assetId);
    if (!src) throw new MediaError('UNKNOWN_ASSET', `Fonte ausente para o clip ${k + 1}`);
    const idx = addInput(`v:${clip.sourceRef.assetId}`, src.path);
    const cw = even(clip.crop.width * src.width), ch = even(clip.crop.height * src.height);
    const cx = Math.min(Math.floor(clip.crop.x * src.width), src.width - cw), cy = Math.min(Math.floor(clip.crop.y * src.height), src.height - ch);
    const s = sec(clip.sourceRef.startMs), e = sec(clip.sourceRef.endMs);
    filters.push(
      `[${idx}:v:0]trim=start=${s}:end=${e},setpts=(PTS-STARTPTS)/${clip.playbackRate},crop=${cw}:${ch}:${cx}:${cy},` +
      `scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1,fps=${fps},format=yuv420p[v${k}]`,
    );
    const d = sec(clip.durationMs);
    if (src.hasAudio) {
      filters.push(`[${idx}:a:0]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${d}[a${k}]`);
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${d},aformat=sample_fmts=fltp:channel_layouts=stereo[a${k}]`);
    }
    concatIn.push(`[v${k}][a${k}]`);
    totalMs += clip.durationMs;
  });

  filters.push(`${concatIn.join('')}concat=n=${inp.clips.length}:v=1:a=1[vcat][gcat]`);

  // Vídeo final (com legenda gravada na imagem somente se o FFmpeg suportar e for solicitado).
  if (inp.burnCaptions && inp.srtPath) {
    filters.push(`[vcat]subtitles='${escapeFilterPath(inp.srtPath)}':force_style='FontSize=${inp.format === 'vertical' ? 14 : 20},MarginV=${inp.format === 'vertical' ? 120 : 40}'[vout]`);
  } else {
    filters.push('[vcat]null[vout]');
  }

  // Áudio: jogo com ducking durante narração (§15) + narrações posicionadas + normalização.
  const duckRatio = inp.mix.gameVolume > 0 ? inp.mix.duckedGameVolume / inp.mix.gameVolume : 0;
  const windows = inp.audioTracks.map((t) => `between(t,${sec(t.timelineStartMs)},${sec(t.timelineStartMs + t.durationMs)})`);
  let gameChain = `[gcat]volume=${inp.mix.gameVolume}`;
  if (windows.length) gameChain += `,volume=enable='${windows.join('+')}':volume=${duckRatio.toFixed(4)}`;
  filters.push(`${gameChain}[game]`);

  const mixIn = ['[game]'];
  inp.audioTracks.forEach((t, j) => {
    const src = inp.sources.get(t.assetId);
    if (!src) throw new MediaError('UNKNOWN_ASSET', `Áudio de narração ausente (trecho ${j + 1})`);
    const idx = addInput(`a:${t.assetId}`, src.path);
    filters.push(`[${idx}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${inp.mix.narrationVolume},adelay=${t.timelineStartMs}|${t.timelineStartMs}[n${j}]`);
    mixIn.push(`[n${j}]`);
  });
  filters.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:duration=first:normalize=0,` +
    `loudnorm=I=${inp.mix.targetLufs}:TP=${inp.mix.truePeakDb}:LRA=11,aresample=48000,atrim=duration=${sec(totalMs)}[aout]`);

  const softSubs = !inp.burnCaptions && inp.srtPath && inp.captions.length > 0;
  const srtIdx = softSubs ? addInput('srt', inp.srtPath!) : -1;

  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]');
  if (softSubs) args.push('-map', `${srtIdx}:s:0`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=por');
  args.push(
    '-c:v', 'libx264', '-preset', inp.profile === 'preview' ? 'veryfast' : 'medium', '-crf', inp.profile === 'preview' ? '26' : '20',
    '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', inp.profile === 'preview' ? '128k' : '192k', '-ar', '48000',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', inp.output,
  );
  return { args, totalMs, outW, outH };
}

export async function renderTimeline(bins: Bins, inp: RenderInputs) {
  const built = buildRenderArgs(inp);
  const r = await run(bins.ffmpeg, built.args, { signal: inp.signal, onStdout: progressParser(built.totalMs, inp.onProgress) });
  if (r.code !== 0) throw new MediaError('RENDER_FAILED', 'Falha no render do FFmpeg.', { stderr: r.stderr.slice(-3000) });
  return built;
}

// ---------- Loudness e validação (§15) ----------
export async function measureLoudness(bins: Bins, file: string, signal?: AbortSignal): Promise<{ integratedLufs: number | null; truePeakDb: number | null }> {
  const r = await run(bins.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { signal });
  const tail = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const i = /I:\s+(-?[\d.]+) LUFS/.exec(tail);
  const p = /Peak:\s+(-?[\d.]+) dBFS/.exec(tail);
  return { integratedLufs: i ? Number(i[1]) : null, truePeakDb: p ? Number(p[1]) : null };
}

export interface OutputCheck {
  ok: boolean;
  problems: string[];
  durationMs: number | null;
  videoDurationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  pixFmt: string | null;
  audioCodec: string | null;
  subtitleStreams: number;
}

/** Verifica o MP4 via ffprobe + decodificação completa (§15). */
export async function validateOutput(bins: Bins, file: string, expect: { durationMs: number; width: number; height: number; fps: number; audio: boolean }, signal?: AbortSignal): Promise<OutputCheck> {
  const p = await probe(bins, file);
  const v = p.raw.streams.find((s) => s.codec_type === 'video');
  const problems: string[] = [];
  const frames = Number(v?.nb_frames);
  const videoDurationMs = Number.isFinite(frames) && frames > 0 ? Math.round((frames / expect.fps) * 1000) : (v?.duration ? Math.round(Number(v.duration) * 1000) : null);
  const tol = 1000 / expect.fps + 1;
  if (videoDurationMs == null || Math.abs(videoDurationMs - expect.durationMs) > tol) problems.push(`Duração do vídeo ${videoDurationMs} ms difere do esperado ${expect.durationMs} ms (tolerância ${tol.toFixed(1)} ms)`);
  if (p.videoCodec !== 'h264') problems.push(`Codec de vídeo ${p.videoCodec} (esperado h264)`);
  if (v?.pix_fmt !== 'yuv420p') problems.push(`Pixel format ${v?.pix_fmt} (esperado yuv420p)`);
  if (p.width !== expect.width || p.height !== expect.height) problems.push(`Resolução ${p.width}x${p.height} (esperado ${expect.width}x${expect.height})`);
  if (expect.audio && p.audioCodec !== 'aac') problems.push(`Codec de áudio ${p.audioCodec} (esperado aac)`);
  try { await assertDecodable(bins, file, { full: true, signal }); } catch (e) { problems.push(`Falha de decodificação: ${(e as Error).message}`); }
  return {
    ok: problems.length === 0, problems, durationMs: p.durationMs, videoDurationMs, width: p.width, height: p.height,
    videoCodec: p.videoCodec, pixFmt: v?.pix_fmt ?? null, audioCodec: p.audioCodec,
    subtitleStreams: p.raw.streams.filter((s) => s.codec_type === 'subtitle').length,
  };
}

// ---------- Mídia sintética para testes e demo (sem material protegido) ----------
export async function makeSyntheticVideo(bins: Bins, dst: string, opts: { seconds: number; width?: number; height?: number; withAudio?: boolean }) {
  const w = opts.width ?? 1280, h = opts.height ?? 720;
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=${opts.seconds}`];
  if (opts.withAudio !== false) args.push('-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${opts.seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (opts.withAudio !== false) args.push('-c:a', 'aac', '-shortest');
  args.push(dst);
  const r = await run(bins.ffmpeg, args);
  if (r.code !== 0) throw new MediaError('SYNTH_FAILED', 'Falha ao gerar vídeo sintético', { stderr: r.stderr });
}

export async function makeSyntheticTone(bins: Bins, dst: string, seconds: number, freq = 660) {
  const r = await run(bins.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`, '-ac', '2', dst]);
  if (r.code !== 0) throw new MediaError('SYNTH_FAILED', 'Falha ao gerar áudio sintético', { stderr: r.stderr });
}
