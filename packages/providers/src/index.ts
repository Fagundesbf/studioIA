// Adaptadores de provedores externos/locais (spec §7: portas e adaptadores).
// Voz: sintetizador do macOS (`say`) — local, offline, sem custo. Outros provedores entram atrás da mesma interface.
import fs from 'node:fs/promises';
import os from 'node:os';
import { run } from '@rs/video-engine';
import { DomainError } from '@rs/domain';

export interface VoiceInfo { id: string; name: string; locale: string }

export interface VoiceProvider {
  readonly id: string;
  readonly label: string;
  /** Custo conhecido por execução (null = desconhecido). */
  readonly costPerJob: number | null;
  available(): Promise<boolean>;
  listVoices(): Promise<VoiceInfo[]>;
  /** Gera um arquivo de áudio em `outPath` (formato nativo do provedor). */
  synthesize(args: { text: string; voice: string; rate: number; outPath: string; textFile: string; signal?: AbortSignal }): Promise<void>;
}

export class MacSayVoiceProvider implements VoiceProvider {
  readonly id = 'macos-say';
  readonly label = 'Voz do macOS (local, gratuita)';
  readonly costPerJob = 0;

  async available() {
    if (os.platform() !== 'darwin') return false;
    try { return (await run('say', ['-v', '?'], { timeoutMs: 10_000 })).code === 0; } catch { return false; }
  }

  async listVoices(): Promise<VoiceInfo[]> {
    if (!(await this.available())) return [];
    const r = await run('say', ['-v', '?'], { timeoutMs: 10_000 });
    return r.stdout.split('\n').map((line) => {
      const m = /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/.exec(line);
      if (!m) return null;
      const id = m[1]!.trim();
      return { id, name: id.replace(/\s*\(.*\)$/, ''), locale: m[2]! };
    }).filter((v): v is VoiceInfo => !!v && v.locale === 'pt_BR');
  }

  async synthesize({ text, voice, rate, outPath, textFile, signal }: Parameters<VoiceProvider['synthesize']>[0]) {
    const voices = await this.listVoices();
    if (!voices.some((v) => v.id === voice)) throw new DomainError('VOICE_NOT_FOUND', `Voz "${voice}" não está instalada neste Mac`, 422);
    // Texto vai por arquivo (-f), nunca como argumento: evita que um texto iniciado por "-" vire opção.
    await fs.writeFile(textFile, text, 'utf8');
    const r = await run('say', ['-v', voice, '-r', String(rate), '-f', textFile, '-o', outPath, '--file-format=AIFF'], { signal, timeoutMs: 120_000 });
    if (r.code !== 0) throw new DomainError('VOICE_FAILED', 'O sintetizador de voz do macOS falhou', 422, { stderr: r.stderr.slice(-1000) });
  }
}

export const VOICE_PROVIDERS: Record<string, VoiceProvider> = { 'macos-say': new MacSayVoiceProvider() };
