# Gate remoto por SHA

## Coleta

Usar `collect_remote_gate.py` em modo somente leitura. O script deve consultar o GitHub por `gh api` ou REST autenticada, guardar payloads brutos paginados, timestamps, hash do proprio coletor e hashes dos payloads. Campos derivados de estado remoto nao devem ser preenchidos manualmente. `--fixture-dir` existe somente para testes e snapshots com `source=fixture` nao podem aprovar um gate real. Nao disparar, reexecutar, cancelar ou aprovar workflow durante a coleta.

Coletar e reconstruir:

- PR antes e depois: head, base, estado, mergeabilidade e merge preview;
- todos os runs do SHA antes e depois;
- jobs e steps de cada workflow aplicavel;
- artefatos de todos os runs bem-sucedidos do SHA e seus ZIPs;
- handoff rastreavel da issue na PR.

Depois das validacoes locais, `validate_internal_gate.py` deve consultar novamente o GitHub. Essa reconsulta seleciona novamente o ultimo run elegivel por workflow, inspeciona jobs, steps, inventario e conteudo dos artefatos e o handoff. Novo run falho, pendente, substituto ou divergente invalida o resultado.

## Sem espera ativa

A coleta remota e snapshot, nao monitoramento. Para cada SHA candidato, executar no maximo uma coleta de estado depois da publicacao/freeze dentro da mesma rodada. Ler jobs, steps, logs e artefatos pertencentes ao run retornado faz parte do diagnostico desse snapshot e nao e polling. Se workflow aplicavel ainda nao possuir run elegivel, registrar `pending-no-run`; se o run existir mas estiver `queued`, `in_progress`, `waiting` ou equivalente, registrar o estado observado. Nesses casos encerrar a espera remota, **continuar a finalizacao do handoff** e somente depois responder com pendencia remota. Nao fazer polling, `sleep`, backoff, loop de consulta, rerun ou dispatch para transformar estado futuro em evidencia da invocacao atual.

Uma invocacao posterior pode recolher novamente o mesmo SHA e reutilizar evidencia local se head, base, merge preview, hashes e inputs materiais continuarem compativeis. Uma correcao material cria novo SHA candidato e, portanto, novo snapshot remoto permitido.

## Falha remota concluida

`completed/failure` nao e pendencia temporal. Quando um workflow aplicavel do SHA candidato terminar com falha:

1. consultar jobs do run observado;
2. identificar jobs e steps falhos;
3. ler somente os logs existentes necessarios para causa raiz;
4. agrupar erros irmaos e classificar cada causa como `actionable-delivery`, `external-infrastructure` ou `unrelated-preexisting`;
5. para `actionable-delivery`, produzir finding com workflow/run/job/step, mensagem discriminante, paths/requisitos afetados e `work_item_fingerprint`, invalidar somente evidencias descendentes e retornar a remediacao na mesma invocacao, sem pedir novo prompt;
6. para `external-infrastructure`, registrar `remote_gate=blocked-external` e nao alterar codigo por tentativa;
7. para `unrelated-preexisting`, vincular a baseline comprovada e nao ampliar o escopo;
8. nunca fazer rerun ou dispatch para testar a hipotese; validar a correcao localmente, executar gate final afetado e publicar novo SHA somente quando houver mudanca material.

## Proveniencia reconstruivel

Cada payload bruto deve registrar label conhecida, endpoint exato, caminho, hash e horario. O validador deve reconstruir PR, runs, jobs, handoff e artefatos a partir desses arquivos e comparar com o snapshot. Declarar `source=gh-api` ou guardar `{}` nao comprova coleta.

## Base e merge preview

Exigir:

- `head_sha_before == head_sha_after == SHA congelado`;
- `base_sha_before == base_sha_after == metadata.base_sha`;
- `merge_preview_sha_before == merge_preview_sha_after` e nao vazio;
- base ref igual a da PR;
- mergeabilidade resolvida e ausencia de conflito.

Mudanca da base ou do merge preview invalida o ciclo mesmo quando o head permanece igual.

## Workflows

Inventariar todos os arquivos `.github/workflows/*.yml|yaml` ja existentes. YAML malformado reprova; nunca equivale a workflow nao aplicavel. Nao criar ou alterar workflow para satisfazer este gate, gerar artefato ou obter novo run.

Interpretar somente filtros no escopo de `on.pull_request` e `on.pull_request_target`:

- `branches` e `branches-ignore` contra a branch-base da PR;
- `paths` e `paths-ignore` contra o diff congelado;
- padroes negativos na ordem do GitHub Actions.

Uma chave `paths` dentro de jobs, strategy ou matrix nao e filtro de PR.

Para cada workflow de PR:

- determinar aplicabilidade ao diff e a branch-base;
- workflow aplicavel exige o ultimo run elegivel no SHA com evento `pull_request` ou `pull_request_target`;
- exigir `completed/success`, ao menos um job, steps nao vazios e conclusoes aceitaveis;
- `workflow_dispatch` nunca substitui o run obrigatorio de PR e nao deve ser disparado pela Skill;
- workflow nao aplicavel exige justificativa e evidencia;
- se nenhum workflow for aplicavel, registrar `no_applicable_pr_workflows=true` com evidencia, sem run ficticio e sem criar workflow;
- se um run existente estiver aguardando aprovacao manual, registrar `manual-approval-pending`, nao solicitar aprovacao e nao criar substituto.

## Artefatos remotos

Coletar artefatos produzidos por runs existentes como evidencia adicional. Nao criar ou alterar workflow apenas para publicar artefato.

Artefato remoto e obrigatorio somente quando o perfil declarar explicitamente `audit_packet_published=true`; nesse caso, exigir kind `audit-manifest`. Evidencias visual, de persistencia, migration e documentacao devem ser produzidas e atestadas localmente e podem ser complementadas por artefatos remotos ja existentes.

Cada artefato considerado deve pertencer a run concluido com sucesso no SHA final e possuir digest GitHub. O run pode usar outro evento somente quando o artefato nao estiver substituindo workflow obrigatorio de PR.

O ZIP deve conter exatamente um `orquestrador-artifact.json`, `schema_version: 2`, com:

- kind, `head_sha`, run ID, artifact ID, gerador e timestamp;
- checks estruturados com IDs e claims;
- resultados internos nao vazios;
- caminho, SHA-256, tamanho, comando, exit codes, media type e IDs dos checks de cada resultado;
- ligacao bidirecional entre checks e resultados.

O coletor reabre o ZIP e recalcula tudo. Nome, heuristica, texto autodeclarado ou `--artifact-kind` nunca atribuem significado.


## Independencia entre CI pendente e handoff

O pacote de readiness certifica o material head e nao exige que um workflow futuro ja tenha terminado. Portanto `pending-no-run`, `queued`, `in_progress` e `waiting` nunca justificam ausencia de `.audit/entregar-issue/handoff-ready.json`. O estado do CI deve ser registrado no handoff e reavaliado como gate remoto; a publicacao do result-only child continua obrigatoria.
