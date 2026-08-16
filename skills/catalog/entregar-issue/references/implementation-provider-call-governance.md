# Governanca de chamadas externas e smoke com credenciais

## Chamadas governadas pelo executor

Quando a issue tocar provider, adapter, retry, fallback, ferramenta externa ou recuperacao de evidencia:

- representar cada invocacao de rede ao provider como tentativa explicita e contabilizada pelo executor comum;
- proibir que a callback de uma tentativa, helper transitivo ou fronteira de dominio faca uma segunda chamada oculta para probe, diagnostico, recuperacao, validacao ou enriquecimento;
- diante de fonte ausente, URL sem evidencia vinculada, resultado funcional insuficiente ou payload rejeitado pelo dominio, retornar falha/ausencia e aplicar somente a degradacao canonica prevista;
- permitir nova chamada apenas quando o contrato a modelar como operacao separada, com politica, custo, timeout, cancelamento, telemetria e limite proprios;
- testar no limite do provider que `uma tentativa configurada = uma chamada outbound`, incluindo caso feliz, fonte insuficiente, URL-only, payload invalido e resultado funcional ausente.

## Smoke e GitHub Actions

Nao criar workflow de smoke com credenciais reais para codigo de PR. Em modo orquestrado, considerar `workflow_change_authorized=false`, `manual_approval_workflow_authorized=false` e `remote_action_mode=observe-only` como contrato obrigatorio.

Para provar o comportamento:

- usar fake server, adapter deterministico, contract test, replay sanitizado ou smoke local sem segredo;
- manter `uma tentativa configurada = uma chamada outbound` no ultimo limite externo;
- cobrir sucesso, fonte insuficiente, URL-only, payload invalido, resultado funcional ausente, timeout e fallback;
- nao criar `.github/workflows/*`, `workflow_dispatch`, GitHub Environment, deployment gate ou job com aprovacao manual;
- nao disparar ou reexecutar workflow existente e nao pedir aprovacao ao usuario;
- quando existir smoke remoto protegido no repositorio, apenas observa-lo como evidencia adicional. Estado `waiting`, `action_required` ou equivalente deve ser relatado como `manual-approval-pending`, sem criar alternativa.

Alterar workflow somente quando a issue tratar explicitamente de CI/GitHub Actions e houver autorizacao para essa classe de arquivo. Mesmo nessa excecao, nao configurar aprovacao manual nem liberar credenciais reais para codigo de PR.

## Controle reutilizavel

Executar `OUTBOUND-COUNT-001` para provar que helpers transitivos nao multiplicam chamadas dentro de uma tentativa e `SMOKE-NO-PR-SECRETS-001` para provar que codigo de PR nao recebe credenciais reais e que nenhuma aprovacao manual foi introduzida.
