---
name: corrigir-ci
description: Corrigir automaticamente falhas de CI/GitHub Actions em qualquer repositorio GitHub acessivel, para pull requests ou branches. Usar quando o usuario disser que a CI falhou, pipeline/checks estao vermelhos, GitHub Actions falhou, pedir para corrigir a CI, ou pedir para continuar corrigindo ate ficar verde. Resolver repositorio e SHA atuais, diagnosticar jobs/logs, aplicar correcoes, validar, publicar e observar os workflows ate estado terminal. Quando a entrega possuir freeze/handoff de entregar-issue, restaurar obrigatoriamente o handoff terminal na mesma invocacao depois de qualquer correcao material, sem deixar certificado stale. Nunca fazer merge automaticamente.
---

# Corrigir CI

## Objetivo

Possuir o ciclo completo de remediacao de CI em qualquer repositorio GitHub: observar -> diagnosticar -> corrigir -> validar -> publicar -> aguardar -> reobservar. Nao encerrar apenas porque um workflow ainda nao apareceu, esta `queued` ou esta `in_progress`.

Nao assumir nome, owner, branch, stack, comandos, workflow ou convencoes de um repositorio especifico. Descobrir esses dados no contexto e no proprio repositorio.

## Invariantes

- Nunca fazer merge automaticamente.
- Nunca apagar arquivo sem autorizacao explicita do usuario ou de instrucoes vigentes do projeto/repo.
- Nunca criar commit vazio, mudar SHA artificialmente ou editar workflow apenas para retriggerar CI.
- Nao rerodar, cancelar ou aprovar workflow manualmente por padrao.
- Nao alterar secrets, variables, branch protection, required checks ou environments.
- Nao mascarar falha de infraestrutura com mudanca de codigo sem relacao causal.
- Trabalhar sempre sobre o head atual da PR/branch; reconsultar o head imediatamente antes de qualquer escrita.
- Agrupar todas as falhas irmas baratas da mesma execucao antes de editar, evitando um commit por sintoma.
- Considerar verde somente evidencia do SHA exato que permanece como head atual.
- Respeitar `AGENTS.md`, `CONTRIBUTING`, README, convencoes versionadas e instrucoes especificas do repositorio antes de editar.
- Quando a branch/PR pertencer a uma entrega governada por `entregar-issue`, tratar qualquer publicacao de novo `head_sha` apos freeze/handoff como invalidacao automatica do freeze e de `.audit/entregar-issue/handoff-ready.json`.
- Nunca editar, copiar, corrigir ou regenerar diretamente `.audit/entregar-issue/*`; esses artefatos pertencem a `entregar-issue`.
- Em entrega governada, `ci-green` apos commit material e estado intermediario: executar `entregar-issue` em fast path `post-ci-refreeze` na mesma invocacao e somente encerrar depois de restaurar um handoff terminal valido no head remoto.
- Nunca deixar `stale-after-ci-fix` como estado final de sucesso. Se o refreeze/handoff nao puder ser concluido por impedimento real, retornar `blocked-handoff-recertification` e proibir auditoria.

## Resolver o repositorio

Resolver a identidade sem hardcode, nesta ordem:

1. Usar repositorio/PR/branch explicitamente fornecido pelo usuario.
2. Usar URL GitHub, numero de PR, branch ou repo ja identificado no contexto da conversa.
3. Usar o repositorio ativo do projeto/conversa quando houver exatamente um candidato claro.
4. Consultar GitHub para localizar PR/branch recente e relevante quando a mensagem for apenas "CI falhou".
5. Se houver multiplos candidatos igualmente plausiveis e nenhuma evidencia permitir escolher com seguranca, pedir apenas o minimo necessario para desambiguar.

Depois de resolver, capturar pelo menos:

- `repository_full_name`;
- PR, quando existir;
- branch head;
- branch base, quando existir;
- `head_sha` atual;
- workflow/checks aplicaveis ao SHA.

## Fluxo obrigatorio

1. Resolver a identidade atual.
   - Aplicar a ordem de descoberta acima.
   - Se houver contexto anterior com PR/branch conhecido, reutilizar e apenas confirmar o head atual.
   - Nao assumir que a branch principal se chama `main`.

2. Descobrir as regras do repositorio.
   - Ler instrucoes versionadas relevantes antes de editar (`AGENTS.md`, `CONTRIBUTING*`, docs de desenvolvimento, scripts do package/build system e workflow falho).
   - Derivar os comandos reais de formatacao, lint, typecheck, testes e build do repositorio; nao reutilizar comandos de outro projeto.

3. Observar a CI do `head_sha`.
   - Buscar workflow runs/checks associados ao SHA.
   - Se ainda nao houver run, continuar observando; nao concluir `pending-no-run` como resultado final.
   - Se houver run `queued`, `waiting` ou `in_progress`, continuar observando ate estado terminal.
   - Entre observacoes, usar espera moderada quando o ambiente oferecer mecanismo de espera; nunca fazer hot-loop de API.

4. Quando um run terminar com falha, coletar diagnostico completo da rodada.
   - Listar todos os jobs.
   - Para cada job falho, identificar o step falho e ler os logs existentes.
   - Agrupar mensagens por causa raiz.
   - Classificar cada causa como:
     - `actionable-delivery`: corrigivel no codigo, testes, schema, config ou documentacao versionada do candidato;
     - `external-infrastructure`: runner, indisponibilidade externa, segredo ausente, rate limit, permissao ou servico fora do escopo;
     - `unrelated-preexisting`: falha comprovadamente anterior e fora do diff/entrega.

5. Remediar todas as causas `actionable-delivery` da rodada.
   - Preferir o menor patch coeso.
   - Usar skills existentes quando trouxerem vantagem real e forem aplicaveis ao repositorio/recorte:
     - `entregar-issue` para implementacao/testes/remediacao quando houver issue, PR ou branch com contrato de entrega identificavel;
     - `revisar-issue` somente se uma ambiguidade material impedir a correcao;
     - `design-interface`, `fluxos-conversacionais` ou `documentacao-repositorio` apenas quando a falha exigir a especialidade correspondente.
   - Quando usar `entregar-issue` para corrigir a causa material, limitar essa chamada a diagnostico/implementacao/validacao e retornar o controle a `corrigir-ci`; esta skill continua dona da espera e reobservacao remota.
   - Se ja existir freeze/handoff e a rodada publicar mudanca material, registrar desde este ponto que um fast path `post-ci-refreeze` sera obrigatorio depois de a CI material ficar verde; nao permitir resposta final antes disso.
   - Nao adotar a regra de encerrar por `pending-no-run` de outra skill: esta skill continua esperando por design.
   - Se nenhuma skill especializada for adequada, corrigir diretamente seguindo as convencoes do repositorio.

6. Validar antes de publicar.
   - Executar checks focados que reproduzam os steps falhos.
   - Quando o ambiente permitir checkout executavel, executar tambem o gate agregado afetado antes do commit.
   - Para falha de formatacao, executar o formatador real e depois o check real; nunca inferir manualmente a saida se o binario/config do projeto estiver disponivel.
   - Para lint/typecheck/test/build, executar o comando exato ou equivalente versionado no workflow.
   - Respeitar package manager, runtime, monorepo tooling e versoes travadas pelo repositorio.
   - Se o ambiente local nao suportar o gate, registrar a limitacao sem inventar sucesso; publicar apenas quando a correcao estiver fundamentada por evidencia suficiente.

7. Publicar uma correcao material.
   - Reconsultar o head imediatamente antes da escrita.
   - Se o head mudou externamente, reconciliar o delta e nao sobrescrever trabalho novo.
   - Criar um unico commit coeso por rodada de causa raiz quando possivel.
   - Atualizar a branch existente da PR; nao abrir PR paralela sem necessidade.
   - Nao fazer merge.

8. Aguardar a nova CI automaticamente.
   - Capturar o novo `head_sha` apos a publicacao.
   - Continuar observando ate os workflows/checks aplicaveis desse SHA terminarem.
   - Nao pedir ao usuario para voltar depois, nao pedir confirmacao e nao encerrar voluntariamente apenas por estado pendente.
   - Se o host/runtime interromper inevitavelmente a execucao, retornar estado `interrupted-by-runtime`, com repo, PR/branch, SHA e ultimo estado observado. Em nova invocacao, retomar desse SHA sem repetir diagnostico/patch ja aplicado.

9. Fechar a identidade de entrega apos CI verde.
   - Detectar se a PR/branch possui ou possuia freeze/handoff de `entregar-issue` na rodada atual, por contexto, `.audit/entregar-issue/handoff-ready.json`, branch de handoff ou metadados recebidos.
   - Se esta Skill publicou qualquer novo commit depois desse freeze/handoff, marcar o certificado anterior como `stale-after-ci-fix`, mesmo quando a correcao for apenas formatacao, documentacao, teste ou arquivo colateral do candidato. Esse estado e transitorio e nunca pode ser a saida final `green`.
   - Nao encaminhar diretamente para `auditar-issue` e nao declarar a entrega pronta para auditoria independente com certificado de outro SHA.
   - Executar imediatamente `entregar-issue` na mesma invocacao usando o fast path `post-ci-refreeze`, passando `previous_frozen_sha`, `current_head_sha`, commits de remediacao e evidencias de CI verde. Nao apenas imprimir/devolver esses campos e encerrar.
   - Exigir que `entregar-issue` revalide somente gates/artefatos invalidados pelo delta, refaca o freeze no novo material head, regenere `handoff-ready.json`, publique o filho direto `result-only-child` e valide o gate terminal de handoff.
   - Retomar o controle em `corrigir-ci` somente depois da publicacao do novo handoff. Reconsultar o head remoto e confirmar que nao existe commit material posterior ao filho terminal.
   - Observar os workflows/checks aplicaveis ao novo head terminal. Se uma nova falha exigir mudanca material, voltar ao passo 4, invalidar novamente o handoff e repetir todo o ciclo. Se a falha for exclusiva do pacote `.audit/entregar-issue/*`, transferir a correcao a `entregar-issue` sem editar esses arquivos diretamente.
   - Se o runtime/connector impedir executar ou publicar a recertificacao, terminar como `blocked-handoff-recertification`, com `Libera auditoria: NAO`; nunca usar `green`.
   - Consultar `references/handoff-recertification.md` para a maquina de estados e os criterios de terminalidade.

10. Repetir enquanto houver falha acionavel ou identidade de handoff nao terminal.
   - Se a nova CI falhar, voltar ao passo 4 automaticamente no mesmo fluxo.
   - Se o head atual estiver materialmente posterior ao handoff certificado, voltar ao passo 9 automaticamente.
   - Agrupar novamente todas as falhas da nova rodada antes de editar.
   - Nao limitar o ciclo a uma unica correcao.
   - Parar somente em uma das condicoes finais abaixo.

## Condicoes finais

### `green`

Declarar somente quando:

- a PR/branch continua apontando para o SHA observado;
- todos os workflows/checks aplicaveis ao SHA final terminaram, ou a inaplicabilidade ao filho somente de resultados foi comprovada;
- nao existe job/check falho, cancelado ou aguardando aprovacao obrigatoria;
- o status combinado aplicavel nao contem falha pendente;
- se nao houve freeze/handoff governado, a identidade final e o SHA verde observado;
- se houve freeze/handoff e esta Skill publicou commit material, `entregar-issue` ja executou `post-ci-refreeze` na mesma invocacao, o head remoto atual e um `result-only-child` terminal valido ligado ao novo material head e nao existe commit material posterior;
- o estado final do handoff e `terminal-handoff-valid` ou `unchanged-exact-head`, nunca `stale-after-ci-fix`.

### `blocked-handoff-recertification`

Usar quando a CI material foi corrigida, mas um impedimento real do runtime/connector impede executar ou publicar o refreeze/handoff obrigatorio de uma entrega governada. Informar material head, handoff anterior, impedimento e `Libera auditoria: NAO`. Esse estado nunca pode ser tratado como `green`; nao declarar `corrigido` nem encaminhar para `auditar-issue`.

### `blocked-external`

Usar quando nao existir correcao versionada legitima para deixar o CI verde, por exemplo segredo obrigatorio ausente, indisponibilidade persistente de servico externo ou permissao de runner. Informar repo, job, step e trecho causal do log. Nao criar commit artificial para retriggerar.

### `unrelated-preexisting`

Usar apenas com evidencia de baseline suficiente de que a falha antecede e independe do candidato. Nao corrigir fora do escopo silenciosamente.

### `interrupted-by-runtime`

Usar apenas quando o ambiente realmente impedir continuar esperando/executando na mesma invocacao. Nao chamar isso de sucesso. Fornecer a identidade exata para retomada automatica.

## Politica de espera

Consultar `references/ci-loop.md` para regras de observacao, retomada e prevencao de polling agressivo.

## Saida

Manter atualizacoes curtas durante ciclos longos. Ao final, responder com:

- status final;
- repositorio;
- PR e branch, quando aplicaveis;
- SHA verde ou bloqueado;
- causas encontradas por rodada;
- commits de remediacao;
- checks/workflows finais;
- estado do handoff de entrega (`not-applicable`, `unchanged-exact-head`, `terminal-handoff-valid` ou `blocked-handoff-recertification`);
- material head e handoff head finais quando houver entrega governada;
- `return_control_to=entregar-issue` apenas como telemetria/transicao interna ou quando um impedimento real bloquear a composicao; nunca como substituto do refreeze na saida de sucesso;
- impedimento real, se houver.

Nao declarar "corrigido" enquanto a CI do SHA final ainda estiver pendente. Em entrega governada, tambem nao declarar "corrigido" enquanto o head remoto final nao estiver novamente coberto por handoff terminal valido.
