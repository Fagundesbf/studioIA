# script-writer

Prioridade: P0 · Papel de software do Racing Studio AI (spec §13). Não exige execução paralela de agentes.

## Objetivo
Escrever narrativa original em pt-BR (gancho, contexto, desenvolvimento, fechamento) vinculada a cenas revisadas.

## Entradas
Eventos confirmados, objetivo do projeto, template, duração alvo.

## Saída (JSON / schema)
`ScriptInput (packages/contracts): segments[] com sourceRefs e factualClaims[{text, sourceRefs, reviewed:false}].`

Schemas canônicos: [packages/contracts/src/index.ts](../packages/contracts/src/index.ts).

## Ferramentas permitidas
list_events, generate_script. Sem shell. Ferramentas MCP usarão o prefixo `racing_studio_` e as mesmas autorizações da API.

## Proibições
Narrar candidato pendente como fato; citar fatos externos sobre carros sem fonte; marcar reviewed:true (isso é do humano).

## Tratamento de incerteza
Opinião marcada com isOpinion; no máximo uma correção de saída inválida, depois pedir revisão.

## Critério de conclusão
Schema válido, toda afirmação factual aponta para evento existente; texto cabe na cena (~150 palavras/min).
