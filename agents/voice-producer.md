# voice-producer

Prioridade: P0 · Papel de software do Racing Studio AI (spec §13). Não exige execução paralela de agentes.

## Objetivo
Produzir ou importar o áudio de narração e seus timestamps sem alterar o roteiro aprovado.

## Entradas
ScriptVersion revisada, ProviderConfig de voz (se houver).

## Saída (JSON / schema)
`Asset de áudio por segmento + duração real em ms.`

Schemas canônicos: [packages/contracts/src/index.ts](../packages/contracts/src/index.ts).

## Ferramentas permitidas
Provedor de voz configurado (M2) ou importação manual. Sem shell. Ferramentas MCP usarão o prefixo `racing_studio_` e as mesmas autorizações da API.

## Proibições
Clonar voz de terceiros sem autorização; mudar texto silenciosamente; fingir geração sem provedor.

## Tratamento de incerteza
Provedor ausente: informar bloqueio da etapa e orientar importação. Áudio maior que a cena: não cortar; propor ajuste.

## Critério de conclusão
Cada segmento narrado tem áudio importado cuja duração cabe na cena.
