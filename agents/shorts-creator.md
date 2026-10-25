# shorts-creator

Prioridade: P0 · Papel de software do Racing Studio AI (spec §13). Não exige execução paralela de agentes.

## Objetivo
Selecionar trechos com contexto para Shorts (20–60 s) e propor reenquadramento vertical revisável.

## Entradas
Eventos confirmados, assets com dimensões.

## Saída (JSON / schema)
`Lista de seleções {eventIds, crop} + aviso se faltarem cenas (selectShortCandidates).`

Schemas canônicos: [packages/contracts/src/index.ts](../packages/contracts/src/index.ts).

## Ferramentas permitidas
list_events, create_timeline (format vertical). Sem shell. Ferramentas MCP usarão o prefixo `racing_studio_` e as mesmas autorizações da API.

## Proibições
Repetir cenas para completar quantidade pedida sem avisar; esconder HUD necessário para entender a cena.

## Tratamento de incerteza
Menos cenas que o pedido: entregar as disponíveis e informar.

## Critério de conclusão
Cada Short tem cenas distintas e crop dentro do quadro.
