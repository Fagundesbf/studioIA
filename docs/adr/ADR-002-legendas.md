# ADR-002 — Legendas como faixa embutida + SRT

- Status: aceito (2026-10-25)
- Spec: RF-009 ("exportar SRT e versão embutida opcional"), §15.

## Contexto
O FFmpeg instalado pelo Homebrew (9.0.2) não tem `libass`, então o filtro `subtitles` (gravar texto na imagem) não existe. Não há transcrição (Whisper) no M1.

## Decisão
1. As legendas são **estimadas** a partir do texto de cada trecho, distribuídas pela **duração real** do áudio importado, no máximo 2 linhas de 42 caracteres. A UI deixa claro que são estimativas e permite corrigir.
2. O MP4 recebe uma **faixa de legenda embutida** (`mov_text`, idioma `por`) e o pacote inclui `legendas.srt`. O preview no navegador usa WebVTT.
3. A capacidade `burnInCaptions` é detectada e exibida em Configurações. O código para gravar na imagem existe em `buildRenderArgs`, mas fica desligado no M1.

## Consequências
- Funciona em qualquer FFmpeg. O YouTube aceita o SRT diretamente.
- Gravar a legenda na imagem e alinhar por transcrição ficam para o M2/M3.
