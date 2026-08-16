# Estrutura da entrega

Usar esta estrutura como padrão flexível. Omitir seções sem conteúdo real.

## Issue tratada

- Informar número e título da issue.
- Resumir como o escopo foi interpretado.
- Registrar divergências relevantes entre issue e repositório.

## Implementação

- Descrever as mudanças por comportamento ou bloco funcional.
- Citar arquivos ou módulos principais quando isso ajudar a revisão.
- Indicar alterações de frontend, backend, banco, integrações, testes ou documentação.

## Interface

Quando houver impacto visual, informar:

- arquitetura da informação e padrão de tela adotados;
- componentes e design system reutilizados;
- rotas, estados e viewports verificados;
- evidências visuais obtidas;
- parecer da verificação inicial de `design-interface`;
- limitações que impeçam validação visual completa.

## Documentação

- Listar instruções e documentos consultados.
- Informar caminhos das fontes canônicas presentes no diff, respectivas validações e estado final do registro compartilhado de impacto documental.
- Quando não houver alteração, registrar a justificativa objetiva da análise de impacto.
- Não usar descrição da PR, comentário de issue ou memória externa como substituto da documentação versionada necessária.

## Validações

Para cada comando executado, informar:

- comando;
- resultado;
- quantidade de testes quando disponível;
- falhas pré-existentes ou pendentes e seu impacto.

## GitHub

Quando aplicável, informar:

- branch usada ou criada;
- commits realizados;
- pull request criada ou atualizada;
- referência de fechamento da issue;
- confirmar que o merge não foi feito, salvo autorização explícita.

## Riscos e pendências

- Informar limitações, riscos de regressão, migrations, rollout ou dependências externas.
- Distinguir pendência bloqueante de melhoria futura.

## Próximo passo

Recomendar apenas o próximo passo mais relevante, como revisão da PR, validação manual específica, aplicação de migration ou autorização para merge.

## Modelo de descrição de pull request

```markdown
## Problema

[resumo do problema da issue]

## Solução

- [mudança principal]
- [mudança complementar]
- [testes]

## Documentação

- [arquivo presente no diff, atualizado e validado, ou justificativa de ausência de impacto]

## Validações

- `[comando]` — [resultado]
- `[comando]` — [resultado]

## Riscos e observações

- [risco, limitação ou "nenhum risco relevante identificado"]

Closes #[número]
```
