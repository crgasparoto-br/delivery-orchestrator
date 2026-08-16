# Gate de liveness de referencias

## Aplicabilidade

Ativar quando uma etapa persistir IDs, referencias, snapshots ou vinculos que serao usados posteriormente em `approve`, `release`, `execute`, `publish`, `send`, `settle`, `confirm` ou operacao definitiva equivalente.

Sinais contratuais: `continua valido`, `continua acessivel`, `revalidar`, `no momento de`, `apos aprovacao`, `antes de liberar`, `referencias obrigatorias`, `origem ainda existente`.

## Invariante

Validade em T1 nao autoriza uso em T3. A operacao definitiva deve revalidar, dentro da fronteira transacional apropriada, todas as referencias cuja existencia, elegibilidade, tenant, estado ou versao possam mudar entre preparacao/aprovacao e execucao.

## Controles minimos

### `REF-LIVE-001` — referencia removida

Criar referencia valida em T1, persistir/aprovar o agregado, remover ou tornar a referencia inacessivel em T2 e executar a operacao definitiva em T3. Esperado: falha fail-closed e nenhum efeito parcial.

### `REF-LIVE-002` — referencia muda de elegibilidade/estado

Manter o mesmo ID, alterar estado/versao/tenant/eligibilidade entre T1 e T3. Esperado: a revalidacao usa o estado atual e bloqueia uso stale.

### `REF-LIVE-003` — caso irmao de outra familia de fonte

Repetir o ataque em uma segunda fonte canonicamente distinta, por exemplo dado clinico versus avaliacao, entitlement versus recurso, mapping versus item operacional.

## Evidencia

Registrar estado persistido antes/depois, ID deliberadamente estavel, mudanca em T2, erro publico/interno esperado e ausencia de efeitos. Teste que apenas valida a referencia durante criacao nao comprova este gate.

## Portao

Ausencia de pelo menos `REF-LIVE-001` e um caso irmao aplicavel impede `INTERNALLY_APPROVED` quando a familia `reference-liveness` estiver ativa.
