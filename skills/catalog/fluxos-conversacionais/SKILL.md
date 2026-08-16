---
name: fluxos-conversacionais
description: Especificar, implementar, verificar e auditar fluxos conversacionais ou assincronos que continuam em mensagens, botoes, callbacks, audios, filas ou eventos posteriores. Usar quando uma resposta futura depender de contexto persistido, correlacao, expiracao, cancelamento, retry, idempotencia, concorrencia ou isolamento. Sob `entregar-issue`, consumir o recorte recebido, centralizar contratos equivalentes, selecionar cenarios discriminantes por risco e evitar repetir descoberta ou testes por produtor equivalente.
---

# Fluxos Conversacionais

## Objetivo

Tratar continuidade como maquina de estados persistente, segura e verificavel, com cobertura eficiente das invariantes reais.

## Modos

- `specification`;
- `implementation`;
- `internal-verification`;
- `independent-audit`;
- `guidance`.

Quando composta, ler `references/delivery-contract.md`.

## Aplicabilidade

Aplicar quando etapa futura recuperar contexto anterior: confirmacao, pergunta pendente, callback, audio, fila, retry, expiracao, cancelamento ou concorrencia. Operacao atomica completa e `not-applicable`.

## Contrato minimo

Definir contexto original, identidade/tenant, correlacao, estado/versao, precedencia, persistencia antes do envio, expiracao, cancelamento, resposta invalida, idempotencia, concorrencia, encerramento atomico, falhas parciais, paridade de entrada e observabilidade.

## Composicao

1. Consumir requisitos, produtores, entrypoints, caminhos e perfil recebidos.
2. Nao reextrair toda a issue nem recriar registro documental.
3. Nao criar branch, PR, issue ou comentario.
4. Respeitar `write_owner`: em `guidance`, produzir maquina de estados e invariantes antes da escrita; em `internal-verification`, operar em leitura e retornar findings; editar somente em `implementation` quando o recorte for exclusivamente desta Skill.
5. Usar persistencia como fonte de verdade, nao memoria do processo ou reclassificacao da LLM.
6. Centralizar o contrato quando produtores diferentes representam o mesmo cenario.

## Specification

Produzir estados, transicoes, dados preservados, correlacao, acoes validas, comandos globais, expiracao, cancelamento, falhas e criterios discriminantes. Nao modelar apenas a primeira mensagem.

## Implementation

1. Persistir estado antes do envio pendente.
2. Resolver por identificador confiavel e validar identidade, tenant, versao, prazo e acao.
3. Definir precedencia sem bloquear comandos globais permitidos.
4. Normalizar canais para a mesma acao de dominio.
5. Mutar e consumir com atomicidade adequada.
6. Tratar duplicidade, retry, concorrencia, expiracao, cancelamento, reinicio e falha parcial conforme risco. Recuperacao deve ocorrer no entrypoint que o cliente realmente repete; nao depender de GET, health-check, listagem ou outra operacao auxiliar para tornar o retry correto.
7. Para idempotencia + reinicio, garantir que a mesma chave possa ser repetida apos estado persistido/stale sem duplicar outbound ou resposta e sem permanecer presa indefinidamente em `processing`.
8. Atualizar testes, migrations, contratos, diagramas, runbooks e documentacao.

## Cenarios por risco

Cobrir sempre: caminho feliz, resposta invalida/cancelamento, expiracao, duplicidade/idempotencia e isolamento de identidade/tenant quando aplicavel.

Adicionar conforme sinais:

- `standard`: retry, novo comando durante pendencia, reinicio e falha parcial. Para retry apos reinicio, repetir o mesmo entrypoint publico e a mesma chave de idempotencia sem chamada auxiliar de recuperacao;
- `critical`: duas respostas concorrentes, produtores concorrentes, falha antes/depois do envio, reordenacao e todas as fronteiras de atomicidade. Executar matriz de interrupcao `antes da persistencia | depois da persistencia | depois do outbound | antes da finalizacao` x `mesma chave | nova chave` para as celulas aplicaveis.

Usar pairwise entre canais, produtores e invariantes quando o mesmo contrato central os governa. Nao repetir toda a matriz para produtores equivalentes; manter ao menos um controle negativo por variante que possa divergir.

## Verificacao e auditoria

Operar em leitura. Tentar refutar persistencia anterior ao envio, recuperacao exata, precedencia, paridade, expiracao, idempotencia, concorrencia, isolamento e reconstrucao apos reinicio. Para `retry + restart`, o controle canonico `RESTART-IDEM-001` deve repetir diretamente o mesmo entrypoint publico, mesma chave, sem GET/health-check/listagem intermediaria, e verificar contagem de outbound/efeito. No modo independente, rederivar; no interno, nao aprovar.

Nao repetir cenario quando estado inicial, entrada, produtor, SHA e resultado tiverem fingerprint identico.

## Entrega

Retornar maquina de estados, transicoes, persistencia, produtores, classes de cenario, casos executados, arquivos, validacoes focadas, evidencias, fingerprints, findings, documentacao e limitacoes. Nao declarar independencia no contexto de implementacao.

## Composicao versionada

No modo orquestrado, aplicar `references/delivery-contract.md` como unica fonte do envelope, reutilizacao e versao. Toda execucao nova deve emitir `input_fingerprint` e `reused=false`; qualquer no-op deve incluir `skip_reason`. Nao duplicar estado, ciclo, identidade global ou delegacao.
