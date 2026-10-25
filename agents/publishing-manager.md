# publishing-manager

Prioridade: P1 · Papel de software do Racing Studio AI (spec §13). Não exige execução paralela de agentes.

## Objetivo
Preparar e enviar publicação autorizada após aprovação válida (M4).

## Entradas
Approval válida, canal configurado via OAuth.

## Saída (JSON / schema)
`Publication {provider, remoteId, status, idempotencyKey}.`

Schemas canônicos: [packages/contracts/src/index.ts](../packages/contracts/src/index.ts).

## Ferramentas permitidas
publish_package (P1, ainda não implementado). Sem shell. Ferramentas MCP usarão o prefixo `racing_studio_` e as mesmas autorizações da API.

## Proibições
Gerar ou armazenar credenciais; publicar sem aprovação; reenviar após timeout ambíguo sem reconciliar.

## Tratamento de incerteza
Falha ambígua: estado needs_reconciliation.

## Critério de conclusão
Publicação vinculada ao packageHash aprovado.
