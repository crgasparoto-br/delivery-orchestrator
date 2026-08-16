# Registro compartilhado de impacto documental

Usar um único registro por ciclo de trabalho para transportar decisões documentais entre especificação, implementação, design, fluxos conversacionais, higiene, auditoria e orquestração.

O registro organiza a execução. Ele não substitui `AGENTS.md`, README, ADR, contrato, runbook, Storybook ou qualquer outra fonte canônica do repositório.

## Estrutura mínima

- **contexto:** repositório, branch-base, branch de trabalho, pull request, commit ou estado avaliado e modo atual;
- **instruções consultadas:** `AGENTS.md` aplicáveis e demais documentos que governam o escopo;
- **categorias de impacto:** funcional, API, dados, arquitetura, setup, ambiente, operação, interface, fluxo assíncrono, segurança, testes ou refatoração;
- **fontes canônicas:** caminho, motivo da relevância, ação esperada e estado;
- **divergências:** conflito encontrado, fontes envolvidas, decisão tomada ou pergunta ainda aberta;
- **validações:** comando, artefato ou verificação aplicável e respectivo resultado;
- **ausência de impacto:** justificativa objetiva vinculada ao escopo e à matriz de impacto;
- **handoff:** fase, skill responsável, pendências e evidências que a próxima fase deve verificar.

Usar para cada fonte os estados `consultar`, `atualizar`, `validar`, `verificado`, `bloqueado` ou `não aplicável`, sempre com justificativa quando não aplicável.

## Ciclo de vida

1. **Especificação:** criar ou ampliar o registro com instruções, fontes e critérios documentais.
2. **Implementação:** reutilizar o mesmo registro, atualizar as fontes canônicas na mesma branch e PR do código e anexar resultados de validação.
3. **Correção ou higiene:** reabrir os itens afetados e reavaliar o impacto após cada alteração material.
4. **Auditoria:** receber o registro anterior como alegação e índice, refazer a descoberta de forma independente e marcar somente o que foi comprovado no estado auditado.
5. **Encerramento:** manter todos os itens necessários como `verificado`, ou registrar bloqueio real. Não encerrar com item obrigatório apenas declarado.

## Regras de composição

- Não criar registros paralelos por subskill dentro do mesmo ciclo.
- Não apagar achados ou decisões anteriores; atualizar estado e evidência.
- Não copiar regras permanentes do projeto para o registro em vez de documentá-las no repositório.
- Não considerar texto da issue, descrição da PR, comentário, memória ou o próprio registro como substituto de fonte canônica necessária.
- Não exigir que o registro seja commitado, salvo convenção explícita do projeto; exigir sempre que as fontes canônicas afetadas sejam commitadas.

## Extensão para mudança de contrato

Quando houver substituição, aposentadoria, redirect, renomeação ou mudança arquitetural, acrescentar ao registro:

- `old_contract_terms`;
- `new_contract_terms`;
- `repository_wide_search` com comando, SHA e resultado;
- `classified_occurrences` com arquivo, linha e classificação;
- `unresolved_contradictions`, que deve permanecer vazio na conclusão.

