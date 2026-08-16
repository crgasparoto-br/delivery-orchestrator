# Handoff para auditoria independente

## Condicoes

Somente emitir `pronto para auditoria independente` quando:

- estado canonico, pacote, plano, evidencias, snapshot remoto e gate usam a mesma identidade;
- base, head e merge preview permanecem estaveis;
- todos os workflows de PR aplicaveis e automaticamente executados terminaram com sucesso no ultimo run elegivel, ou a ausencia de workflow aplicavel foi atestada;
- jobs e steps foram inspecionados;
- artefatos obrigatorios estao presentes e verificaveis;
- nenhum achado permanece aberto;
- `validate_internal_gate.py` retornou zero e concluiu a reconsulta remota final.

## Conteudo

Informar:

- repositorio, issue, branch, PR e base;
- `head_sha`, `base_sha` e `merge_preview_sha`;
- ciclo e `implementation_context_id`;
- hashes do pacote, plano, snapshot, metricas e gate report;
- requisitos, evidencias, familias e cenarios;
- riscos detectados e overrides;
- limitacoes do grafo de runtime;
- workflows, runs, jobs, steps e artefatos;
- local do registro de auditores confiados, sem expor chave privada;
- ausencia de aprovacao independente vigente.

Incluir exatamente a orientacao:

```text
ABRA UMA NOVA CONVERSA. Nao execute o comando abaixo nesta conversa.
@Auditar Issue <numero> no repositorio <owner/repo>, PR <numero>, SHA <head_sha>, base SHA <base_sha>, merge preview <merge_preview_sha>, ciclo <ciclo> e implementation_context_id <id>. Valide todas as identidades antes e depois, produza external-audit.json assinado e trate a nova conversa como contexto independente da implementacao.
```

A auditoria deve seguir [external-audit.md](external-audit.md). Um bloco textual de handoff nao substitui o JSON assinado.

## Excecao para controlador de chamada unica

Quando `controller_mode=delivery-single-invocation`, nao incluir a orientacao para abrir nova conversa na resposta ao usuario. Gerar o mesmo dossie como `controller-handoff.json`, marcar `data.controller_disposition=ready-for-controller-audit` e devolver o controle ao `entregar-issue`. O estado canonico pode permanecer `pronto-para-auditoria-independente`, mas esse estado nao e terminal para o controlador.

## Manifesto v5

Incluir no handoff caminhos e hashes de `execution-context`, `specification-snapshot`, `requirement-closure`, `risk-profile`, `documentation-impact`, `gate-report`, `applicability-ledger`, `cycle-history` e `remote-gate` quando aplicavel. Incluir tambem classificacao de todos os arquivos alterados e resultados de subskills exigidas por cada familia de risco.

## Aprovacao manual externa

Quando um workflow existente estiver em `manual-approval-pending`, nao pedir aprovacao ao usuario e nao criar alternativa. Registrar a limitacao no handoff e restringir o estado ao nivel de evidencia comprovado.
