---
name: auditar-issue
description: Auditar em modo somente leitura implementacoes de issues, PRs, branches ou commits, comparando contrato, codigo, dados, testes, documentacao e comportamento executado. Usar em contexto separado para auditoria independente ou em `controller_mode=delivery-single-invocation`. Executar verificacao proporcional ao risco, evitar repetir auditoria da mesma identidade e reutilizar somente evidencias brutas validas. Em controller-adversarial produzir apenas aprovacao interna provisoria; nunca corrigir codigo nem declarar independencia inexistente.
---

# Auditar Issue

## Objetivo

Tentar refutar a entrega em somente leitura. Tratar o pacote recebido como indice, nao conclusao. Produzir evidencia propria suficiente para o nivel de garantia real sem repetir trabalho quando identidade e inputs permanecem identicos.

## Validade

- `independent`: contexto separado daquele que implementou, corrigiu ou coordenou o SHA.
- `pre-audit`: separacao nao demonstrada.
- `controller-adversarial`: pre-auditoria rigorosa no controlador de chamada unica; produz no maximo aprovacao interna.

Trocar de skill no mesmo contexto nao cria independencia.

## Padrao obrigatorio da resposta

Comecar toda resposta humana sem preambulo e com exatamente uma destas linhas:

- `# RESULTADO: APROVADA`
- `# RESULTADO: APROVADA COM RESSALVAS`
- `# RESULTADO: APROVADA INTERNAMENTE`
- `# RESULTADO: INCONCLUSIVA`
- `# RESULTADO: REPROVADA`

Nao colocar titulo, validade, resumo, contexto, saudacao ou explicacao antes dessa linha. A primeira informacao visivel deve ser o resultado.

Aplicar o mapeamento deterministico:

- `APROVADA`: somente auditoria `independent`, sem finding bloqueante, sem limitacao material e com todos os gates obrigatorios aprovados.
- `APROVADA COM RESSALVAS`: somente auditoria `independent`, sem finding bloqueante, mas com ressalva material nao bloqueante explicitamente demonstrada.
- `APROVADA INTERNAMENTE`: `controller-adversarial` ou pre-auditoria favoravel, sem finding bloqueante; nunca libera merge, fechamento ou release.
- `INCONCLUSIVA`: somente quando uma limitacao do runtime, ferramenta ou connector da propria auditoria impedir obter bytes exatos, executar recurso interno da Skill ou observar evidencia obrigatoria, sem evidencia de que o candidato ou a entrega causaram a limitacao. Nao converter limitacao de infraestrutura da auditoria em finding da issue.
- `REPROVADA`: qualquer finding bloqueante, requisito incorreto ou nao implementado, identidade invalidada, gate obrigatorio falho/ausente por responsabilidade do candidato ou da entrega, handoff ausente/stale/inconsistente, ou evidencia material que a entrega deveria ter produzido mas nao produziu.

Logo abaixo do resultado, informar obrigatoriamente:

```markdown
**Validade:** [Independente | Controller-adversarial | Pre-auditoria]
**Libera merge/release:** [SIM | NAO]
```

Usar `SIM` somente para `APROVADA` ou `APROVADA COM RESSALVAS` com validade realmente independente e portao de release satisfeito. Para `APROVADA INTERNAMENTE`, `INCONCLUSIVA` e `REPROVADA`, usar sempre `NAO`. Depois apresentar motivo determinante, achados e evidencias. O resultado estruturado JSON continua obedecendo aos schemas e nao deve ser inferido apenas do cabecalho humano.

## Carregamento progressivo

Ler sempre `references/evidence-rules.md` e `references/gate-preflight.md`. Ler `references/delivery-contract.md` somente quando houver handoff composto ou modo controller.

Ler somente quando aplicavel:

- controller: `references/controller-mode.md` e `references/controller-evidence-contract.md`;
- desenho de controle negativo: `references/adversarial-control-design.md`;
- finding contra candidato antes aprovado internamente ou auditorias repetidas: `references/audit-escape-feedback.md`;
- nova auditoria apos reprovação independente/remediacao: `references/reaudit-readiness.md`;
- pacote de entrega antes de gastar auditoria ampla: `references/delivery-saturation-preflight.md`;
- certificado obrigatorio de handoff: `references/handoff-certificate-preflight.md`;
- resolucao de scripts/artefatos no runtime: `references/runtime-resource-resolution.md`;
- apos primeiro blocker: `references/blocker-harvest.md`;
- provider, retry/fallback, ferramenta externa ou workflow com credenciais: `references/provider-call-and-secret-audit.md`;
- `input-parser`: `references/input-parser-audit.md`;
- auditoria externa assinada: `references/external-audit-contract.md`;
- entrega: `references/report-template.md`.

## Invariantes

1. Nao modificar codigo, banco, branch, PR ou issue.
2. Nao corrigir findings durante auditoria.
3. Fixar identidade no inicio e revalidar no fim. Para certificado schema v2, distinguir `material_head_sha` do `published_handoff_head_sha` result-only; para schema v1, ambos coincidem.
4. Nao aceitar CI verde, checklist ou teste novo como prova unica.
5. Nao reutilizar conclusao do implementador como evidencia.
6. Nao produzir aprovacao importavel sem contexto separado e chave previamente confiada.
7. Em modo controller, devolver o resultado ao `entregar-issue` no mesmo fluxo, sem encerrar o ciclo e nao orientar nova conversa.
8. Separar `blocking` de `recommendation`.
9. Nao repetir auditoria quando fingerprint, identidade material e artefatos auditados forem identicos; ignorar apenas timestamps de observacao. Devolver o relatorio vigente com `input_fingerprint`, `reused=true`, `reuse_source` verificavel, `changed_files=[]` e `requires_refreeze=false`.
10. Qualquer mudanca de identidade, contrato, risco, ambiente ou evidencia obrigatoria invalida o reaproveitamento.
11. Operar GitHub em somente leitura: nao disparar, reexecutar, cancelar ou aprovar workflow/environment/deployment.
12. Nao exigir criacao de workflow para fechar lacuna de evidencia e nao pedir ao usuario aprovacao manual.
13. Para identidade, CI e estado operacional corrente, preferir metadata remota e artefatos brutos atuais a descricao da PR, checklist ou narrativa da implementacao.
14. Nunca tratar teste apenas declarado no codigo como teste executado; registrar separadamente `declared`, `reached` e `passed`.
15. Finding material contra candidato antes aprovado internamente e `audit_escape`: classificar a classe generalizavel, procurar casos irmaos baratos e emitir controle reutilizavel para prevencao e deteccao; nao devolver apenas a correcao do caso literal.
16. Em reauditoria, nao usar a independencia para executar pela primeira vez o controle herdado do finding anterior; ausencia dessa prova na entrega e `remediation-incomplete`.
17. Antes de uma auditoria ampla, usar `requirement-attack-matrix.json`, `risk-saturation.json` e `inherited-controls.json` somente como indice de readiness; se estiverem incompletos, reprovar por `delivery-not-saturated` sem gastar provas caras. Em `result-only-child`, esses artefatos devem estar vinculados ao `material_head_sha`, nao ao commit que apenas os publica.
18. Depois do primeiro blocker, completar a colheita barata por todos os requisitos atomicos e familias materiais ainda nao exercitados; nao devolver um blocker por auditoria quando outros independentes sao observaveis no mesmo SHA.
19. Tratar liveness de referencias e coerencia temporal de destino como familias canonicas: validade em T1 nao prova uso seguro em T3, e data sintaticamente valida nao prova destino futuro/periodo coerente.
20. Interpretar caminhos `scripts/...`, `references/...`, `schemas/...` e `tests/...` como relativos ao pacote instalado da Skill `auditar-issue`, nunca ao repositorio auditado. Nao exigir que o repositorio versione, copie ou venda esses recursos internos.
21. Quando a Skill estiver exposta apenas por resource URI, materializar seus recursos internos necessarios em diretorio efemero antes de executar; quando o repositorio estiver apenas em connector remoto, materializar somente os artefatos de entrada necessarios preservando os bytes exatos. Nunca alterar o repositorio para viabilizar a auditoria.
22. Se o runtime/connector impedir a materializacao exata ou a execucao de recurso interno da Skill apos tentativas razoaveis, classificar `audit-runtime-limitation`: resultado humano `INCONCLUSIVA`, `Libera merge/release: NAO`, `findings=[]` para essa causa, `requires_refreeze=false` salvo mudanca real de identidade. Nao usar `delivery-not-ready`, `red-candidate-caused`, `missing` ou `not-reached` para uma incapacidade exclusiva do ambiente do auditor. Nao propor commit, issue corretiva, workflow ou mudanca no produto para corrigir infraestrutura da auditoria.

## Fluxo

### 0. Preflight de readiness e reauditoria

Antes de qualquer auditoria ampla de uma entrega preparada por `entregar-issue`, exigir e validar `.audit/entregar-issue/handoff-ready.json` conforme `references/handoff-certificate-preflight.md`. Suportar tanto schema v1 exact-head quanto schema v2 `result-only-child`. No schema v2, coletar parent e changed paths do head publicado antes do preflight e auditar o `material_head_sha` certificado. Certificado realmente ausente, stale, com parent/path/identidade divergente ou hash inconsistente retorna `REPROVADA` por `delivery-not-ready` sem consumir descoberta ampla ou suites caras.

Resolver primeiro o root do pacote **da Skill `auditar-issue`**. Executar `<AUDIT_SKILL_ROOT>/scripts/check_delivery_preflight.py` como portao unico de readiness; `scripts/...` nunca significa caminho dentro do repositorio auditado. Ler `references/runtime-resource-resolution.md` antes da execucao. Materializar os artefatos `.audit/entregar-issue/` em workspace efemero quando vierem de connector remoto, preservando bytes exatos, e passar esses caminhos ao script. Nao substituir esse portao por inspecao manual parcial dos mesmos artefatos.

Se a transferencia de bytes exatos entre connector e runtime falhar, **nao retornar `INCONCLUSIVA` antes de tentar o fallback connector-native** definido em `references/runtime-resource-resolution.md`. Quando o connector expuser commit/tree/blob imutaveis no SHA fixo e o objeto completo permanecer pesquisavel semanticamente, gerar `connector-preflight-manifest.json` e executar `<AUDIT_SKILL_ROOT>/scripts/check_connector_preflight.py`. Retornar `INCONCLUSIVA` por `audit-runtime-limitation` somente quando nem o preflight por bytes nem o fallback por snapshot Git imutavel puderem obter a evidencia obrigatoria. Isso nao e `delivery-not-ready` e nao gera finding contra a issue.
CI remoto ainda `pending-no-run`, `queued`, `in_progress` ou `waiting` nunca e justificativa para ausencia do certificado: o produtor deve publicar o handoff antes de retornar depois do freeze. Com certificado valido e CI pendente, seguir para o preflight de gates e classificar o estado remoto separadamente; sem certificado, manter `delivery-not-ready` e `recovery_scope=handoff-only`.

Depois do certificado, aplicar `references/delivery-saturation-preflight.md`: exigir `requirement-attack-matrix.json`, `risk-saturation.json` e `inherited-controls.json`, nunca apenas quando forem fornecidos. Se requisitos cobertos estiverem sem ataque executado ou familias materiais estiverem nao saturadas, retornar `REPROVADA` por `delivery-not-saturated` sem consumir suites caras. Esses artefatos sao indice, nao evidencia conclusiva.

Quando houver auditoria independente anterior reprovada para a mesma issue/PR/familia, verificar primeiro o fechamento da remediacao conforme `references/reaudit-readiness.md`. Exigir tambem `inherited-controls.json` cumulativo e `learning-closure.json` certificado no novo SHA. Se closure, aprendizado ou controles herdados estiverem ausentes/incompletos, nao iniciar descoberta ampla, suites caras ou nova passagem adversarial: retornar `REPROVADA` por `remediation-incomplete`, com os campos faltantes. A proxima auditoria ampla so comeca quando literal, casos irmaos, prevencao, deteccao, aprendizado generalizado e controles herdados estiverem fechados no novo SHA.

### 1. Identidade e fontes

1. Registrar repositorio, issue, PR, branch, base, `material_head_sha`, `published_handoff_head_sha`, merge previews aplicaveis, contexto, rotas, estados e viewports. Em schema v1, material e published head coincidem.
2. Consultar a fonte remota antes das validacoes em modo somente leitura; nao gerar novo run.
3. Em `independent`, refazer descoberta e criar manifesto proprio.
4. Em `controller-adversarial`, usar `source-manifest.json` apenas como indice, verificar completude e hashes, e rederivar requisitos independentemente.
5. Produzir `requirements-rederivation.json` e comparar com o snapshot.

### 2. Preflight de gates

1. Consultar runs/statuses existentes para o head e merge preview congelados antes de provas caras.
2. Obter `changed_files` antes de atribuir origem a falhas.
3. Classificar cada gate obrigatorio conforme `references/gate-preflight.md`, distinguindo `red-candidate-caused` de falha herdada/infra.
4. Para suites sequenciais, produzir matriz `declared/reached/passed`; teste posterior a um abort nao conta como executado.
5. Se houver gate obrigatorio `red-candidate-caused`, `missing` ou materialmente `not-reached` por responsabilidade demonstrada do candidato/entrega, entrar em `blocker-bounded`: o parecer ja nao pode aprovar a identidade atual, cancelar provas caras nao relacionadas e continuar somente a varredura barata necessaria para encontrar blockers adicionais, agrupar causa raiz, verificar fronteiras criticas tocadas pelo diff e reduzir a remediacao.
6. Se houver `audit-runtime-limitation`, nao entrar em `blocker-bounded`; encerrar como `INCONCLUSIVA`, registrar a limitacao e nao atribuir falha ao candidato/entrega.
7. Reutilizar job verde oficial na identidade exata apenas para o escopo que ele realmente executou; abrir harness/script para entender cobertura, nao para rerodar sem necessidade.

### 3. Mapear risco e implementacao

Comparar base e SHA. Expandir somente para entrypoints, consumidores, persistencia, autorizacao, integracoes, UI, legado, configuracao e documentacao relacionados aos requisitos ou familias de risco. Rederivar independentemente as familias canonicas, incluindo `reference-liveness` quando IDs/snapshots atravessarem etapas e `temporal-destination` quando datas escolherem destino/vigencia.

Para entrada nao confiavel, mapear `transporte -> body parser -> helper -> validador -> hash/identidade -> parser -> persistencia` e toda transformacao da representacao bruta.

### 4. Evidencias

Para cada requisito comportamental, exigir evidencia positiva, controle negativo discriminante e regressao. Para alteracao apenas documental, usar busca de contradicoes, links, exemplos e comandos como controles apropriados.

Executar `documentacao-repositorio`, `design-interface` e `fluxos-conversacionais` somente quando aplicaveis e no mesmo modo de validade. Reutilizar atestacoes deterministicas apenas se SHA, comando, ambiente, hash de stdout/stderr e escopo coincidirem; nao repetir a suite oficial apenas para obter nova atestacao. Refazer somente a verificacao adversarial propria.

### 5. Validar e adversarializar

1. Respeitar o resultado do preflight. Se `blocker-bounded=true`, nao iniciar provas caras nao relacionadas; fazer apenas fechamento estatico barato, controles discriminantes necessarios e varredura de blockers correlatos. Se nao houver blocker determinante, seguir com revisao estatica do diff, fechamento por requisito e controles discriminantes baratos antes das provas caras.
2. Reutilizar gates oficiais atestados validos; executar novamente somente comando cujo escopo, ambiente ou artefato nao cubra a pergunta de auditoria.
3. Formular uma implementacao plausivel e errada que poderia passar no caminho feliz.
4. Em integracoes com provider, expandir helpers transitivos ate o SDK e comparar chamadas outbound reais com as tentativas contabilizadas pelo executor.
5. Executar dados discriminantes e registrar `coverage-matrix.json`.
6. Nao exigir a mesma suite duas vezes no mesmo fingerprint; executar uma vez os gates necessarios e uma passagem adversarial separada. Ao encontrar blocker, cancelar somente provas caras nao relacionadas e aplicar `references/blocker-harvest.md`: concluir a varredura estatica/controles baratos por todos os requisitos atomicos e familias materiais ainda abertas, inclusive de causas diferentes, para devolver o conjunto coeso de achados no mesmo ciclo.
7. Para `input-parser`, exigir inventario integral, matriz modo x invariante x familia de campo e cobertura `accepted_modes x consumed_fields x field_scope_placements`.
8. Testar valor bruto na fronteira publica, limite exato, excesso, padding, encoding, precedencia de erro e ausencia de efeitos.
9. Executar `IP-RAW-001`, `IP-MODE-001`, `IP-SCOPE-001`, `IP-INACTIVE-001` e `IP-EFFECT-001` quando aplicavel.
10. Quando estado, rota, nome ou arquitetura mudar, fazer varredura documental global por alegacoes antigas.
10.1. Quando calculos, respostas ou destinos de mutacao dependerem de periodo, `as-of`, data corrente, vigencia, semana, agenda ou projecao, atacar explicitamente passado, atual e futuro com cutoffs divergentes e campos temporais concorrentes. Quando houver periodo + data concreta, testar combinacao contraditoria; quando o contrato exigir destino futuro, `planned` no passado nao basta.
10.2. Quando referencias persistidas em uma etapa forem usadas em etapa posterior, atacar explicitamente referencia removida e referencia que manteve ID mas mudou elegibilidade/tenant/versao entre T1 e T3; validacao apenas na criacao nao comprova o gate definitivo.
11. Para fronteira publica persistente, enviar identificadores malformados por papeis irmaos e injetar erro bruto com marcadores sensiveis; verificar codigo, mensagem, shape, `correlationId` e ausencia de efeitos, nao apenas o status.
12. Para formulario com retry, idempotencia ou duplo envio, exigir execucao em navegador real do fluxo e da falha; regex no source e CI visual generico nao comprovam o requisito.

### 6. Classificar

Requisitos: `Implementado`, `Parcial`, `Nao implementado`, `Incorreto`, `Nao verificavel` ou `Fora do escopo`.

Achados: `Bloqueador`, `Alto`, `Medio` ou `Baixo`, sempre ligados a requisito e impacto. Usar `recommendation` apenas para melhoria opcional.

Parecer independente: `Aprovado`, `Aprovado com ressalvas`, `Inconclusivo` ou `Reprovado`. Usar `Inconclusivo` apenas para limitacao externa ao candidato/entrega.

No mesmo contexto: `Pre-auditoria com achados` ou `Pre-auditoria sem achados materiais`. Em controller, mapear favoravel para `internally-approved`, nunca para aprovacao operacional.

### 7. Entregar

1. Reconsultar identidade e estado remoto relevante em modo somente leitura; nao disparar ou aprovar workflow. Em result-only child, confirmar novamente parent + allowlist e que o material head certificado nao mudou.
2. Invalidar o parecer se head, base, merge preview ou input material mudar.
3. Produzir relatorio humano com o resultado na primeira linha, conforme `references/report-template.md`, incluir o estado dos gates e a matriz `declared/reached/passed` quando houver suite abortada ou `blocker-bounded`. Para `delivery-not-ready` causado apenas por certificado ausente/stale, incluir `return_control_to=entregar-issue`, `reason=handoff-not-produced|handoff-stale` e `recovery_scope=handoff-only`, sem sugerir mudanca funcional. Em `INCONCLUSIVA` por runtime, emitir resultado estruturado com `status=blocked`, `findings=[]` para a causa de infraestrutura, `limitations` descrevendo `audit-runtime-limitation`, `skip_reason` objetivo, `requires_refreeze=false` salvo mudanca real de identidade, `input_fingerprint` e `reused=false`. Entregar todos os achados bloqueantes baratos identificados em toda a colheita de saturacao, agrupados por causa e convertiveis em work items; nao devolver um blocker por ciclo quando outro blocker independente e barato ja e observavel no mesmo SHA. Para cada `audit_escape`, produzir tambem `escape-control.json` conforme `references/audit-escape-feedback.md`, com caso literal, casos irmaos, controle reutilizavel e alvos de prevencao/deteccao. Usar `skip_reason` em qualquer no-op ou incompatibilidade contratual.
4. Em controller, produzir `controller-audit-report.json`, validar com `scripts/validate_controller_audit_result.py`, usar `mode=controller-adversarial` e `data.controller_disposition=internally-approved` quando favoravel. Nunca usar `approved-operationally`.
5. Em auditoria realmente independente, gerar e assinar `external-audit.json` somente depois da ultima reconsulta.

## Pacote neutro e escapes

Rejeitar pacote independente com conclusoes ou narrativa do implementador. Aceitar fontes, identidade, diff, codigo, testes, manifests e evidencias brutas.

Finding bloqueante independente no mesmo SHA aprovado internamente e `audit_escape`: registrar parecer anterior, exigir causa raiz, melhoria de Skill, teste preventivo e controle adversarial reutilizavel, e devolver `remediation-required`. O feedback reutilizavel deve descrever classe e controle genericos; identificadores concretos permanecem apenas na evidencia local do finding.

## Limitacoes

Marcar `Nao verificavel` quando ambiente, acesso, dados ou ferramenta indispensavel impedir prova. Nao preencher lacuna com suposicao. Nao fazer alteracao remota sem autorizacao.

## Versão contratual e portão de release

Emitir `contract_version=2026-08-06.2`. Em `controller-adversarial` ou `isolated-within-run`, exigir `approval_scope=internal-only`, `release_gate_satisfied=false` e `controller_disposition=internally-approved|remediation-required`. Somente `mode=independent` pode usar `approval_scope=independent-release-gate`.
