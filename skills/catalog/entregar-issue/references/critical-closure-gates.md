# Portões críticos de fechamento

Estes portões transformam riscos que escapam de checklists nominais em inventários e cenários executados.

## F20 — Indistinguibilidade pública

Aplicar quando houver autorização ou privacidade. Inventariar em `public_boundaries` cada endpoint público ou de escopo não confiável, os estados secretos comparados e o ponto em que rate limit/autenticação/guards executam.

Executar no endpoint real e comparar:

- status, código, corpo e headers relevantes;
- efeitos persistentes e eventos observáveis;
- ordem de rate limit antes de consulta sensível;
- distribuição de latência quando os caminhos internos tiverem custos diferentes.

O cenário deve declarar `public_boundaries` e `observables`. Exigir os observáveis `status`, `code`, `body`, `side-effects`, `guard-order` e `timing`. Divergência que revele existência, duplicidade, tenant, permissão ou elegibilidade reprova.

## F21 — Atomicidade da decisão de negócio

Aplicar a toda persistência. Inventariar `transactional_business_operations` com nome, decisões/guards, fontes mutáveis, constraints e checkpoints.

Para cada operação, executar duas sessões com barreira entre preflight e commit. Introduzir conflito ou mudança de fonte na segunda sessão e provar na primeira:

- decisão reavaliada dentro da transação depois do lock;
- constraint, lock, isolamento ou escrita condicional que feche a janela;
- rollback sem mutação, evento, timestamp ou efeito derivado;
- comportamento terminal/idempotente de retry.

O cenário deve declarar `operations`, `interleavings` e `assertions`. Exigir `conflict-after-preflight-before-lock`, `source-change-after-lock-before-commit`, `decision-rechecked-in-transaction` e `no-partial-effects`.

## F22 — Invariantes relacionais e dados legados

Aplicar quando houver migration/backfill. Inventariar `structural_invariants` com regra, entidades, caminhos de mutação e estratégia no banco.

Executar contra o banco real ou equivalente:

- criação direta inválida;
- atualização posterior que torne inválido um registro já referenciado;
- concorrência entre duas mutações válidas isoladamente;
- backfill com dados legados patológicos;
- verificação global pós-migration.

Para relações canônicas, incluir ciclo, cadeia e destino que posteriormente vira origem. O cenário deve declarar `structural_invariants`, `mutation_cases` e `assertions`, incluindo `direct-write`, `referenced-target-update`, `concurrent-write`, `legacy-backfill` e `global-postcondition`.

## F23 — Vigência, revisão e invalidação

Aplicar a autorização/privacidade persistente. Inventariar `freshness_sources`: versão/fingerprint canônica, campos revisados e mutações que invalidam a decisão.

Não aceitar presença de timestamp ou versão como prova de vigência. Comparar o valor persistido com a fonte atual dentro da transação final.

Executar:

- versão antiga presente;
- mudança de cada fonte revisada após aprovação;
- mudança concorrente antes do commit;
- revisão refeita com a nova versão;
- controle de campo fora do conjunto, quando existir.

O cenário deve declarar `freshness_sources`, `transition_cases` e `assertions`. Exigir `stale-version-present`, `reviewed-source-changed`, `concurrent-freshness-loss`, `current-version-accepted` e `review-invalidated`.

## F24 — Revisão e transição visíveis completas

Aplicar quando o fluxo for visual e multi-step. Inventariar `stateful_ui_transitions` com origem, destino, campos de revisão, capacidades de leitura/ação, confirmação, próximas ações e mecanismo de localização do destino.

Executar o fluxo real com:

- cada campo exigido presente e identificado;
- link/ação sensível condicionado à permissão específica;
- capacidade de ação funcionando com a leitura mínima necessária;
- confirmação e próximas ações após o commit;
- reload/navegação sem depender de estado efêmero;
- consulta, aba ou filtro que encontre o estado terminal.

O cenário deve declarar `transitions`, `checks` e `permission_cases`. Exigir `review-field-inventory`, `specific-permission-link`, `minimal-read-for-action`, `confirmation`, `next-actions`, `reload-persistence` e `terminal-discoverability`.

## F15 — Documento vinculado ao candidato final

Além do contrato documental normal, comparar no SHA congelado qualquer plano, relatório, checklist ou documento que declare versão, hash ou estado validado. Referência a SHA anterior, comportamento removido ou comando obsoleto reprova, mesmo que o CI esteja verde.

## F25 — Fechamento produtor–contrato–consumidor

Aplicar quando o contrato exigir histórico, versões, autoria, origem, supersessão, vigência, paginação, timeline, coleção retornada ou preservação de registros anteriores.

Preencher `read_model_closures` em `requirement-closure.json`. Para cada requisito, vincular:

- campos e metadados exigidos;
- produtor real;
- projeção pública/DTO;
- consulta ou caller cliente;
- consumidor real;
- superfície observável;
- cenário com pelo menos duas versões ou itens deliberadamente diferentes;
- controle negativo que falhe se o backend produzir dados não consumidos, se a projeção remover metadados ou se a interface mostrar somente o estado atual.

Reprovar quando `unconsumed_outputs` ou `unmapped_required_fields` não estiverem vazios. Timeline que apenas registra a ocorrência não substitui histórico detalhado quando o contrato exigir valores anteriores.

## F26 — Consistência da fonte canônica entre superfícies

Aplicar quando o mesmo conceito aparecer em duas ou mais superfícies ou quando o contrato mencionar fonte canônica, coerência ou consistência.

Preencher `canonical_source_consistency` com o campo semântico, fonte canônica, fontes alternativas, superfícies e fixture divergente. O valor canônico deve ser deliberadamente diferente de cada alternativa. O teste deve falhar se cabeçalho, resumo, lista, detalhe, relatório ou formulário usar a fonte concorrente.

Reprovar quando `unverified_surfaces` ou `missing_divergent_tests` não estiverem vazios, quando a fixture usar valores coincidentes ou quando a fonte canônica aparecer como alternativa.

## F27 — Ausência de contratos documentais concorrentes

Aplicar quando houver rota, arquitetura, nomenclatura, estado atual, aposentadoria, substituição, redirect ou fluxo legado alterado.

Preencher `documentation_consistency` com termos do contrato anterior e novo. Pesquisar no SHA congelado todas as fontes versionadas, inclusive fora do diff, e classificar cada ocorrência como contrato atual, histórica, legado aposentado, compatibilidade, exemplo ou contradição.

O validador recompõe as ocorrências dos termos antigos em Markdown e reprova inventário incompleto. Linha que trate comportamento antigo como `atual`, `existente`, `linha de base` ou equivalente é contradição, salvo quando a própria linha o marcar claramente como histórico, aposentado ou redirect de compatibilidade. `unresolved_contradictions` deve permanecer vazio.


## F34 — entrada nao confiavel

O fechamento critico falha quando parser/decoder nao possui inventario de modos, inventario integral de campos consumidos, matriz modo x invariante, matriz modo x campo x posicionamento, cadeia de transformacoes do bruto e testes na fronteira publica. `trim`, coercao ou decode anteriores ao limite, vazio, encoding, hash ou identidade sao riscos obrigatorios, mesmo que os testes unitarios do parser estejam verdes.
