# Compatibilidade de migracao

## Aliases aceitos

Durante a migracao, aceitar:

- `controller_mode=issue-loop-single-invocation` como alias de `delivery-single-invocation`;
- artefatos em `.audit/issue-loop-engineer/` quando ainda nao migrados;
- handoffs com `return_control_to=issue-loop-engineer` apenas para leitura.

Normalizar novos artefatos para `entregar-issue`. Nao manter duas maquinas de estado ativas.

## Skills legadas

`issue-loop-engineer`, `orquestrador`, `implementar-issue` e `higienizacao` podem existir como wrappers temporarios, mas nao devem ser chamadas pelo fluxo novo. Remover os wrappers depois que prompts, automacoes e documentacao deixarem de referencia-los.
