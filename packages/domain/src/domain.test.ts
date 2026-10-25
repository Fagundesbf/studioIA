import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CreateEventInput, Crop, ScriptInput } from '@rs/contracts';
import {
  assertApprovalValid, assertClipDuration, backoffMs, buildTimeline, defaultCrop, DomainError, hashOf, packageHash,
  selectShortCandidates, splitCaptions, toSrt, validateScript, wrapCaption,
} from './index.ts';

const vid = randomUUID();
const projectId = randomUUID();
const assets = new Map([[vid, { id: vid, kind: 'video' as const, durationMs: 60_000, projectId, width: 1920, height: 1080, fps: 30 }]]);

function script(overrides: Partial<ScriptInput['segments'][number]> = {}, status: 'draft' | 'reviewed' = 'draft'): ScriptInput {
  return ScriptInput.parse({
    status,
    segments: [{ role: 'gancho', narrationText: 'Olha essa curva', sourceRefs: [{ assetId: vid, startMs: 1000, endMs: 5000 }], targetDurationMs: 4000, factualClaims: [], ...overrides }],
  });
}

const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as DomainError).code; } return 'NO_ERROR'; };

describe('AC-005 roteiro com tempo/ID inexistente', () => {
  it('rejeita tempo fora da fonte', () => {
    expect(code(() => validateScript(script({ sourceRefs: [{ assetId: vid, startMs: 0, endMs: 61_000 }] }), { assets, events: new Map(), projectId }))).toBe('SOURCE_OUT_OF_RANGE');
  });
  it('rejeita asset inexistente', () => {
    expect(code(() => validateScript(script({ sourceRefs: [{ assetId: randomUUID(), startMs: 0, endMs: 1000 }] }), { assets, events: new Map(), projectId }))).toBe('UNKNOWN_ASSET');
  });
  it('rejeita evento inexistente', () => {
    expect(code(() => validateScript(script({ sourceRefs: [{ assetId: vid, startMs: 0, endMs: 1000, eventId: randomUUID() }] }), { assets, events: new Map(), projectId }))).toBe('UNKNOWN_EVENT');
  });
  it('schema rejeita intervalo invertido', () => {
    expect(CreateEventInput.safeParse({ assetId: vid, startMs: 5000, endMs: 1000, type: 'x' }).success).toBe(false);
  });
});

describe('AC-004 candidato incerto não vira fato', () => {
  const evId = randomUUID();
  const events = new Map([[evId, { id: evId, assetId: vid, review: 'pending' as const, projectId }]]);
  const claim = { text: 'Ultrapassou o líder', reviewed: true, sourceRefs: [{ assetId: vid, startMs: 1000, endMs: 3000, eventId: evId }] };
  it('rascunho aceita, mas lista pendência', () => {
    const r = validateScript(script({ factualClaims: [claim] }), { assets, events, projectId });
    expect(r.pending.map((p) => p.code)).toContain('CLAIM_ON_PENDING_EVENT');
  });
  it('não permite marcar como revisado', () => {
    expect(code(() => validateScript(script({ factualClaims: [claim] }, 'reviewed'), { assets, events, projectId }))).toBe('SCRIPT_HAS_PENDING_CLAIMS');
  });
  it('evento confirmado libera a revisão', () => {
    const ok = new Map([[evId, { id: evId, assetId: vid, review: 'confirmed' as const, projectId }]]);
    expect(validateScript(script({ factualClaims: [claim] }, 'reviewed'), { assets, events: ok, projectId }).pending).toHaveLength(0);
  });
});

describe('AC-006 narração maior que o trecho', () => {
  it('bloqueia com ação clara e não trunca', () => {
    const { segments } = validateScript(script(), { assets, events: new Map(), projectId });
    try {
      buildTimeline({ segments, format: 'horizontal', assets, narration: { [segments[0]!.id]: { assetId: randomUUID(), durationMs: 9000, kind: 'audio' } }, crops: {} });
      expect.fail('deveria bloquear');
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe('NARRATION_TOO_LONG');
      expect((err.details as { missingMs: number }[])[0]!.missingMs).toBe(5000);
    }
  });
  it('narração que cabe gera faixa e legendas dentro do trecho', () => {
    const { segments } = validateScript(script(), { assets, events: new Map(), projectId });
    const t = buildTimeline({ segments, format: 'vertical', assets, narration: { [segments[0]!.id]: { assetId: randomUUID(), durationMs: 3000, kind: 'audio' } }, crops: {} });
    expect(t.audioTracks).toHaveLength(1);
    expect(t.captions.at(-1)!.endMs).toBeLessThanOrEqual(3000);
    expect(t.totalMs).toBe(4000);
  });
});

describe('recorte e formato (RF-011, §15)', () => {
  it('vertical a partir de 16:9 é centralizado e mantém proporção 9:16', () => {
    const c = defaultCrop('vertical', 1920, 1080);
    expect(c.height).toBe(1);
    expect((c.width * 1920) / (c.height * 1080)).toBeCloseTo(1080 / 1920, 3);
    expect(c.x + c.width).toBeLessThanOrEqual(1);
  });
  it('schema rejeita recorte fora do quadro', () => {
    expect(Crop.safeParse({ x: 0.8, y: 0, width: 0.5, height: 1 }).success).toBe(false);
  });
  it('duração do clip respeita tolerância de 1 frame', () => {
    const ref = { assetId: vid, startMs: 0, endMs: 3000 };
    expect(() => assertClipDuration({ sourceRef: ref, playbackRate: 2, durationMs: 1510 }, 30)).not.toThrow();
    expect(() => assertClipDuration({ sourceRef: ref, playbackRate: 2, durationMs: 1600 }, 30)).toThrow();
  });
});

describe('legendas (RF-009)', () => {
  it('máximo de 2 linhas por legenda e SRT válido', () => {
    const caps = splitCaptions('palavra '.repeat(40), 0, 10_000);
    expect(caps.every((c) => c.text.split('\n').length <= 2)).toBe(true);
    expect(toSrt(caps)).toMatch(/^1\n00:00:00,000 --> /);
  });
  it('quebra respeita o limite de caracteres e acentos', () => {
    expect(wrapCaption('Ultrapassagem incrível na última curva de Interlagos, ação!').every((l) => l.length <= 42)).toBe(true);
  });
});

describe('Shorts (RF-012)', () => {
  it('não repete cenas para completar a quantidade', () => {
    const r = selectShortCandidates([{ review: 'confirmed', startMs: 0, endMs: 20_000 }, { review: 'pending', startMs: 0, endMs: 10_000 }], 3);
    expect(r.selected).toHaveLength(1);
    expect(r.warning).toMatch(/Nenhuma cena foi repetida/);
  });
});

describe('AC-011 aprovação por versão exata', () => {
  const parts = { renderId: 'r', renderSha256: 'a', srtSha256: 'b', metadata: { title: 'x' }, thumbnailSha256: null, channel: null, scriptVersionId: 's', scriptHash: 'h', timelineHash: 't' };
  it('metadado diferente muda o hash do pacote', () => {
    expect(packageHash(parts)).not.toBe(packageHash({ ...parts, metadata: { title: 'y' } }));
  });
  it('bloqueia sem aprovação, invalidada ou divergente', () => {
    const h = packageHash(parts);
    expect(code(() => assertApprovalValid(undefined, h))).toBe('APPROVAL_REQUIRED');
    expect(code(() => assertApprovalValid({ invalidatedAt: '2026-01-01T00:00:00Z', packageHash: h }, h))).toBe('APPROVAL_INVALIDATED');
    expect(code(() => assertApprovalValid({ invalidatedAt: null, packageHash: h }, 'outro'))).toBe('APPROVAL_VERSION_MISMATCH');
    expect(code(() => assertApprovalValid({ invalidatedAt: null, packageHash: h }, h))).toBe('NO_ERROR');
  });
  it('hash canônico independe da ordem das chaves', () => {
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
  });
});

describe('retry', () => {
  it('backoff exponencial com jitter limitado', () => {
    expect(backoffMs(1, 1000, () => 0)).toBe(500);
    expect(backoffMs(3, 1000, () => 1)).toBe(4000);
  });
});
