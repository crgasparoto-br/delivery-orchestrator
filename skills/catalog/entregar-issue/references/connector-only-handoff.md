# Handoff em runtime connector-only

## Objetivo

Garantir que ausencia de checkout Git local nao termine uma entrega funcional sem pacote de readiness. O handoff e responsabilidade de `entregar-issue` e deve ser produzido mesmo quando o repositorio so estiver acessivel por connector.

## Regra principal

`connector-only` muda a forma de obter e publicar bytes; nao relaxa coverage, saturation, inherited controls nem certificado.

Quando o candidato material estiver pronto e o snapshot remoto permitido da rodada tiver sido observado, mesmo que o CI ainda esteja `pending-no-run`, `queued`, `in_progress` ou `waiting`:

1. congelar o **material head SHA** antes de qualquer arquivo de handoff;
2. obter por connector os bytes exatos das fontes/evidencias necessarias que ainda nao estejam no workspace do controlador;
3. materializar em diretorio efemero somente o pacote `.audit/entregar-issue` e os inputs necessarios aos validadores, sem alterar o checkout do produto;
4. gerar/atualizar `specification-snapshot.json`, `requirement-closure.json`, `requirement-attack-matrix.json`, `risk-saturation.json`, `inherited-controls.json` e closures aplicaveis com `head_sha` igual ao material head;
5. executar os validadores da propria Skill nesse workspace;
6. gerar `handoff-ready.json` por `build_handoff_certificate.py`, ainda vinculado ao material head;
7. publicar todos os arquivos de handoff em **um unico commit filho somente de resultados**;
8. verificar que o parent desse commit e o material head e que o diff do filho contem apenas caminhos autorizados por `certificate_commit_policy.allowed_paths`;
9. registrar separadamente `material_head_sha` e `handoff_head_sha`; nunca reclassificar o commit de resultados como nova mudanca material;
10. reconsultar o head remoto e executar `scripts/validate_terminal_handoff.py` com parent e changed paths obtidos do connector;
11. somente entao encaminhar a entrega a `auditar-issue`.

## Resultado-only child

Um certificado versionado no proprio repositorio nao pode conter o SHA do commit que o contem sem criar autorreferencia criptografica. Portanto o modelo canonico e:

```text
base ---- material M ---- handoff H
                    \\__ codigo/testes/docs congelados
                               \\__ somente .audit/entregar-issue/*
```

O certificado em `H` certifica `M`. O auditor valida que:

- `H` e filho direto de `M`;
- nenhuma alteracao de produto existe em `M..H`;
- todos os caminhos de `M..H` estao na allowlist do certificado;
- attack matrix, saturation e inherited controls continuam vinculados a `M`.

CI/evidencia de produto vinculada a `M` permanece valida para o comportamento material. Checks exigidos pela politica de merge no head publicado `H` continuam sendo observados separadamente como estado remoto, sem converter `H` em novo material head.

## Substituicao de pacote herdado

Se a base trouxer `.audit/entregar-issue` de outra issue/SHA:

- tratar o pacote como historico/stale;
- nao reutilizar hashes ou conclusoes;
- nao publicar uma entrega que apenas remova o pacote antigo;
- substituir o pacote atomica e completamente pelo pacote da entrega atual no commit result-only child;
- se ainda nao houver evidencia suficiente para gerar o novo pacote, manter o handoff como pendencia interna e **nao chamar `auditar-issue`**.

## Falhas do connector

Se o connector nao permitir obter bytes exatos, executar os validadores locais ou publicar um commit de resultados:

- registrar `handoff-publication-blocked` como impedimento real da entrega;
- nao chamar auditoria independente;
- nao declarar `aprovado-internamente-pendente-auditoria-independente` como se o handoff estivesse consumivel;
- preservar o material head sem editar codigo por tentativa.

## Recuperacao apos auditoria prematura

Quando `auditar-issue` retornar somente `delivery-not-ready` com `return_control_to=entregar-issue` e `reason=handoff-not-produced|handoff-stale`, sem finding funcional:

1. revalidar que o material head nao mudou;
2. nao reabrir implementacao nem redescobrir requisitos;
3. reconstruir/validar o pacote no workspace efemero;
4. publicar o result-only child;
5. reenviar a identidade composta para nova auditoria independente.

Se o head tiver mudado materialmente, abandonar esse fast path e refazer freeze/gates dependentes do delta.


## CI pendente nao suspende publicacao

Connector-only nao pode usar ausencia ou pendencia de workflow como atalho para terminar sem pacote. O snapshot remoto e registrado como evidencia de estado, o result-only child e publicado e validado, e a resposta final informa a pendencia de CI separadamente. Se o connector impedir a publicacao/verificacao do filho de handoff, classificar `handoff-publication-blocked` e nao chamar auditoria.
