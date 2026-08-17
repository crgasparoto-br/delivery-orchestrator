---
name: entregar-issue
description: "Executar a entrega ponta a ponta de issues em repositorios de software com um unico controlador, plano e estado: revisar readiness quando necessario, implementar codigo/testes/schemas/configuracao/documentacao, validar durante a edicao, aplicar higiene limitada ao diff, acionar especialidades condicionais, executar gates finais, congelar o candidato, observar CI remoto em modo somente leitura, remediar findings e preparar auditoria independente. Usar quando o usuario informar uma issue, PR, branch ou pendencias e esperar continuidade sem novos prompts. Nunca fazer merge nem declarar auditoria independente no mesmo contexto."
---

# Entregar Issue

## Objetivo

Produzir o menor candidato completo, rastreavel e localmente verde para uma issue. Possuir diretamente ciclo, identidade, contrato, plano, implementacao, validacoes, higiene limitada, gates, freeze, remediacao e handoff. Nao delegar etapas internas para Skills que recriem estado ou releiam o problema.

A verificacao executada no mesmo contexto e interna. Somente `auditar-issue` em contexto realmente separado pode liberar aprovacao operacional.

## Modelo arquitetural

Usar uma unica camada de controle:

```text
entregar-issue
  -> revisar-issue                 somente se readiness falhar materialmente
  -> implementacao interna         sempre que houver work item executavel
  -> documentacao interna por delta para alteracoes pequenas
  -> documentacao-repositorio      somente para impacto documental amplo
  -> design-interface              somente para recorte visual material
  -> fluxos-conversacionais        somente para continuidade assincrona material
  -> gate adversarial interno
  -> handoff para auditar-issue independente
```

Nunca invocar `issue-loop-engineer`, `orquestrador`, `implementar-issue` ou `higienizacao` dentro deste fluxo. Essas Skills sao compatibilidade legada, nao componentes de execucao.

## Carregamento progressivo

Ler sempre:

- `references/controller-execution-efficiency.md`;
- `references/composition-contract.md`;
- `references/implementation-workflow.md`.

Ler somente quando aplicavel:

- transicao, recorrencia ou decisao: `references/controller-loop-protocol.md`;
- risco e perfil: `references/execution-profiles.md`;
- autorizacao, persistencia, runtime, visual ou input parser: a referencia do gate correspondente;
- entrada nao confiavel ou provider: referencias `implementation-*` correspondentes;
- publicacao, CI ou coleta remota: `references/github-actions-policy.md`;
- auditoria interna: `references/controller-audit-contract.md` e `references/controller-single-invocation.md`;
- controle negativo: `references/controller-adversarial-evidence.md`;
- matriz requisito -> ataque: `references/requirement-attack-matrix.md`;
- referencias persistidas entre etapas: `references/reference-liveness-gate.md`;
- saturacao de familias de risco: `references/risk-saturation-gate.md`;
- controles herdados de auditorias anteriores: `references/cumulative-audit-controls.md`;
- catalogo reutilizavel de escapes: `references/audit-escape-pattern-catalog.md`;
- requisito estrutural, caminho canonico, precedencia, dependencia proibida ou fonte unica: `references/structural-invariant-gate.md`;
- melhoria de Skill: `references/controller-skill-improvement.md`;
- generalizacao de aprendizado apos rejeicao: `references/learning-generalization.md`;
- certificado de handoff independente: `references/handoff-certificate.md`;
- runtime `connector-only` ou recuperacao de certificado ausente/stale: `references/connector-only-handoff.md`;
- finding independente contra candidato antes aprovado internamente: `references/audit-escape-closure.md`;
- calculo, relatorio, projecao ou destino de mutacao dependente de periodo/data/futuro: `references/temporal-consistency-gate.md`;
- resposta final: `references/controller-result-template.md`.

Nao carregar referencias condicionais por antecipacao.

## Autoridade e invariantes

1. Possuir com exclusividade identidade, `controller_cycle`, plano, estado, work items, freeze, findings globais e decisao.
2. Calcular o plano uma vez por conjunto de inputs materiais. Nao permitir que uma etapa subordinada execute planejamento equivalente.
3. Tratar caminhos inicialmente atribuídos como `implementation_scope`; nao usar o diff produzido como motivo para reabrir a mesma implementacao.
4. Reabrir implementacao apenas por novo `work_item_fingerprint`, mudanca material de fonte/contrato/identidade ou finding novo.
5. Definir um unico `write_owner` por caminho. Skills condicionais nao podem disputar arquivos com o nucleo de implementacao.
6. Nao enfraquecer requisito, risco, gate, severidade ou cobertura para concluir.
7. Nao fazer merge, fechar issue, alterar producao, dados, segredos ou credenciais sem autorizacao explicita.
8. Tratar GitHub Actions como evidencia remota somente leitura. Nao criar, disparar, reexecutar, cancelar ou aprovar workflows para fabricar evidencia.
9. Publicar somente um candidato material, congelado e localmente verde. Nova publicacao exige correcao material posterior.
10. Exigir por requisito comportamental evidencia positiva, controle negativo discriminante e regressao. Para documentacao, usar contradicao, links, exemplos e comandos.
11. Nao executar suite completa durante ajustes intermediarios. Executar checks focados e um gate final agregado antes do freeze.
12. Para input parser, exigir matriz completa e controles `IP-RAW-001`, `IP-MODE-001`, `IP-SCOPE-001`, `IP-INACTIVE-001` e `IP-EFFECT-001` no SHA congelado.
13. Em gate de desempenho tenant-scoped ou filtrado, usar como denominador somente a cardinalidade do escopo alvo, nunca o total global.
14. Nao chamar verificacao do mesmo contexto de independente. Resultado favoravel interno e no maximo `INTERNALLY_APPROVED`.
15. Tratar auditoria independente como confirmacao de uma defesa ja exercitada internamente: nenhuma familia **nem superficie material da mesma familia** pode estrear somente depois do handoff se era derivavel do contrato, do diff ou de um `audit_escape` anterior.
16. Requisitos de forma de implementacao sao requisitos de primeira classe: `nao criar/manter`, `reutilizar`, `caminho canonico`, `fonte unica`, `nao depender` e invariantes de precedencia nao podem ser fechados apenas por resultado end-to-end correto.
17. Antes do primeiro handoff independente, todo requisito coberto deve aparecer em `requirement-attack-matrix.json` com `risk_surfaces` completas, implementacao errada plausivel, controle positivo, controle negativo discriminante primario por superficie, casos irmaos que variem `surface + dimension` e regressao executados no SHA final.
18. Classificar explicitamente todas as familias canonicas e suas superficies materiais em `risk-saturation.json`; familia ou superficie aplicavel sem controle correspondente impede freeze/handoff.
19. Quando uma referencia persistida em T1 for usada em T3, nao aceitar validacao apenas na criacao/aprovacao: aplicar `reference-liveness` e revalidar a fonte na operacao definitiva.
20. Manter `inherited-controls.json` cumulativo para todas as auditorias independentes anteriores; novo finding nunca substitui controle herdado antigo.
21. Depois do primeiro finding interno, completar a varredura barata de todos os requisitos e familias ainda nao saturados antes de editar ou publicar novo candidato.
22. Toda rejeicao independente deve produzir `learning-closure.json`; promover regra permanente de Skill somente depois de generalizar a classe e provar transferencia em fixtures sinteticas.
23. Proibir regras e testes permanentes de Skill acoplados a repositorio, produto, issue, PR, branch, SHA ou caminho concreto do evento que originou o aprendizado.
24. Nenhum handoff independente e valido sem `handoff-ready.json` gerado para o **material head final** depois dos validadores de cobertura, saturacao, controles herdados e aprendizado aplicavel.
25. Qualquer mudanca posterior ao freeze fora do `result-only-child` autorizado — inclusive remediacao por `corrigir-ci`, formatacao, documentacao, teste ou mudanca colateral — cria novo material head e invalida freeze, atestacoes dependentes e certificado anteriores. O commit de resultados autorizado nao invalida a identidade material que certifica.
26. Quando `corrigir-ci` devolver `return_control_to=entregar-issue` com `reason=post-ci-refreeze`, executar fast path de reconciliacao: comparar `previous_frozen_sha..current_head_sha`, invalidar apenas evidencias realmente dependentes do delta, reexecutar os gates necessarios no novo **material head**, refazer freeze e regenerar o certificado antes de novo handoff.
27. Tratar `handoff-ready.json` versionado como certificado do **material head**, nunca do commit que o contem. Publicar o pacote em um filho direto `result-only-child` e validar parent + allowlist de caminhos; nao exigir autorreferencia `certificado -> SHA do proprio commit`.
28. Em `connector-only`, ausencia de checkout nao permite omitir o pacote: materializar inputs/artefatos em workspace efemero, executar validadores da Skill e publicar o result-only child pelo connector. Se o connector nao permitir isso, bloquear internamente e nao chamar `auditar-issue`.
29. Pacote `.audit/entregar-issue` herdado de outra issue/SHA deve ser substituido atomicamente pelo pacote atual no handoff; nunca terminar a entrega apenas removendo o pacote stale.
30. Depois que existir um material head congelado e localmente pronto, nenhum retorno normal da Skill pode ocorrer antes de publicar e validar o `result-only-child` de handoff. CI `pending-no-run`, `queued`, `in_progress` ou `waiting` e estado remoto do gate, nao permissao para omitir o handoff.
31. Imediatamente antes de qualquer resposta que permita futura auditoria independente, reconsultar o head remoto e executar o gate terminal de handoff: o head publicado deve ser um filho direto do material head, conter `handoff-ready.json`, alterar somente caminhos permitidos e validar contra o material head. Falha nesse gate aciona recuperacao `handoff-only` na mesma invocacao quando o material head estiver estavel; se a publicacao for impossivel, bloquear internamente e nao encaminhar para `auditar-issue`.
32. Usar uma **barreira universal pos-escrita**: se a invocacao iniciou com handoff existente ou publicou qualquer commit/arquivo no repositorio, nenhum caminho de saida pode contornar a reconciliacao terminal de identidade. Antes de responder, registrar `last_material_write_sha`, reconsultar o head remoto e provar exatamente um estado terminal: `terminal-handoff-valid`, `unchanged-exact-head` sem handoff previo aplicavel, ou bloqueio real com `Libera auditoria: NAO`. Um head material posterior ao certificado nunca pode terminar como pronto, verde, corrigido ou apto a auditoria.
33. Se a barreira universal observar `current_head != certified_handoff_head`, classificar o delta antes de sair: (a) somente caminhos allowlisted de resultado e parent correto -> validar como handoff terminal; (b) qualquer caminho material, inclusive teste/documentacao/formatacao -> executar `post-write-refreeze` na mesma invocacao; (c) material head estavel sem filho de resultados -> executar `handoff-only`; (d) impedimento real -> bloquear. Nao devolver controle ao usuario entre a deteccao e essa reconciliacao.

## Estado e contratos

Manter em `.audit/entregar-issue/`:

- `controller-context.json`;
- `delivery-state.json` ou `loop-state.json` schema 5 durante compatibilidade;
- `source-manifest.json`;
- `specification-snapshot.json`;
- `requirement-closure.json`;
- `risk-profile.json`;
- `applicability-ledger.json`;
- `execution-plan.json`;
- `documentation-impact.json`;
- `requirement-attack-matrix.json`;
- `risk-saturation.json`;
- `inherited-controls.json`;
- `audit-escape-pattern-catalog.json`;
- `learning-closure.json` quando houver rejeicao independente;
- `handoff-ready.json`;
- atestacoes, freeze, historico e handoff.

Inicializar contexto uma vez por `scripts/controller_cli.py init-context`. Atualizar identidade, fontes, baseline, workflows e metricas em uma unica chamada `refresh-context` quando possivel. Timestamps de observacao e telemetria nao invalidam etapas.

Usar `controller_mode=delivery-single-invocation`. Aceitar `issue-loop-single-invocation` apenas como alias de entrada durante a migracao; normalizar internamente para o modo novo.

## Fluxo deterministico

### 0. Preflight unico

1. Resolver repositorio, issue, branch, PR, base, instrucoes locais e permissoes.
2. Classificar uma unica vez a capacidade de execucao como `local-git`, `connector-only` ou `artifact-bundle`. Se checkout/dependencias nao estiverem utilizaveis, nao repetir clone, instalacao ou tentativa equivalente sem evidencia nova de que o impedimento mudou.
3. Criar contexto, manifesto de fontes, baseline, ledger e inventario de workflows uma unica vez.
4. Capturar `observed_head_before_work` e reutilizar descoberta quando os fingerprints continuarem validos.
5. Nao perguntar novamente por informacao ja disponivel na conversa, repositorio, issue ou auditoria imediatamente anterior.

### 1. Readiness e contrato

1. Derivar requisitos testaveis, criterios, caminhos e riscos. Separar explicitamente comportamento de invariantes estruturais: `must_not`, `must_reuse`, `must_be_single_source`, `must_not_depend_on`, `precedence_invariants` e `forbidden_implementation` quando presentes.
2. Invocar `revisar-issue` somente quando faltar decisao material capaz de produzir implementacoes divergentes.
3. Construir snapshot e fechamento uma vez. Recalcular somente por mudanca material.
4. Produzir `requirement-closure.json` com prova esperada para cada requisito antes de editar e validar que nenhum candidato extraido das fontes canonicas desapareceu do fechamento.
5. Para cada requisito material, formular antes da implementacao uma `plausible_wrong_implementation` que passaria no caminho feliz e derivar a familia de ataque e todas as `risk_surfaces` tecnicamente acessiveis correspondentes.
6. Inicializar `requirement-attack-matrix.json`; consultar `audit-escape-pattern-catalog.json` e ativar padroes anteriores cujos sinais aparecam no contrato atual, carregando `required_attack_dimensions` como piso de cobertura e ampliando-o quando a arquitetura atual expuser novas superficies.
7. Se o contrato contiver `continua valido/acessivel`, `revalidar`, `apos aprovacao`, `no momento de release/execucao` ou equivalente, ativar `reference-liveness`. Se contiver `futuro`, `passado`, `semana`, `periodo`, `vigencia` ou data de destino, ativar o gate temporal mesmo sem calculo.

### 2. Plano unico

Executar `scripts/plan_execution.py` uma vez com contexto, requisitos, caminhos, plano anterior e work items.

O plano deve:

- separar fingerprints de fontes, baseline, workflows, politica, permissoes e identidade;
- manter `implementation_scope` separado de `produced_diff`;
- atribuir `write_owner` unico por caminho;
- produzir `run`, `reuse-candidate`, `not-applicable` ou `conditional` para especialidades;
- incluir `work_item_fingerprint` em toda remediacao;
- ignorar timestamps e telemetria para invalidacao.

O diff da propria implementacao atualiza evidencia e gates descendentes, mas nao transforma automaticamente a implementacao em `run` novamente.

### 3. Implementar internamente

Seguir `references/implementation-workflow.md`.

1. Alterar o menor conjunto coeso que entregue o comportamento ponta a ponta.
2. Executar validacoes focadas durante a edicao.
3. Fechar cada requisito com arquivos, comportamento, teste positivo, `risk_surfaces`, controle negativo primario por superficie e regressao e registrar tudo em `requirement-attack-matrix.json`. Para requisito estrutural, executar tambem o gate de `references/structural-invariant-gate.md`; resultado publico correto nao substitui a prova da forma de implementacao exigida.
4. Para referencias usadas em etapa posterior, executar `REF-LIVE-001` e caso irmao aplicavel; para destinos temporais, executar os controles `TEMP-PERIOD-001`/`TEMP-DEST-001` quando aplicaveis.
5. Descobrir todos os erros baratos relacionados antes de devolver a rodada; depois do primeiro finding, percorrer tambem requisitos/familias ainda sem controle discriminante para colher blockers independentes baratos no mesmo ciclo.
6. Atualizar documentacao simples por delta no mesmo recorte.
7. Permanecer em correcao enquanto houver falha executavel, requisito sem prova, familia de risco material nao saturada ou controle herdado nao executado.

### 4. Higiene interna limitada

Aplicar `references/hygiene.md` somente depois da implementacao funcional e antes do gate final.

- Inspecionar apenas arquivos tocados e consumidores diretos.
- Corrigir somente duplicidade, codigo morto, dependencia sem uso ou complexidade introduzida/agravada pela entrega.
- Aceitar `no-change` sem chamada externa.
- Nao iniciar refatoracao ampla, reformatacao global ou melhoria opcional.
- Reexecutar apenas checks invalidados pelo safe-fix.

### 5. Especialidades condicionais

Seguir `references/domain-delegation.md`.

- `design-interface`: acionar uma vez por fingerprint quando houver mudanca visual, navegacao, responsividade, acessibilidade ou estado operado pelo usuario.
- `fluxos-conversacionais`: acionar uma vez por fingerprint quando houver continuidade persistida, callbacks, filas, retry, idempotencia, expiracao, cancelamento ou concorrencia.
- `documentacao-repositorio`: acionar somente para reorganizacao ampla, ADR/runbook/API, contradicao global ou impacto documental que exceda o delta local.

Canonicalizar pedidos por `skill + requirements + paths + input_fingerprint`. Para `reuse-candidate`, verificar hash, identidade, resultado e artefato antes de pular a chamada.

### 6. Gate final e freeze

1. Executar uma unica vez o conjunto final exigido pelo perfil com `scripts/run_attested_gate.py`.
2. Exigir working tree limpa, comandos, cwd, SHA, tempos, exit code e hashes.
3. Executar gate adversarial interno proporcional ao risco e controles especializados aplicaveis. Para requisitos estruturais/canonicos, executar `CANON-DIVERGENCE-001` quando houver caminho especializado e canonico; para qualquer semantica temporal de calculo ou destino, aplicar `references/temporal-consistency-gate.md`; para referencias entre etapas, aplicar `references/reference-liveness-gate.md`; para remediacao de `audit_escape`, executar todos os controles herdados e casos irmaos de `references/audit-escape-closure.md`.
4. Executar `validate_specification_coverage.py`, `validate_requirement_attack_matrix.py`, `validate_risk_saturation.py` e `validate_inherited_controls.py` sobre o SHA final. A matriz de risco deve explicitar inclusive familias `not-applicable` e, para cada familia aplicavel, todas as superficies materiais com controles correspondentes.
5. Fazer blocker-harvest final barato: varrer todos os requisitos atômicos e familias canonicas ainda sem ataque, mesmo que um blocker anterior ja torne o candidato reprovavel.
6. Congelar o **material head SHA** somente depois de requisitos, documentacao, especialidades, controles de escape, controles herdados, matriz de ataques, saturacao e gates estarem favoraveis. O commit posterior que contenha somente o pacote de handoff autorizado nao muda essa identidade material.
7. Se houver finding, criar work items agrupados por causa e invalidar apenas descendentes afetados.

### 7. Remediacao eficiente

1. Agrupar findings relacionados pela mesma causa raiz.
2. Quando a entrada vier de auditoria estruturada imediatamente anterior, validar a identidade uma vez e converter findings com ID, severidade, causa e remediacao em work items sem redescobrir requisitos nao afetados.
3. Executar todos os checks baratos que possam revelar erros irmaos antes de iniciar nova edicao.
4. Nao repetir comando ou mudanca sem nova hipotese, input alterado ou evidencia adicional.
5. Incrementar ciclo somente depois de verificacao que exija nova implementacao.
6. Se o mesmo fingerprint reaparecer, parar tentativa cega e executar causa raiz.
7. Antes de parecer interno favoravel, executar novamente o gate final completo sobre o SHA final.
8. Se uma auditoria independente encontrou finding bloqueante em candidato antes aprovado internamente, nao reenviar para nova auditoria ate fechar a **classe do escape**: reproduzir o caso literal, enumerar e executar casos irmaos baratos, adicionar teste preventivo, registrar controle adversarial reutilizavel e fortalecer prevencao + deteccao. Corrigir somente o sintoma nao satisfaz a rodada.
9. Produzir `audit-escape-closure.json` para cada escape e exigir `status=passed` mais `required_attack_dimensions` cobertas no novo SHA; incorporar cada `escape_class`, suas superficies/dimensoes obrigatorias em `audit-escape-pattern-catalog.json` e seus controles em `inherited-controls.json` antes de novo freeze/handoff.
10. Reexecutar cumulativamente no novo SHA todos os controles herdados ainda aplicaveis de auditorias anteriores, nao apenas os findings da ultima auditoria.
11. Para toda rejeicao independente, produzir `learning-closure.json`. Classificar `implementation-only` ou `systemic-escape`; para escape sistemico, promover somente regra generica com dois casos de transferencia sinteticos, mudancas de prevencao/deteccao e testes de contrato.
12. Quando houver alteracao permanente de Skill, executar `scripts/validate_skill_genericity.py`; teste numerado por issue ou regra historica derivada de issue bloqueia o ciclo.
13. Depois da remediacao, repetir a saturacao completa das familias afetadas e a colheita barata de blockers antes de consumir outra auditoria independente. Fingerprints iguais sem nova evidencia exigem causa raiz, nao nova tentativa cega.

### 8. Remoto e handoff

1. Carregar a politica remota somente nesta etapa.
2. Reconsultar o head imediatamente antes de escrever. Se divergir de `observed_head_before_work` por mudanca externa, nao aplicar patch obsoleto nem mover a branch para tras; reconciliar somente o delta e invalidar apenas evidencias dependentes.
3. Quando houver mais de um arquivo da mesma rodada e a API Git permitir arvore/commit, publicar atomicamente em um unico commit (`blob/tree/commit/ref`). Evitar `create_file`/`update_file` sequenciais que produzam um SHA por arquivo. Excecao: separar no maximo o commit material e um commit posterior exclusivamente de resultados quando o resultado precisar referenciar o SHA material testado.
4. Publicar apenas o candidato congelado e localmente verde; mover a ref uma unica vez por rodada material.
5. Observar somente runs existentes gerados automaticamente. Fazer no maximo uma coleta de estado remoto por SHA candidato dentro da mesma rodada; ler jobs, steps, logs e artefatos do run observado faz parte desse mesmo snapshot e nao conta como polling. nunca fazer polling, `sleep`, espera ativa, rerun ou dispatch para aguardar CI.
6. Classificar imediatamente o estado remoto observado:
   - sem run elegivel: registrar `remote_gate=pending-no-run`, preservar o material head e continuar para publicacao do handoff; o retorno pode manter pendencia remota, mas nunca omitir o `result-only-child`;
   - run `queued`, `in_progress`, `waiting` ou equivalente: registrar o estado observado e continuar para publicacao do handoff sem polling;
   - run `completed/success`: registrar evidencia exact-head e continuar para handoff;
   - run `completed` com falha: consultar jobs, steps e logs existentes, agrupar erros pela causa raiz e classificar cada causa como `actionable-delivery`, `external-infrastructure` ou `unrelated-preexisting`.
7. Para `actionable-delivery`, criar finding/work item estruturado sem pedir novo prompt ao usuario e retornar imediatamente a `### 7. Remediacao eficiente`. Corrigir todas as falhas irmas baratas da mesma causa, reexecutar checks focados e o gate final afetado, congelar um novo SHA e publicar novo candidato. O novo SHA recebe sua propria unica coleta de estado remoto.
8. Para `external-infrastructure`, nao alterar codigo por tentativa; registrar `remote_gate=blocked-external` com job, step, trecho de log e impedimento. Para `unrelated-preexisting`, registrar baseline/evidencia e nao mascarar nem corrigir fora do escopo.
9. Uma invocacao futura pode recolher novamente o mesmo SHA que antes estava pendente e reutilizar implementacao/gates locais validos se identidade, inputs materiais e hashes permanecerem compativeis.
10. Reconsultar identidade uma vez antes do handoff e distinguir `material_head_sha` de eventual `handoff_head_sha`. Se houver mudanca fora de um result-only child autorizado, marcar qualquer certificado anterior como stale e executar o fast path `post-ci-refreeze`; nao aceitar CI verde como substituto dessa reconciliacao.
11. Produzir pacote neutro com contrato, diff, codigo, testes, manifests e evidencias brutas; nao incluir conclusao que contamine auditoria independente.
12. Antes do handoff, executar `scripts/validate_specification_coverage.py` e `scripts/validate_handoff_readiness.py`; quando houver reprovacao independente anterior, exigir tambem `audit-escape-closure.json` e `learning-closure.json` validados. Qualquer bloqueio impede novo handoff.
13. Gerar `.audit/entregar-issue/handoff-ready.json` exclusivamente por `scripts/build_handoff_certificate.py`, vinculando o **material head**, base/material merge preview, versao contratual, hash da Skill produtora, hashes dos validadores e hashes de todos os artefatos de readiness.
14. Publicar o pacote completo `.audit/entregar-issue` em um unico commit filho de resultados. Validar que `parent(handoff_head_sha) == material_head_sha` e que `material_head_sha..handoff_head_sha` altera somente `certificate_commit_policy.allowed_paths`. Em `connector-only`, seguir obrigatoriamente `references/connector-only-handoff.md`.
15. Se a base trouxer pacote stale de outra entrega, substituir esse pacote no mesmo commit de resultados; nao publicar uma rodada que somente o remova.
16. Reconsultar o head remoto **depois** da publicacao e executar `scripts/validate_terminal_handoff.py` com os metadados remotos atuais. O gate exige `handoff_head_sha != material_head_sha`, `parent(handoff_head_sha) == material_head_sha`, `handoff-ready.json` presente no commit e nenhum path fora da allowlist. Se falhar e o material head continuar estavel, reconstruir/publicar o handoff uma unica vez pelo fast path `handoff-only`; se ainda falhar por impedimento real do connector/runtime, encerrar bloqueado e nao sugerir auditoria.
17. Encaminhar para `auditar-issue` em contexto separado somente quando a auditoria puder confirmar ataques ja exercitados e o `handoff-ready.json` estiver consumivel no **head remoto atual**. Se existir `audit_escape` aberto, familia material nao saturada, requisito sem ataque, controle herdado `not-run/failed`, requisito estrutural sem closure, aprendizado sistemico nao promovido, certificado ausente/stale ou gate terminal de handoff falho, encerrar como pendencia interna e nao consumir outra auditoria independente.
18. Passar toda saida por um unico **finalizador universal de identidade**. Este finalizador e obrigatorio mesmo quando a ultima alteracao foi apenas teste, documentacao, formatacao, artefato de diagnostico fora da allowlist ou remediacao acionada depois de um handoff anterior. Reconsultar o remoto no final, comparar `current_head`, `material_head_sha` e `handoff_head_sha`, executar `validate_terminal_handoff.py` quando houver handoff e, se houver drift material, voltar automaticamente ao fast path `post-write-refreeze` antes de qualquer resposta terminal.

## Fast paths

- Retorno pos-CI: ao receber `return_control_to=entregar-issue` + `reason=post-ci-refreeze`, nao redescobrir a issue nem refazer trabalho comprovadamente independente do delta. Comparar os SHAs materiais, invalidar gates/atestacoes por dependencia, revalidar o novo material head, refazer freeze, gerar o certificado e publicar novo result-only child. Um filho que altere somente os caminhos autorizados do pacote de handoff nao e drift material.
- Pos-escrita generico: se qualquer commit material aparecer depois de um certificado anterior, independentemente de ter vindo de CI, remediacao, teste, documentacao ou outra Skill de escrita, tratar como `post-write-refreeze`. Reusar o mesmo algoritmo do `post-ci-refreeze`, mas sem exigir que a causa tenha sido CI. Este fast path e obrigatorio antes de liberar nova auditoria.
- Recuperacao de handoff: ao receber `return_control_to=entregar-issue` + `reason=handoff-not-produced|handoff-stale` sem finding funcional e com material head estavel, nao reabrir implementacao. Reconstruir/validar o pacote, gerar o certificado e publicar um unico result-only child; somente mudanca material do head invalida esse fast path.
- Remediacao de auditoria: com findings estruturados e identidade ainda compativel, usar os findings como work items prontos, recalcular somente closures/gates afetados e nao repetir readiness, descoberta ampla ou requisito ja comprovado.
- Ambiente sem checkout executavel: selecionar `connector-only` ou `artifact-bundle` no preflight; nao repetir clone/instalacao falhos sem mudanca material do ambiente. `connector-only` deve executar o handoff por materializacao efemera e publicacao via connector; se isso nao for possivel, bloquear antes de chamar auditoria.
- CI ainda inexistente ou pendente no SHA material: coletar o estado uma vez, registrar `pending-no-run`/estado pendente, **publicar e validar o handoff terminal mesmo assim**, e somente depois encerrar com pendencia remota; nao esperar por evento futuro dentro da mesma invocacao. CI `completed/failure` nao e espera: ler jobs/steps/logs existentes, transformar causa acionavel em work item e remediar sem novo prompt; novo SHA permite nova coleta unica.
- Publicacao multi-arquivo: preferir commit atomico unico; permitir commit de resultados separado somente quando a evidencia precisar apontar para o SHA material.
- Mudanca semantica ausente: validar hashes e identidade e reutilizar plano/gates/handoff.
- Documentacao ou assets isolados: perfil `light`, sem higiene de runtime nem suite ampla.
- Config/schema sem codigo elegivel: manter gates comportamentais, higiene `not-applicable`.
- Testes ou gerados apenas: executar gates que comprovem o comportamento afetado; nao iniciar higiene por padrao.
- Finding novo nos mesmos arquivos: alterar `work_item_fingerprint`; igualdade de caminhos nao autoriza reutilizacao.

## Saida

Declarar exatamente um estado:

- `aprovado-operacionalmente-sem-ressalvas`: somente com auditoria independente valida recebida;
- `aprovado-internamente-pendente-auditoria-independente`;
- `limite-atingido-com-pendencias`;
- `bloqueado-por-impedimento-real`.

Nunca afirmar independencia apenas por trocar de Skill no mesmo contexto. Entregar requisitos fechados/abertos, arquivos, comandos, evidencias, findings agrupados, SHA congelado, estado remoto e proximo gate real.

## Contrato canonico

Usar `contract_version=2026-08-06.2`. Tratar `contracts/` desta Skill como fonte canonica. Copias em outras Skills sao geradas. Executar `scripts/controller_cli.py validate-contracts` e os testes focados antes do pacote final.
