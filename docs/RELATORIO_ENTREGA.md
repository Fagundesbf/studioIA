# Relatório de entrega — M0 + M1

Data: 2026-10-25 · Spec: `RACING_STUDIO_AI.spec` v1.2.0 · Ambiente verificado: macOS 26.6 (Apple M1 Pro), Node 22.23.4, FFmpeg 9.0.2 (Homebrew).

## Comportamento disponível

Fluxo manual completo (J1) pela interface em http://127.0.0.1:4200: importar gravação → marcar cenas → roteiro versionado com fontes → importar narração → montar timeline horizontal/vertical → preview → render final validado → aprovar versão exata → exportar pacote. Revisões (J3) criam novas versões e invalidam o que depende delas.

## Comandos executados e resultados

| Comando | Resultado |
|---|---|
| `npm run setup` | `.env` criado com token aleatório; diagnóstico tudo ✔ |
| `npm run typecheck` | sem erros |
| `npm test` | **34/34 testes passaram** (19 unitários de domínio + 15 E2E com FFmpeg real), ~8 s |
| `npm run build:web` | build ok, 80,7 kB transferidos na carga inicial |
| `npm run dev` + fluxo completo via proxy da interface (curl) | vídeo sintético 1080p de 40 s → render final de 9 s validado, **-14,0 LUFS** medido, render em 2,2 s, pacote com 6 arquivos baixado (200), API direta sem token → 401 |
| Chrome headless nas telas Painel, Projeto e Configurações | renderizam com dados reais |

## Requisitos funcionais (P0)

| ID | Status | Evidência |
|---|---|---|
| RF-001 | ✅ | `StudioService.importAsset` (ffprobe + decodificação de 5 s, limites de tamanho/duração); E2E AC-001/AC-002 |
| RF-002 | ✅ | Original copiado como `originals/<sha256>.ext` em modo 0444; duplicata por hash avisada; E2E AC-001 |
| RF-003 | ✅ | Job `ingest` (proxy 540p + miniatura) no worker; progresso real via `-progress` do FFmpeg |
| RF-004 | ✅ | Marcação manual (atalhos I/O), edição, confirmar/rejeitar; `evidenceFrames` |
| RF-005 | ✅ parcial | Heurística de mudança de cena (FFmpeg `scene`) gera candidatos `heuristic`/`pending`, com aviso de que não prova evento. Sem modelo visual (M2) |
| RF-006 | ✅ | `validateScript`: sourceRefs dentro da fonte, eventos existentes; afirmações factuais exigem evento confirmado |
| RF-007 | ✅ | Editor de roteiro (texto, cena, duração, ordem, notas); versões preservadas |
| RF-008 | ✅ | Voz gerada pelo sintetizador local do macOS (`packages/providers`, job `voice`, sem custo) ou importada. Reaproveita áudio se texto/voz/velocidade não mudaram. Teste `tests/voice.test.ts`. Provedores de nuvem: não implementados |
| RF-009 | ✅ parcial | Legendas estimadas pela duração real do áudio, editáveis, SRT + faixa `mov_text`. Sem transcrição; sem gravação na imagem (ver ADR-002) |
| RF-010 | ✅ | `buildRenderArgs`: cortes, áudio do jogo, narração, ducking, loudnorm -14 LUFS/-1 dBTP, FFmpeg. Identidade visual: PENDENTE; Remotion não adotado |
| RF-011 | ✅ | Horizontal 1920x1080 e vertical 1080x1920 30 fps; crop manual com pré-visualização; nunca estica (pad) |
| RF-012 | ✅ regra | `selectShortCandidates` não repete cenas e avisa; a UI de Short usa o formato vertical. Seleção automática de vários Shorts por projeto: M3 |
| RF-013 | ✅ | Título/descrição/tags preenchidos e revisados pelo usuário; nenhum texto gerado automaticamente |
| RF-014 | ✅ | Aprovação registra usuário, data, `packageHash`, manifesto; só render final |
| RF-015 | ✅ | Pacote: `video.mp4`, `legendas.srt`, `roteiro.json`, `metadados.json`, `thumbnail.*`, `manifesto.json` |

## Critérios de aceite

| ID | Status | Teste |
|---|---|---|
| AC-001 | ✅ | E2E "AC-001" — hash, metadados, original intacto e somente leitura |
| AC-002 | ✅ | E2E "AC-002" — corrompido (MEDIA_UNREADABLE), extensão inválida, traversal, tmp limpo |
| AC-003 | ✅ | E2E "AC-003" — projeto concluído só com marcação manual |
| AC-004 | ✅ | Unitário + E2E — pendente não pode ser marcado como revisado |
| AC-005 | ✅ | Unitário + E2E — SOURCE_OUT_OF_RANGE, UNKNOWN_ASSET, UNKNOWN_EVENT |
| AC-006 | ✅ | Unitário + E2E — NARRATION_TOO_LONG com segundos faltantes e sugestão; nada cortado |
| AC-007 | ✅ | E2E — vertical 540x960 (preview) e horizontal 1920x1080 (final), h264/aac, decodificação completa |
| AC-008 | ✅ | E2E — novo roteiro invalida aprovação; exportar/publicar/renderizar bloqueados |
| AC-009 | ✅ | E2E — lease vencido, retomada na 2ª tentativa, 1 render e 1 arquivo |
| AC-011 | ✅ P0 | Unitário + E2E — sem aprovação, invalidada ou divergente → bloqueio no domínio (API e futuro MCP usam o mesmo caso de uso) |
| AC-012 | ✅ P0 (jobs) | E2E — mesma Idempotency-Key → mesmo render/job. Upload remoto: P1 |
| AC-013 | ✅ | E2E — FFmpeg ausente → job `failed` com FFMPEG_NOT_FOUND, render `failed`, retry funciona |
| AC-014 | ⚠️ implementado, não verificado | Labels em todos os campos, foco visível, link "pular para o conteúdo", abas com setas, aria-live para status, estados com texto. **Não foi testado com leitor de tela nem com auditoria automática** |
| AC-015 | ✅ | E2E — manifesto com versões/fontes/direitos; token não aparece em nenhum arquivo do pacote |

## Atualização 2026-10-25 (após uso real)

- Etapa 1: envio começa ao escolher o arquivo; campo dono lembrado; erros no próprio cartão (o usuário não conseguia importar).
- Etapa 2: marcar início sugere fim = início + 8 s; erro de intervalo explicado antes de enviar.
- Etapa 4: **geração de narração** com voz do macOS e botão **Estender cenas para caber a narração** (AC-006 continua: nada é cortado).
- API registra recusas (nível warn) no terminal. `npm test`: **35/35**.

## Limitações e pendências

- **IA parcial:** voz sintética local do macOS disponível; roteiro ainda escrito por você e legendas estimadas (LLM/Whisper no M2). Voz no Windows: não implementada.
- **MCP (`packages/mcp`, ferramentas `racing_studio_*`) não foi implementado.** Os casos de uso em `packages/application` estão prontos para serem expostos. Próximo passo junto com o M2.
- Legenda gravada na imagem depende de FFmpeg com libass (ADR-002).
- Banco SQLite em vez de PostgreSQL (ADR-001, aprovado). Aviso "experimental" do `node:sqlite`.
- Windows: instruções escritas, **não testado**. Hardware de referência da spec (i5-14600K/RTX 4080 SUPER) não foi o ambiente de teste.
- Sem benchmark formal. Medido apenas: render final de 9 s em 1080p em ~2,2 s com mídia sintética simples; não usar como SLA.
- Identidade visual, link do canal, Grokbot, orçamento e provedor de voz continuam PENDENTES (spec §3).
- Autenticação é um token local único (MVP de um usuário).

## Próximo marco — M2 (assistência IA)

Adaptadores de texto (ex.: Ollama local), voz e visão com stubs identificados; Whisper para alinhar legendas ao áudio; pacote MCP com as ferramentas da spec §12; custo por job e limites.
