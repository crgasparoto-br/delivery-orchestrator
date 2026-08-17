---
name: orquestrar-entrega
description: Orquestra entregas completas de issues com sincronizacao do catalogo de Skills, implementacao, CI, auditoria independente e remediacao ate estado terminal.
---

# Orquestrar Entrega

Usar o `delivery-orchestrator` como unico controlador do ciclo. Nao simular independencia trocando de Skill no mesmo contexto.

## Entrada

Resolver:

- repositorio `owner/repo`;
- numero da issue;
- limite de ciclos, usando 6 quando o usuario nao definir outro limite;
- repositorio/instalacao do `delivery-orchestrator` configurado para o workspace.

Nao pedir novamente informacao ja presente na conversa, issue ou repositorio.

## Sincronizacao obrigatoria de Skills

Antes de iniciar um novo run, sincronizar as Skills atuais do ambiente ChatGPT Web usadas pelo controlador com `skills/catalog` do `delivery-orchestrator`.

Skills sincronizadas:

- implementador: `entregar-issue`, `revisar-issue`, `fluxos-conversacionais`, `documentacao-repositorio`, `design-interface`, `corrigir-ci`;
- auditor: `auditar-issue`, `fluxos-conversacionais`, `documentacao-repositorio`, `design-interface`.

Contrato:

1. Gerar o manifest deterministico `skills/catalog.sync-manifest.json` a partir das versoes atualmente instaladas no GPT Web, usando `scripts/build_catalog_manifest.py` ou implementacao equivalente. O calculo deve incluir todos os arquivos e detectar adicoes, alteracoes e remocoes.
2. Comparar os digests locais com o catalogo publicado no branch base do `delivery-orchestrator`.
3. Se forem iguais, nao escrever nada.
4. Se houver drift, publicar somente os arquivos necessarios para tornar cada arvore de Skill identica a fonte atual, incluindo remocoes de arquivos obsoletos, e publicar o manifest no mesmo commit atomico. Esta escrita e atualizacao de artefato gerado do control plane, nao merge da issue alvo.
5. Reconsultar o commit publicado e confirmar que os digests do catalogo correspondem ao manifest antes de disparar a entrega.
6. O workflow deve executar a validacao do manifest antes de preparar os `CODEX_HOME`; qualquer divergencia de membership, file count ou digest e falha do controlador.
7. Nunca substituir o catalogo atual por uma copia antiga somente para fazer o workflow passar.

Use Git tree/blob SHA para reduzir a sincronizacao a arquivos realmente diferentes. Se o ambiente atual nao expuser filesystem das Skills mas expuser os recursos `skills://`, materializar os mesmos arquivos a partir desses recursos. Se nenhuma das duas formas estiver disponivel, falhar fechado e explicar que a sincronizacao nao pode ser comprovada.

## Fluxo

1. Verificar se o control plane `delivery-orchestrator` esta instalado e se o workflow `Independent delivery loop` existe.
2. Executar a sincronizacao obrigatoria de Skills acima.
3. Iniciar exatamente uma execucao do workflow com repositorio, issue e limite de ciclos:
   - usar `workflow_dispatch` quando o conector expuser uma acao de dispatch;
   - se `workflow_dispatch` nao estiver disponivel, mas houver escrita de issues no repositorio privado de controle, criar exatamente uma issue de controle com titulo `delivery-request: owner/repo#N` e corpo JSON puro contendo somente `target_repository`, `issue_number` e `max_cycles`;
   - nunca criar a issue de controle no repositorio alvo; cria-la no repositorio `delivery-orchestrator` que contem o workflow;
   - depois de criar a issue de controle, localizar o run `Independent delivery loop` disparado pelo evento `issues`, usando o titulo da issue/run e o horario de criacao para correlacao;
   - nao criar uma segunda solicitacao se um run correlacionado ja existir.
4. Tratar o workflow como dono do loop. Nao executar `entregar-issue` ou `auditar-issue` manualmente em paralelo enquanto o run estiver ativo.
5. Acompanhar o run correlacionado ate estado terminal na mesma invocacao. Nao encerrar voluntariamente com estado `RUNNING`, `queued` ou `in_progress`.
6. Interpretar o estado final:
   - `COMPLETE`: informar a entrega e a auditoria independente aprovadas; nunca fazer merge automaticamente.
   - `BLOCKED_REQUIREMENT`: apresentar a decisao material que bloqueou a implementacao.
   - `BLOCKED_EXTERNAL`: apresentar a dependencia externa/runtime que impediu conclusao.
   - `NO_PROGRESS`: apresentar fingerprint/causa recorrente e exigir intervencao de causa raiz, nao nova repeticao cega.
   - `FAILED`: apresentar a falha do controlador/contrato. Se a falha ocorrer antes de existir estado persistido, incluir a validacao rejeitada do request de controle.
7. Reutilizar artefatos do run para diagnostico; nao substituir o estado persistido por narrativa de conversa.
8. Se o fallback por issue de controle tiver sido usado e um estado terminal tiver sido capturado, a issue de controle pode ser fechada como concluida. Nunca fechar ou fazer merge da issue/PR alvo automaticamente.

### Excecao de espera do control plane

A regra de `entregar-issue` que evita polling ativo do CI remoto continua valida para o papel implementador. Esta Skill possui uma excecao deliberada e estreita: como controlador externo, deve acompanhar somente o run `Independent delivery loop` que ela propria correlacionou ate terminal.

Durante essa espera:

- consultar o mesmo `run_id`; nao redisparar o workflow;
- usar polling moderado e limitado pelo timeout do proprio workflow;
- nao consumir um novo ciclo de implementacao/auditoria apenas porque o workflow ainda esta rodando;
- quando o job terminar com falha, buscar jobs, steps, logs e artefatos forenses antes de classificar a causa;
- falha de CI do repositorio alvo deve ser remediada pelo loop interno do `delivery-orchestrator`, que passa os workflows vermelhos ao proximo ciclo do implementador e exige `corrigir-ci` antes da auditoria;
- falha do proprio control plane deve ser reportada como `FAILED`/`BLOCKED_EXTERNAL` conforme o estado persistido. Nao mascarar erro de infraestrutura como finding da issue alvo.

Se a plataforma interromper coercitivamente a invocacao antes do terminal, retornar a identidade exata do run e o ultimo estado observado; isso e uma limitacao da plataforma, nao conclusao da entrega.

### Contrato da issue de controle

Usar corpo JSON sem Markdown ou campos adicionais:

```json
{
  "target_repository": "owner/repo",
  "issue_number": 123,
  "max_cycles": 6
}
```

O workflow valida ator, repositorio permitido, formato da issue e limite de ciclos antes de iniciar o loop. Nao tentar contornar uma rejeicao dessas validacoes alterando o payload para incluir comandos, refs, tokens ou parametros nao suportados.

## Independencia obrigatoria

Exigir simultaneamente:

- thread/contexto novo por papel e por ciclo;
- `CODEX_HOME` separado para implementador e auditor;
- implementador com credencial GitHub de escrita;
- auditor com credencial GitHub somente leitura e clone do candidato verificado como Git-clean no mesmo SHA apos a auditoria;
- auditor em clone novo no `handoff_head_sha` certificado;
- chave privada do auditor nunca acessivel ao implementador;
- `audit_context_id != implementation_context_id`;
- aprovacao final somente quando `auditar-issue` devolver validade independente e release gate satisfeito.

Trocar de skill na conversa atual nao satisfaz independencia.

## Guardas de loop

Parar sem consumir novas auditorias quando:

- a mesma identidade rejeitada reaparecer com o mesmo fingerprint de findings sem progresso;
- o mesmo `material_head_sha` reaparecer com o mesmo fingerprint de workflows CI bloqueantes sem progresso;
- o numero maximo de ciclos for atingido;
- houver limitacao externa inconclusiva;
- o implementador nao produzir handoff certificado;
- o auditor nao puder manter o remoto somente leitura ou alterar o clone do candidato;
- houver violacao de separacao de contexto/credencial.

## Resultado

Ser conciso. Informar estado terminal, repositorio/issue, numero de ciclos, material/handoff SHA quando disponiveis e proxima acao somente se o estado nao for `COMPLETE`.
