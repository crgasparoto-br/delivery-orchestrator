# Loop de observacao de CI

## Proposito

Garantir que `corrigir-ci` permaneça dono do ciclo remoto ate um estado terminal comprovado em qualquer repositorio GitHub, sem gerar carga desnecessaria ou commits artificiais.

## Identidade

A unidade de observacao e sempre `(repository_full_name, PR/branch, head_sha)`. Qualquer mudanca de head invalida o estado remoto anterior e inicia uma nova rodada de observacao.

Nunca carregar identidade de outro repositorio apenas porque ele foi usado em uma execucao anterior da skill.

## Cadencia

- Preferir intervalos moderados entre observacoes quando houver mecanismo de espera no ambiente.
- Como referencia, usar aproximadamente 15-30 segundos para jobs curtos e 30-60 segundos para suites longas.
- Nunca consultar continuamente sem intervalo apenas para acelerar o resultado.
- Ler jobs/logs repetidamente somente quando o run ou attempt mudou; enquanto apenas o status temporal muda, uma consulta de estado e suficiente.
- Nao encerrar voluntariamente por `queued`, `waiting`, `in_progress` ou ausencia momentanea de run.

## Run inexistente

Um push pode preceder a criacao do run. Quando nao houver run para o SHA:

1. confirmar que o SHA ainda e o head;
2. aguardar;
3. consultar novamente;
4. continuar ate o run aparecer ou surgir um impedimento real de trigger.

Nao criar commit vazio para provocar um novo run.

## Run em andamento

Para `queued`, `waiting` ou `in_progress`, aguardar e reconsultar. Nao produzir conclusao final intermediaria.

## Run terminal

- `success`: verificar os demais workflows/checks aplicaveis ao mesmo SHA antes de declarar `green`.
- `failure`: coletar jobs e logs da tentativa concluida e reabrir remediacao.
- `cancelled`: tratar como nao verde; investigar se ha causa acionavel ou externa antes de decidir.
- `action_required`/aprovacao: nao aprovar automaticamente; classificar como bloqueio operacional quando for requisito real.

## Multiplos workflows

Um SHA pode disparar mais de um workflow. Nao declarar `green` ao observar apenas o primeiro sucesso.

1. Inventariar workflows/checks aplicaveis ao SHA.
2. Aguardar todos os obrigatorios/aplicaveis chegarem a estado terminal.
3. Se qualquer um falhar, diagnosticar a rodada completa antes de editar.
4. Se um workflow novo aparecer enquanto outros ja terminaram, inclui-lo na mesma avaliacao do SHA.

## Retomada

Se a execucao for interrompida pelo host:

1. reabrir o repositorio e PR/branch corretos;
2. ler o head atual;
3. se for o mesmo SHA, continuar observando sem repetir o patch anterior;
4. se o SHA mudou, diagnosticar apenas o delta remoto novo.

A retomada e stateless: o GitHub e a fonte de verdade para repo, head, runs, jobs e logs.


## Integracao com freeze/handoff de entrega

Quando `corrigir-ci` atuar sobre uma PR/branch que ja tenha sido congelada ou preparada por `entregar-issue`, a unidade de identidade inclui tambem o vinculo entre `head_sha` e o certificado `.audit/entregar-issue/handoff-ready.json`.

- Qualquer commit publicado por esta Skill apos o freeze invalida automaticamente o certificado anterior, independentemente de o delta ser funcional, documental, formatacao ou teste.
- Nao atualizar campos de SHA dentro dos artefatos de entrega por conta propria e nao reutilizar certificado de outro head.
- A CI verde do novo SHA comprova somente os workflows observados nesse SHA; nao restaura o handoff anterior e e estado transitorio.
- Ao atingir CI verde material, executar imediatamente `entregar-issue` em fast path `post-ci-refreeze` na mesma invocacao, passando `previous_frozen_sha`, `current_head_sha`, commits e evidencia remota.
- `entregar-issue` e o unico owner autorizado a revalidar artefatos dependentes, refazer freeze e gerar novo `handoff-ready.json`.
- Retomar o loop remoto apenas depois de o novo filho terminal `result-only-child` estar publicado/validado. Se ele disparar CI, observar tambem esse head final.
- Enquanto esse refreeze nao ocorrer, proibir encaminhamento a `auditar-issue`; se o runtime impedir a recertificacao, terminar `blocked-handoff-recertification`, nao `green`.
- `stale-after-ci-fix` e estado intermediario e nunca pode ser o estado final de uma execucao considerada corrigida.

Consultar `handoff-recertification.md` para a maquina de estados e os criterios terminais.

Esse protocolo evita que uma correcao de CI tecnicamente correta produza uma divergencia de identidade entre o candidato verde e o pacote de auditoria.

## Uso de skills compostas

Skills de implementacao podem corrigir uma causa acionavel, mas nao devem possuir o loop remoto. Depois do patch/validacao/publicacao, retornar o controle a `corrigir-ci` para aguardar o novo workflow e decidir o proximo ciclo.

Skills compostas nunca podem impor um repositorio padrao a `corrigir-ci`; a identidade resolvida por esta skill prevalece.
