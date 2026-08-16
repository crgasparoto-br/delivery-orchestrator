# Modo controller-adversarial

## Ativacao

Aplicar quando a entrada contiver `controller_mode=delivery-single-invocation` e `return_control_to=entregar-issue`.

## Semantica

Executar passagem adversarial somente leitura e devolver o resultado ao controlador no mesmo prompt. Nao solicitar nova conversa e nao declarar independencia. Resultado favoravel significa apenas aprovacao interna provisoria.

## Classificacao

- `disposition=blocking`: requisito nao atendido, regressao, defeito, seguranca, documentacao obrigatoria ou gate aplicavel;
- `disposition=recommendation`: melhoria opcional fora da obrigacao atual.

Recomendacoes opcionais isoladas nao produzem ressalva.

## Resultado estruturado

Usar `data.controller_disposition=internally-approved` quando nao houver achado bloqueante. Nunca usar `approved-operationally`. Usar `remediation-required` quando houver finding bloqueante.

O resultado deve declarar `assurance_level=controller-adversarial`, `approval_scope=internal-only` e `release_gate_satisfied=false`.

## Contrato v3 obrigatorio

Produzir `source-manifest.json`, `requirements-rederivation.json`, `coverage-matrix.json` e `controller-audit-report.json` schema 3. Validar o ultimo com `scripts/validate_controller_audit_result.py`.
