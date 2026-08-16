---
name: revisar-issue
description: Revisar, normalizar e reescrever issues do GitHub como especificacoes claras, testaveis e prontas para implementacao. Usar quando houver ambiguidade, contradicao, lacuna material, escopo excessivo ou criterio nao verificavel. Sob `entregar-issue`, executar somente quando o readiness gate falhar, corrigir apenas os pontos bloqueantes, reutilizar fontes e registro documental, versionar mudancas materiais e retornar resultado estruturado; nao implementar codigo nem criar entrega paralela.
---

# Revisar Issue

## Objetivo

Corrigir somente lacunas que impedem implementacao consistente. Nao reescrever por estilo nem reiniciar descoberta ja concluida.

## Modos

- `standalone-review`;
- `orchestrated-readiness-remediation`.

No modo orquestrado, ler `references/delivery-contract.md`. Ler sempre `references/invariant-taxonomy.md` quando houver requisito negativo, reutilizacao, fonte canonica, precedencia, fallback ou dependencia proibida. Ler `references/specification-standard.md` somente para validar a proposta final.

## Fast gate

Retornar `not-applicable` quando o readiness gate apontar apenas preferencia editorial, formatacao ou melhoria opcional. Prosseguir somente quando faltar decisao que possa levar dois implementadores a resultados materialmente diferentes.

## Entradas orquestradas

Consumir lacunas, snapshot preliminar, fontes, versao e `documentation-impact.json`. Nao reler toda a issue ou documentacao quando as fontes recebidas cobrem a lacuna. Ampliar descoberta somente se uma pergunta bloqueante depender de fonte ausente.

## Fluxo

1. Mapear cada lacuna a requisito, fonte e decisao necessaria.
2. Separar requisito, premissa, pergunta aberta e fora de escopo. Classificar tambem invariantes verificaveis em `must_behave`, `must_not_behave`, `must_reuse`, `must_be_single_source`, `must_not_depend_on`, `precedence_invariants` e `forbidden_implementation` quando aplicaveis.
3. Produzir patch minimo nas secoes afetadas; preservar texto e IDs nao relacionados.
4. Carregar `fluxos-conversacionais` em `specification` somente para continuidade real.
5. Nao inventar arquitetura, API, dados ou regra de negocio.
6. Validar criterios observaveis e consistencia com fontes canonicas. Para cada invariante estrutural, registrar uma implementacao plausivel errada que ainda poderia passar no caminho feliz e o controle que a distinguiria.
7. Atualizar GitHub somente quando autorizado e houver mudanca material.
8. Incrementar `specification_version` e invalidar snapshot anterior somente quando o contrato mudar.

## Eficiencia

- Agrupar lacunas da mesma causa em uma unica revisao.
- Nao criar secoes vazias ou repetir contexto ja referenciado.
- Nao executar nova revisao se fontes, lacunas e versao tiverem o mesmo fingerprint.
- Retornar perguntas abertas em vez de expandir escopo por suposicao.

## Entrega

Retornar readiness, versoes, lacunas corrigidas, perguntas abertas, fontes alteradas, requisitos afetados, impacto documental, `invalidates_previous_snapshot` e o inventario de invariantes estruturais quando aplicavel. Usar `specification-gap` ou `blocked` quando decisao material permanecer ausente. Nao criar branch, implementar, fechar issue ou alterar PR.

## Composicao versionada

No modo orquestrado, aplicar `references/delivery-contract.md` como unica fonte do envelope, reutilizacao e versao. Toda execucao nova deve emitir `input_fingerprint` e `reused=false`; qualquer no-op deve incluir `skip_reason`. Nao duplicar plano, estado, ciclo, identidade global ou delegacao.
