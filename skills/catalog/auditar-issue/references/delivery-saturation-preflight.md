# Preflight de saturacao da entrega

## Objetivo

Evitar consumir uma auditoria independente cara quando a propria entrega ainda nao transformou todos os requisitos materiais em ataques executados.

## Artefatos esperados do handoff

Usar como **indice de readiness, nunca como conclusao de auditoria**:

- `requirement-attack-matrix.json`;
- `risk-saturation.json`;
- `inherited-controls.json`;
- `audit-escape-closure.json` quando houve rejeicao independente anterior.

Antes da descoberta ampla, confirmar:

- todo requisito coberto possui implementacao errada plausivel, controle positivo, negativo e regressao no SHA candidato;
- toda familia canonica aplicavel esta marcada `passed` e aponta para controles executados;
- controles herdados nao possuem `not-run/failed` e pertencem ao SHA candidato;
- nenhum requisito/familia material esta listado como uncovered/missing.

Se o pacote falhar nesse preflight, devolver `REPROVADA` por `delivery-not-saturated` sem gastar suites caras. A auditoria independente nao deve ser a primeira execucao de uma familia de ataque derivavel da issue.
