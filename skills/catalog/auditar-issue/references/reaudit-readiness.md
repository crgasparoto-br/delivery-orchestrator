# Preflight de remediacao antes de nova auditoria independente

## Objetivo

Evitar gastar uma auditoria independente ampla apenas para descobrir que a remediacao do finding anterior ainda nao fechou a classe do escape ou deixou controles antigos sem execucao.

## Aplicabilidade

Aplicar quando houver evidencia de auditoria independente anterior `REPROVADA` para a mesma issue, PR, branch ou familia de candidato e houver nova tentativa de auditoria apos remediacao.

Antes da descoberta ampla:

1. localizar todos os findings/`escape-control.json` anteriores relevantes, nao apenas o ultimo;
2. exigir `audit-escape-closure.json` da entrega remediada;
3. verificar `escape_class`, implementacao errada plausivel, caso literal, no minimo dois casos irmaos, `prevention_change`, `detection_change` e `status=passed`;
4. exigir `inherited-controls.json` cumulativo com todos os controles reutilizaveis anteriores ainda aplicaveis;
5. exigir que cada controle herdado tenha sido executado no novo SHA e possua evidencia;
6. se closure ou controles herdados estiverem ausentes, incompletos, `failed` ou `not-run`, interromper a auditoria ampla e devolver reprovação por `remediation-incomplete`, listando exatamente os campos faltantes.

Esse preflight nao substitui a auditoria independente quando a remediacao estiver pronta. Ele impede que a auditoria seja usada como primeira execucao do ataque que a entrega ja deveria ter exercitado e impede regressao silenciosa de findings mais antigos.

Executar `scripts/check_reaudit_readiness.py --closure ... --inherited-controls ... --head-sha ...`.
