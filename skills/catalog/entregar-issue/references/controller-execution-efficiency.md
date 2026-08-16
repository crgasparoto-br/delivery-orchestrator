# Eficiencia de execucao

## Regra central

Usar um unico controlador, plano e estado. Implementacao, documentacao por delta, higiene, gates e remediacao sao etapas internas de `entregar-issue`, nao chamadas de Skills.

## Custos proibidos

- recalcular o mesmo plano sem input material novo;
- reler integralmente issue, diff ou documentacao quando o manifesto vigente cobre a etapa;
- transformar o diff produzido em invalidacao da propria implementacao;
- executar suite completa durante ajustes intermediarios;
- criar handoff entre etapas internas;
- chamar uma especialidade para checklist simples;
- revelar um finding barato por ciclo quando erros irmaos podem ser agrupados;
- repetir clone, instalacao de dependencias ou materializacao de checkout depois que o mesmo impedimento foi comprovado e nenhuma evidencia material mudou;
- publicar uma mesma rodada multi-arquivo como uma sequencia de commits por arquivo quando a API suporta commit atomico;
- fazer polling, `sleep` ou consultas repetidas esperando workflow futuro aparecer ou concluir.

## Fingerprints

Separar:

- `implementation_scope`: caminhos planejados para a edicao;
- `produced_diff`: saida observada, usada por documentacao, dominios, higiene e gates descendentes;
- `work_item_fingerprint`: causa/remediacao que reabre implementacao;
- identidade material: head, base e merge preview;
- fontes, baseline, workflows, politica e permissoes.

Timestamps e telemetria nao invalidam trabalho.

## Validacao

Durante edicao, executar checks focados. Executar gate final completo uma vez antes do freeze e novamente somente depois de correcao material que invalide esse gate.

## Delegacao

`skill_plan` contem apenas Skills externas. `internal_plan` contem implementation, documentation-delta e hygiene. Uma especialidade externa e acionada no maximo uma vez por fingerprint e recebe write ownership exclusivo.

## Orcamento de espera remota

Depois do freeze/publicacao, fazer no maximo uma observacao de estado de CI por SHA candidato dentro da mesma rodada. Ler jobs, steps, logs e artefatos do run ja observado e diagnostico, nao polling. Se um workflow aplicavel nao tiver run elegivel, registrar `pending-no-run`; se o run estiver `queued`, `in_progress`, `waiting` ou equivalente, registrar o estado observado. Esses estados encerram a **espera remota**, mas nao a fase de finalizacao: publicar e validar o `result-only-child` de handoff antes de responder. Uma invocacao futura pode recolher novamente o mesmo material head e reutilizar as atestacoes locais enquanto identidade, inputs materiais e hashes permanecerem validos.

`completed/failure` nao e estado de espera. Quando um run aplicavel terminar com falha, coletar jobs/steps/logs existentes, agrupar erros pela causa raiz e classificar como `actionable-delivery`, `external-infrastructure` ou `unrelated-preexisting`. Causa `actionable-delivery` reabre remediacao imediatamente, sem novo prompt, e uma correcao material produz novo SHA com novo orcamento de uma observacao. Nao usar rerun/dispatch para validar hipotese.

## Publicacao atomica

Quando uma rodada altera varios arquivos por GitHub API, preparar todos os blobs e uma unica tree/commit antes de mover a ref. Usar commits sequenciais somente quando houver dependencia semantica de SHA entre fases; nesse caso limitar a duas fases: commit material e commit exclusivamente de resultados/evidencia. Nunca usar commits por arquivo como mecanismo normal de edicao.

## Fast path de auditoria

Se uma auditoria imediatamente anterior ja forneceu findings estruturados e a identidade ainda e compativel, consumir esses findings como work items. Revalidar apenas o delta de identidade e os requisitos/gates afetados; nao repetir discovery, readiness ou decomposicao integral da issue.

## Estabilidade do head

Capturar o head no preflight e reconsulta-lo imediatamente antes da escrita. Mudanca externa exige reconciliacao do delta, nao force-push para restaurar SHA antigo. Depois da publicacao atomica, tratar o novo head como unico candidato da rodada.


## Barreira terminal de handoff

Depois de existir material head congelado e localmente pronto, todo caminho de retorno passa pela mesma barreira terminal: gerar certificado, publicar o filho somente de resultados, reconsultar o head remoto e validar parent, allowlist e presenca de `handoff-ready.json`. Estado de CI pendente pode limitar a conclusao operacional, mas nao pode produzir uma branch sem handoff consumivel. Se a barreira nao puder ser satisfeita, o resultado e bloqueio interno de publicacao de handoff e nao convite para auditoria.
