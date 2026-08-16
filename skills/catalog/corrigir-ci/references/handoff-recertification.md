# Recertificacao pos-CI de entregas governadas

## Objetivo

Impedir que uma correcao de CI deixe a branch em um head material posterior ao handoff enquanto o certificado anterior continua presente e aparentemente pronto para auditoria.

## Regra terminal

Para PR/branch governada por `entregar-issue`, `ci-green` e apenas um estado transitorio quando `corrigir-ci` publicou qualquer commit material depois de freeze/handoff.

A invocacao de `corrigir-ci` so pode terminar como sucesso quando existir simultaneamente:

1. CI aplicavel verde no estado publicado final;
2. material head identificado e congelado;
3. `handoff-ready.json` regenerado por `entregar-issue` para esse material head;
4. head remoto atual como filho terminal `result-only-child` valido;
5. nenhum commit material posterior ao filho terminal.

Nunca considerar suficiente apenas emitir `return_control_to=entregar-issue` e encerrar. Quando o runtime suporta Skills compostas, executar imediatamente o fast path `post-ci-refreeze` de `entregar-issue` na mesma invocacao.

## Maquina de estados

```text
ci-failed
  -> material-fix
  -> ci-green-material
  -> handoff-recertifying
  -> terminal-handoff-published
  -> ci-final-observed
  -> green
```

Se a CI do `terminal-handoff-published` falhar e a correcao exigir arquivo material:

```text
terminal-handoff-published
  -> stale-after-ci-fix
  -> material-fix
  -> ci-green-material
  -> handoff-recertifying
  -> ...
```

Se a falha estiver exclusivamente no pacote de handoff, nao editar `.audit/entregar-issue/*` diretamente. Devolver/transferir o work item a `entregar-issue`, que continua owner do pacote, e somente depois retomar a observacao remota.

## Chamada composta obrigatoria

Ao atingir `ci-green-material` depois de invalidar handoff:

- carregar/invocar `entregar-issue` imediatamente;
- passar `reason=post-ci-refreeze`;
- passar `previous_frozen_sha`, `current_head_sha`, commits materiais da rodada e evidencias de CI verde;
- exigir que `entregar-issue` execute o fast path sem redescoberta ampla;
- retomar `corrigir-ci` somente depois de o novo `result-only-child` estar publicado e terminalmente validado;
- reconsultar o head remoto antes da resposta final.

Se a composicao de Skills ou a publicacao do novo handoff for impossivel por limitacao real do runtime/connector, terminar como `blocked-handoff-recertification`, nunca como `green` ou `corrigido`.

## Observacao da CI do handoff terminal

Depois do refreeze:

- se workflows/checks aplicaveis forem disparados para o novo head terminal, observar ate estado terminal segundo `ci-loop.md`;
- se o repositorio comprovar que nenhum workflow e aplicavel ao filho somente de resultados, reutilizar a CI verde do material head apenas para os gates cujo escopo nao foi invalidado pelo pacote e exigir o gate terminal de handoff de `entregar-issue`;
- se qualquer novo commit material surgir, invalidar novamente o handoff e repetir o ciclo.

## Saida segura

Em entrega governada, o estado final de handoff deve ser um destes:

- `terminal-handoff-valid`: sucesso; pode seguir para auditoria independente;
- `unchanged-exact-head`: nenhum commit material foi publicado pela rodada e o handoff anterior continua valido;
- `blocked-handoff-recertification`: nao foi possivel restaurar a identidade; nao auditar.

`stale-after-ci-fix` e somente estado intermediario/diagnostico e nunca pode acompanhar um status final `green`.
