# Politica de GitHub Actions e publicacao

## Padrao seguro

Tratar GitHub Actions como evidencia remota somente leitura. Inventariar workflows versionados, consultar runs e baixar artefatos existentes, sem alterar configuracao remota nem fabricar uma nova execucao.

Propagar por padrao:

```json
{
  "workflow_change_authorized": false,
  "manual_approval_workflow_authorized": false,
  "remote_action_mode": "observe-only",
  "publish_policy": "single-final-candidate"
}
```

## Orcamento de publicacao

- Manter diagnostico, implementacao, testes focados, remediacao e gate final no ambiente local.
- Publicar somente depois de o candidato estar localmente verde e congelado.
- Permitir nova publicacao apenas quando um finding remoto ou de auditoria exigir mudanca material no codigo, teste ou configuracao da issue.
- Proibir commit vazio, amend sem mudanca material, push de sincronizacao, troca artificial de SHA e publicacao por subskill.
- Reconsultar o GitHub quantas vezes forem necessarias nao cria novo run e nao consome publicacao.

## Workflows

- Nao criar, editar, duplicar, renomear ou remover `.github/workflows/*` para satisfazer cobertura, gerar artefato, executar smoke, obter check verde ou contornar ausencia de CI.
- Permitir mudanca de workflow somente quando a issue incluir explicitamente CI/GitHub Actions no escopo e houver autorizacao explicita para essa classe de arquivo.
- Mesmo quando autorizada a mudanca de CI, nao criar `workflow_dispatch`, GitHub Environment, deployment gate ou job que dependa de aprovacao manual do usuario.
- Nao usar `pull_request_target` para executar codigo do head da PR.

## Acoes remotas proibidas

Nao disparar, reexecutar, cancelar ou aprovar workflow; nao aprovar environment/deployment; nao alterar secrets, variables, branch protection, required checks ou permissoes. A coleta remota deve usar apenas operacoes de leitura.

## Falha remota concluida

Um run `completed/failure` aplicavel ao SHA congelado e finding, nao estado de espera. Consultar jobs, steps e logs existentes desse run em modo somente leitura, agrupar a causa raiz e classificar:

- `actionable-delivery`: erro causado pelo candidato e corrigivel no escopo; retornar ao controlador como work item e remediar sem novo prompt;
- `external-infrastructure`: runner, servico, credencial/segredo fora do escopo, rate limit ou dependencia externa; registrar impedimento e nao alterar codigo por tentativa;
- `unrelated-preexisting`: falha comprovadamente anterior e fora do diff; vincular baseline e nao mascarar o gate.

A remediacao de `actionable-delivery` autoriza nova publicacao material depois de validacao local e novo freeze. O novo SHA pode receber uma nova unica coleta de estado remoto. Continuam proibidos rerun, dispatch, cancelamento, aprovacao e qualquer alteracao remota destinada a fabricar evidencia.

## Checks aguardando aprovacao

Quando um workflow existente estiver aguardando aprovacao manual:

1. registrar `manual-approval-pending`;
2. nao pedir aprovacao ao usuario;
3. nao criar workflow alternativo;
4. usar evidencias locais e runs existentes para a pre-auditoria;
5. limitar o veredito ao nivel de garantia comprovado, normalmente `INTERNALLY_APPROVED`, se o check for necessario para liberacao operacional.

## Provider e credenciais

Nao criar smoke de PR com credenciais reais. Provar comportamento com testes hermeticos, fake server, contract tests, replay sanitizado ou smoke local sem segredo. Um smoke remoto protegido ja existente pode ser observado como evidencia adicional, mas nunca disparado ou tornado obrigatorio pela Skill quando nao fizer parte do contrato da issue.
