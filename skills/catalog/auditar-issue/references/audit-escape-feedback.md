# Feedback estruturado de audit escape

## Objetivo

Converter finding independente que escapou de aprovacao interna em defesa reutilizavel, reduzindo novas auditorias usadas apenas para descobrir o proximo caso da mesma classe.

## Classificacao obrigatoria

Quando o mesmo SHA, ou candidato materialmente equivalente, havia sido `INTERNALLY_APPROVED`, registrar `audit_escape=true` e classificar:

- `escape_class`: causa generalizavel, nao sintoma/local de arquivo;
- `prevention_gap`: o que permitiu a implementacao errada;
- `detection_gap`: por que o gate interno nao a distinguiu;
- `plausible_wrong_implementation`;
- fronteira publica/transacional/temporal em que o ataque deveria falhar;
- `trigger_terms`/sinais estruturais capazes de ativar o mesmo ataque em outras issues;
- `required_risk_families` que devem entrar na saturacao futura.

## Varredura antes de devolver

Depois do primeiro blocker, continuar a varredura estatica barata da mesma classe e executar controles discriminantes baratos necessarios. Procurar ao menos dois casos irmaos quando houver dimensoes plausiveis. Nao interromper no primeiro exemplo se a mesma causa pode afetar caminhos equivalentes.

## `escape-control.json`

Emitir uma entrada por escape:

```json
{
  "finding_id": "A-001",
  "audit_escape": true,
  "escape_class": "restart-idempotency-recovery-gap",
  "plausible_wrong_implementation": "...",
  "literal_case": {"entrypoint": "...", "procedure": "...", "expected": "...", "observed": "..."},
  "sibling_cases": [{"id": "...", "dimension": "...", "procedure": "..."}],
  "reusable_control": {"id": "RESTART-IDEM-001", "risk_family": "state-recovery", "procedure": "..."},
  "trigger_terms": ["retry", "reinicio", "lease"],
  "required_risk_families": ["idempotency", "concurrency-atomicity"],
  "prevention_target": "implementation/delivery contract",
  "detection_target": "internal adversarial gate"
}
```

O artefato e handoff de remediacao, nao evidencia de aprovacao. A entrega deve incorporar o padrao ao `audit-escape-pattern-catalog.json` e o controle ao `inherited-controls.json` antes do proximo handoff.

## Controles canonicos reutilizaveis

### `TEMP-ASOF-001`

Para metrica rotulada por periodo historico, criar evento dentro do periodo e evento posterior com valores diferentes. Verificar que o evento posterior nao contamina o resultado historico e que o cutoff executado coincide com o horizonte apresentado. Repetir caso irmao para periodo atual e projecao futura.

### `RESTART-IDEM-001`

Persistir operacao em estado de processamento, simular interrupcao/reinicio e expirar a lease. Repetir **o mesmo entrypoint publico**, com a **mesma chave de idempotencia**, sem GET/health-check/operacao auxiliar de recuperacao. O retry deve recuperar ou finalizar de forma controlada sem duplicar outbound/efeito. Caso irmao: nova chave concorrente; caso irmao: reinicio apos outbound mas antes da finalizacao.

Um teste que primeiro chama endpoint auxiliar de leitura e somente depois repete a operacao nao comprova retry direto.

## Regra de qualidade

O controle reutilizavel deve falhar na implementacao plausivel errada encontrada e passar na correta. Se ambas passam, o controle nao fecha o escape.
