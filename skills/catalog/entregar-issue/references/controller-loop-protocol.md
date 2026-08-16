# Protocolo do loop

## Unidade de ciclo

Um ciclo completo contem contrato vigente, implementacao ou correcao, validacoes internas, freeze, auditoria e decisao persistida. Nova implementacao seguida de nova auditoria consome ciclo. Analise de causa sem mudanca e sem novo freeze nao consome ciclo.

## Estados

- `preflight`
- `implementing`
- `internally-verified`
- `frozen`
- `auditing`
- `root-cause-analysis`
- `systemic-remediation`
- `remediating`
- `approved-without-reservations`
- `limit-reached`
- `blocked`

`internally-approved-awaiting-independent-audit` e terminal apenas para a invocacao atual e nao libera a entrega. Nao representa espera operacional nem aprovacao final.

## Contagem

- Iniciar em `cycle=1`.
- Incrementar depois de auditoria que exija nova implementacao.
- Nunca iniciar `cycle=11`.
- No ciclo 10, executar implementacao e auditoria completas; sem aprovacao valida, terminar em `limit-reached`.

## Identidade

Manter tres snapshots completos:

- `frozen_identity`: candidato congelado;
- `audit.identity`: objeto realmente auditado;
- `current_identity`: estado reconsultado no fim.

Qualquer divergencia gera `IDENTITY_INVALIDATED`.

## Baseline e regressao

Antes da primeira edicao, registrar comandos oficiais, falhas preexistentes, comportamentos criticos, contratos publicos, schemas, rotas e evidencias protetoras. Representar cada regressao como item com status e evidencia. Booleano agregado nao substitui o ledger.

## Estagnacao

Usar `fingerprint` estavel. Contar ocorrencias do mesmo achado:

1. primeira: `REMEDIATE`;
2. segunda: `ROOT_CAUSE_ANALYSIS`;
3. terceira ou posterior: `SYSTEMIC_REMEDIATION`.

Registrar hipotese nova, input alterado e evidencia esperada antes de repetir uma acao.

## Recomendacoes opcionais

Registrar separadamente por `disposition=recommendation`. Nao bloquear aprovacao quando nao houver vinculo necessario com requisito, regressao, seguranca, documentacao obrigatoria ou gate aplicavel.

## Idempotencia

Antes de repetir etapa, registrar hipotese, input alterado, artefato invalidado e validacao a reexecutar. Sem mudanca relevante, nao repetir comandos caros nem recriar documentacao vigente.

## Persistencia v5

Usar `schema_version=5`. Manter `cycle-history.json` append-only e derivar a recorrencia de fingerprints desse arquivo. Nao aceitar `occurrence_count` informado sem correspondencia historica.

Qualquer migracao de v2/v3/v4 para v5 deve invalidar auditoria, requisitos e gates antigos. A migracao nao converte declaracoes legadas em evidencias novas.

Todo ciclo deve manter manifesto de artefatos vinculado ao SHA. Arquivo ausente, hash divergente ou `head_sha` diferente invalida a aprovacao.

## Aprovacao interna e portao independente

Adicionar o estado `internally-approved-awaiting-independent-audit`. Esse estado encerra a invocacao sem liberar a entrega. Somente `approved-without-reservations` com validade `independent` e terminal operacional.

## Escapes de auditoria

No primeiro escape independente, ignorar a regra comum de recorrencia 1/2/3 e transicionar imediatamente para `root-cause-analysis` e depois `systemic-remediation`. O fingerprint do escape deve alimentar um controle adversarial reutilizavel, executado em issues futuras quando a familia de risco for aplicavel.

## Autoridade única do ciclo

Somente `entregar-issue` incrementa `controller_cycle`. Estados internos do Entregar Issue espelham esse valor e não o avançam em mudanças de SHA. Uma auditoria que exige nova implementação é o único evento comum de avanço; mudanças de identidade apenas invalidam dependências dentro do ciclo vigente.
