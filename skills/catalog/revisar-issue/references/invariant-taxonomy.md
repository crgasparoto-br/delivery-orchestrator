# Taxonomia de requisitos e invariantes

## Objetivo

Fazer a especificacao distinguir comportamento desejado de restricoes que uma implementacao funcional ainda pode violar.

Para cada requisito material, classificar zero ou mais campos:

- `must_behave`: comportamento/public outcome exigido;
- `must_not_behave`: comportamento proibido;
- `must_reuse`: parser, executor, fonte, contrato ou componente que deve ser reutilizado;
- `must_be_single_source`: vocabulario, regra ou estado que nao pode possuir fontes concorrentes;
- `must_not_depend_on`: provider, LLM, fallback, horario, cache ou outro mecanismo que nao pode ser necessario para o caso principal;
- `precedence_invariants`: ordem entre parser/handler/fallback/fonte que nao pode degradar a informacao;
- `forbidden_implementation`: implementacao plausivel explicitamente proibida mesmo quando o resultado final parece correto.

Sempre que a issue usar expressoes como `nao criar`, `nao manter`, `reutilizar`, `canonica`, `fonte de verdade`, `nao depender`, `nao interceptar`, `nao cair novamente no fallback` ou equivalentes, produzir pelo menos uma invariavel verificavel na categoria apropriada.

A invariavel deve declarar como uma implementacao errada poderia ainda passar no caminho feliz e qual controle a distinguiria.
