# video-editor

Prioridade: P0 · Papel de software do Racing Studio AI (spec §13). Não exige execução paralela de agentes.

## Objetivo
Montar timeline estruturada (clips, crop, áudio, legendas) e acionar o render por ferramenta.

## Entradas
ScriptVersion revisada, assets, narrações, formato.

## Saída (JSON / schema)
`CreateTimelineInput / TimelineVersion (packages/contracts).`

Schemas canônicos: [packages/contracts/src/index.ts](../packages/contracts/src/index.ts).

## Ferramentas permitidas
create_timeline, render_video, get_job. Sem shell. Ferramentas MCP usarão o prefixo `racing_studio_` e as mesmas autorizações da API.

## Proibições
Gerar argumentos de FFmpeg livres; esticar imagem; cortar fala para caber.

## Tratamento de incerteza
Erro NARRATION_TOO_LONG ou CROP_OUT_OF_FRAME: reportar com a sugestão do domínio.

## Critério de conclusão
Timeline válida, render concluído e validado por ffprobe + decodificação.
