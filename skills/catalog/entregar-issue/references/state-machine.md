# Estado canonico da orquestracao

## Finalidade

Manter o ciclo independente da memoria da conversa, impedir combinacao de artefatos de identidades diferentes e proibir autoaprovacao.

## Arquivo

Usar `orchestration-state.json`, criado por `scripts/init_orchestration_state.py` com `schema_version: 3`.

- Alterar estado, identidade e artefatos somente por `scripts/transition_orchestration_state.py`.
- Registrar ou resolver achados e importar parecer externo somente por `scripts/update_orchestration_state.py`.
- Preservar `implementation_context_id`; ele identifica o contexto que coordenou a implementacao.

Campos essenciais:

- repositorio, caminho local, issue, base, branch e PR;
- estado vigente e numero do ciclo;
- `head_sha`, `base_sha` e `merge_preview_sha` observados;
- artefatos atuais com caminho, SHA-256, head, base, merge preview e ciclo de origem;
- artefatos invalidados e motivo;
- achados abertos e resolvidos;
- parecer externo assinado, quando existir;
- historico append-only de transicoes e auditorias.

## Transicoes

Permitidas pelo script geral:

- `pendente -> em-correcao|bloqueado`;
- `em-correcao -> verificado|bloqueado`;
- `verificado -> em-correcao|pronto-para-auditoria-independente|bloqueado`;
- `pronto-para-auditoria-independente -> em-correcao|bloqueado`;
- `bloqueado -> em-correcao|pendente`;
- `aprovado -> em-correcao` quando surgir achado posterior ou mudar a identidade.

`transition_orchestration_state.py --to aprovado` deve sempre falhar. O unico caminho para `aprovado` e `update_orchestration_state.py import-audit` com relatorio externo Ed25519 valido.

## Invalidacao por identidade

Qualquer transicao que altere `head_sha`, `base_sha` ou `merge_preview_sha` deve:

1. incrementar `cycle`;
2. mover os artefatos atuais para `invalidated_artifacts`;
3. limpar pacote, plano, metricas, snapshot remoto, evidencias, gate report e handoff atuais;
4. invalidar parecer externo anterior;
5. registrar motivo e timestamp;
6. permanecer em `em-correcao` ou `pendente`.

Depois da coleta remota, atualizar a identidade ainda em `em-correcao`. Somente numa transicao posterior, sem mudanca de identidade, registrar artefatos e avancar para `verificado`.

## Achados

`update_orchestration_state.py add-finding` deve registrar severidade, requisitos, classe de escape, invariante generalizado e evidencias, alem de retornar o estado a `em-correcao` e invalidar aprovacao anterior.

`resolve-finding` exige caso literal, ao menos dois casos irmaos e evidencia de reverificacao.

## Auditoria externa assinada

Ler [external-audit.md](external-audit.md). Um relatorio apenas textual, um ID autodeclarado ou um JSON nao assinado nunca produz `aprovado`.

A chave publica confiada deve:

- estar fora do repositorio; ou
- existir no `base_sha` e permanecer identica entre base e head.

A chave privada deve permanecer sob custodia externa e inacessivel ao contexto de implementacao.

Importar somente com:

```bash
python <skill>/scripts/update_orchestration_state.py <state.json> import-audit \
  --report-path <external-audit.json> \
  --trusted-auditors <trusted-auditors.json>
```

O importador valida schema, assinatura, autorizacao da chave para o repositorio, identidade antes/depois, ciclo, contexto distinto, data posterior ao handoff, report ID nao reutilizado, ausencia de achados/limitacoes para `approved` e artefatos atuais do gate.

Depois do import, revalidar obrigatoriamente a vigencia da aprovacao:

```bash
python <skill>/scripts/validate_approved_state.py <state.json>
```

Esse validador confere novamente o relatorio assinado, o registro confiado, hashes e identidade dos artefatos, `HEAD`, base local, working tree limpa e o estado remoto atual. Uma aprovacao e uma propriedade da identidade vigente, nao um selo permanente. Qualquer falha deve invalidar o uso de `aprovado` e reabrir o ciclo.

## Regras

- Nao editar manualmente historicos.
- Nao remover achado posterior; registrar resolucao em novo ciclo.
- Antes de criar `evidence.json`, registrar `packet-manifest`, `pass-b-plan` e `remote-gate` em `current_artifacts`.
- Cada artefato deve apontar para a mesma combinacao de head, base, merge preview e ciclo do estado.
- O gate deve conferir que estado, pacote, plano e snapshot usam os mesmos caminhos, hashes e identidade.
- O estado `aprovado` deve conter origem, data, contexto independente, assinatura, chave confiada e hash/caminho do parecer externo.

## Projeção do controlador

Em `issue-loop-single-invocation`, `cycle` e `controller_cycle` são espelhos do ciclo recebido. O Entregar Issue não incrementa o ciclo em mudanças de identidade; registra invalidação e aguarda o próximo `controller_state_revision`. Em standalone, o comportamento legado de ciclo local permanece.
