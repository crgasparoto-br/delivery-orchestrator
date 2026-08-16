# Auditoria de contagem outbound e fronteira de segredos

## Chamadas transitivas ao provider

Quando houver executor comum, retry, fallback, adapter, ferramenta web ou recuperacao de evidencia:

1. localizar a callback entregue ao executor e expandir todos os helpers transitivos ate o SDK;
2. contar invocacoes reais de rede por tentativa, nao apenas chamadas ao executor;
3. executar `OUTBOUND-COUNT-001` com spy no ultimo limite externo e provar que uma tentativa configurada produz uma unica chamada em:
   - caminho feliz;
   - fonte insuficiente ou URL-only;
   - payload invalido;
   - resultado funcional ausente;
4. reprovar helper que execute probe, diagnostico, enriquecimento ou recuperacao fora da politica do executor;
5. confirmar que custo, timeout, cancelamento, telemetria e fallback representam todas as chamadas reais.

Um teste que afirma `attempts=1` mas observa duas chamadas ao SDK e contraditorio e nao comprova o requisito.

## Smoke remoto e fronteira de segredos

Executar `SMOKE-NO-PR-SECRETS-001` e verificar:

- ausencia de workflow novo ou alterado apenas para produzir evidencia da issue;
- ausencia de credenciais reais disponibilizadas a codigo de PR;
- ausencia de `workflow_dispatch`, GitHub Environment, deployment gate ou job introduzido com aprovacao manual;
- ausencia de `pull_request_target` executando codigo do head;
- uso de testes hermeticos, fake server, contract tests, replay sanitizado ou smoke local sem segredo para validar comportamento;
- quando existir smoke remoto protegido anterior a issue, coleta somente leitura do estado e dos artefatos existentes;
- estado `waiting`, `action_required` ou equivalente classificado como `manual-approval-pending`, sem solicitar aprovacao nem criar workflow alternativo.

Se a propria issue for de CI/GitHub Actions, verificar autorizacao explicita para mudar `.github/workflows/*`. Mesmo nesse caso, reprovar introducao de aprovacao manual do usuario ou exposicao de credenciais reais a codigo de PR.

A existencia de smoke verde comprova comportamento funcional, nao autoriza multiplicar runs nem alterar a custodia de segredos. Auditar comportamento, contagem outbound e ausencia de segredos no codigo de PR separadamente.
