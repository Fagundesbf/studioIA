// Voz gerada pelo sintetizador do macOS (RF-008) + ajuste de cenas à narração (AC-006).
// Só roda no macOS com voz pt-BR instalada; em outros sistemas é pulado.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, openStudio, type Studio } from '@rs/db';
import { StudioService, Worker } from '@rs/application';
import { MacSayVoiceProvider } from '@rs/providers';
import { makeSyntheticVideo } from '@rs/video-engine';
import { buildApp } from '../apps/api/src/app.ts';

const voices = await new MacSayVoiceProvider().listVoices();
const TOKEN = 'token-voz';
const auth = { authorization: `Bearer ${TOKEN}` };
let dir: string, studio: Studio, app: FastifyInstance, worker: Worker;

async function call(method: 'GET' | 'POST', url: string, body?: unknown) {
  const r = await app.inject({ method, url: `/api/v1${url}`, payload: body as object, headers: auth });
  return { status: r.statusCode, body: r.json() };
}

describe.skipIf(!voices.length)('voz gerada (macOS say)', () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-voz-'));
    studio = openStudio({ ...loadConfig({ DATA_DIR: path.join(dir, 'data'), STUDIO_TOKEN: TOKEN, MIN_FREE_DISK_MB: '1' }), user: 'tester' });
    app = await buildApp(studio);
    worker = new Worker(new StudioService(studio), { log: () => {} });
    await makeSyntheticVideo({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, path.join(dir, 'v.mp4'), { seconds: 30 });
  });
  afterAll(async () => { await app?.close(); studio?.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('gera narração, detecta que não cabe, estende a cena e renderiza', async () => {
    const caps = await call('GET', '/providers/capabilities');
    expect(caps.body.providers.voice.configured).toBe(true);
    const voice = caps.body.providers.voice.voices[0].id as string;

    const p = (await call('POST', '/projects', { title: 'Voz', gameLabel: 'Automobilista 2' })).body;
    const boundary = 'b' + Date.now();
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="rightsOwner"\r\n\r\nteste\r\n--${boundary}\r\nContent-Disposition: form-data; name="rightsUsage"\r\n\r\nproprio\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v.mp4"\r\n\r\n`),
      fs.readFileSync(path.join(dir, 'v.mp4')), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({ method: 'POST', url: `/api/v1/projects/${p.id}/assets`, payload, headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    const videoId = up.json().asset.id;
    await worker.drain();

    // Cena de 3 s com texto que leva bem mais que isso para ser falado.
    const text = 'Chegando ao S do Senna, é hora de mostrar o que esse carro sabe fazer na descida.';
    const s = await call('POST', `/projects/${p.id}/scripts`, { status: 'reviewed', segments: [{ role: 'gancho', narrationText: text, sourceRefs: [{ assetId: videoId, startMs: 2000, endMs: 5000 }], targetDurationMs: 3000, factualClaims: [] }] });
    const scriptId = s.body.script.id;
    const segId = s.body.script.segments[0].id;

    const job = await call('POST', `/scripts/${scriptId}/voice`, { voice, rate: 175 });
    expect(job.status).toBe(202);
    await worker.drain();
    expect(studio.jobs.get(job.body.job.id)!.status).toBe('succeeded');
    const nar = (await call('GET', `/scripts/${scriptId}/narration`)).body;
    expect(nar[segId].durationMs).toBeGreaterThan(3000);

    // Repetir com o mesmo texto e voz reaproveita o áudio (sem gerar de novo).
    const again = await call('POST', `/scripts/${scriptId}/voice`, { voice, rate: 175 });
    expect(again.body.job.id).toBe(job.body.job.id);

    const tooLong = await call('POST', `/projects/${p.id}/timelines`, { scriptVersionId: scriptId, format: 'horizontal', narration: { [segId]: nar[segId].assetId } });
    expect(tooLong.body.code).toBe('NARRATION_TOO_LONG');

    const fit = await call('POST', `/scripts/${scriptId}/fit-narration`, { narration: { [segId]: nar[segId].assetId } });
    expect(fit.body.changed).toBe(true);
    const newScript = fit.body.script;
    expect(newScript.segments[0].id).toBe(segId);
    expect(newScript.segments[0].narrationText).toBe(text);
    expect(newScript.segments[0].targetDurationMs).toBeGreaterThanOrEqual(nar[segId].durationMs);
    // A voz continua válida porque o texto não mudou.
    expect((await call('GET', `/scripts/${newScript.id}/narration`)).body[segId].assetId).toBe(nar[segId].assetId);

    const t = await call('POST', `/projects/${p.id}/timelines`, { scriptVersionId: newScript.id, format: 'vertical', narration: { [segId]: nar[segId].assetId } });
    expect(t.status).toBe(201);
    const r = await call('POST', `/timelines/${t.body.timeline.id}/renders`, { profile: 'preview' });
    await worker.drain();
    const render = (await call('GET', `/renders/${r.body.render.id}`)).body;
    expect(render.status).toBe('succeeded');
    expect(render.diagnostics.check.ok).toBe(true);
  });
});
