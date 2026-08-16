# Fluxo otimizado e checkpoints

## Checkpoints

1. `preflight-complete`;
2. `contract-frozen`;
3. `implementation-complete`;
4. `pre-freeze-clean`;
5. `candidate-frozen`;
6. `internal-gate-complete`;
7. `remote-gate-complete`;
8. `handoff-ready`.

## Retomada

Retomar do primeiro checkpoint invalidado. Nao repetir fase por troca de Skill, mensagem ou timestamp de observacao.

## Plano schema 2

Gerar `execution-plan.json` uma vez no controlador com fingerprints de fontes, baseline, workflows, politica, permissoes, identidade material e work items. Em modo controller, validar e consumir esse plano; nao gerar outro equivalente. Telemetria e `identity.observed_at` nao alteram fingerprints. `controller_revision` sinaliza mudanca global, mas nao invalida todas as etapas.

Consumir `skill_plan` para carregar apenas Skills necessarias. Confirmar cada `reuse-candidate` pelo envelope e artefato; a ausencia do resultado exige execucao. Preservar os caminhos da entrada de modulo interno de implementacao como `implementation_scope`; o diff observado apos a edicao nao muda esse fingerprint.

## Invalidacao dirigida

- fonte/requisito: contrato e descendentes;
- work item: implementacao e descendentes;
- escopo planejado: implementacao e descendentes;
- diff observado/classificacao: documentacao, dominios, higienizacao e gates posteriores, sem reabrir a implementacao que gerou o diff;
- baseline: gate final e descendentes;
- workflow inventory: remoto, auditoria e decisao;
- head: gate final/freeze/remoto/auditoria/decisao;
- base/merge preview: remoto/auditoria/decisao;
- observacao com mesmos SHAs: nenhuma etapa.

## Metricas

Registrar leituras completas, scans documentais, chamadas de subskill, suites, freezes, coletas, reutilizacoes e invalidacoes evitaveis. Agrupar atualizacoes por `refresh-context --metric` quando ocorrerem junto da atualizacao de contexto.

## Ordem de custo

Executar contrato e checks estaticos antes de processos caros. Durante a edicao, rodar apenas testes focados da fatia. Rodar suite final, freeze, auditoria e pacote somente quando nao houver blocker barato ou requisito local aberto.
