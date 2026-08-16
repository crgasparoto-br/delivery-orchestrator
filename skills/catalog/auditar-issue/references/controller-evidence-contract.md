# Contrato de evidencias controller-adversarial

## Saidas obrigatorias

1. `source-manifest.json`;
2. `requirements-rederivation.json`;
3. `coverage-matrix.json`, incluindo `negative_control_evidence` estruturada e hasheada por requisito;
4. `controller-audit-report.json` schema 3;
5. hashes, identidade e manifesto do pacote neutro.

## Pacote neutro

O manifesto deve registrar `implementation_conclusions_included=false` e `implementation_narrative_included=false`. Rejeitar pacote com resumo de implementacao, parecer anterior, justificativas, alegacoes de atendimento ou recomendacao do implementador.

## Escapes

Quando uma auditoria independente receber `prior_internal_approval` do mesmo SHA e encontrar finding bloqueante, registrar `audit_escapes` no relatorio. Cada escape deve vincular finding, fingerprint, SHA afetado e hash do relatorio interno anterior.

## Controles negativos

Cada identificador em `negative_controls` deve possuir uma evidencia correspondente com familia, dimensao, modo de falha, implementacao errada plausivel, procedimento, esperado, observado, SHA e hash do arquivo. String ou nome de teste isolado invalida o requisito como `Implementado`.

## Validacao

Executar `python <auditar-issue>/scripts/validate_controller_audit_result.py <controller-audit-report.json>`. Nao devolver parecer favoravel se o validador falhar.
