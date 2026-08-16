# Colheita completa de blockers em uma unica auditoria

## Objetivo

Reduzir ciclos em que cada auditoria independente devolve apenas um defeito material novo.

## Regra apos primeiro blocker

Quando o primeiro blocker torna o candidato nao aprovavel:

1. interromper apenas provas caras nao relacionadas;
2. continuar a varredura estatica e controles baratos por **todos os requisitos atomicos ainda nao fechados**, nao somente casos irmaos da causa ja encontrada;
3. revisar todas as familias de risco materiais da issue que ainda nao receberam ataque independente;
4. agrupar findings por causa raiz, mas nao omitir blockers independentes apenas porque pertencem a outra familia;
5. devolver no mesmo relatorio o conjunto coeso de blockers baratos observaveis.

## Checklist de saturacao independente

Depois do primeiro blocker, revisar pelo menos:

- autorizacao/entitlement;
- tenant e ownership;
- fronteira publica e nao enumeracao;
- `reference-liveness`: liveness de referencias entre etapas;
- `temporal-destination`: passado/atual/futuro e coerencia de periodo/destino;
- concorrencia, idempotencia e rollback;
- historico/imutabilidade/nova revisao;
- contrato estrutural/caminho canonico;
- documentacao contraditoria.

Marcar familia `not-applicable` apenas com justificativa baseada no contrato. O objetivo nao e executar toda suite, e sim evitar que um blocker barato de outra familia estreie apenas na proxima auditoria.
