# Gate de invariantes estruturais e caminhos canonicos

## Objetivo

Impedir que um candidato passe apenas porque o caminho feliz funciona quando a especificacao tambem proibe uma arquitetura, precedencia, dependencia ou fonte concorrente. Tratar `nao criar`, `nao manter`, `reutilizar`, `fonte canonica`, `nao depender`, `nao interceptar`, `nao cair no fallback` e equivalentes como requisitos verificaveis de primeira classe.

## Taxonomia obrigatoria

Classificar obrigacoes aplicaveis com uma ou mais familias:

- `structural`: restricao sobre arquitetura, compartilhamento, acoplamento ou forma de implementacao;
- `forbidden-implementation`: uma implementacao plausivel e explicitamente proibida;
- `canonical-path`: um caminho especializado deve reutilizar ou permanecer semanticamente equivalente ao caminho canonico;
- `dependency-independence`: o comportamento deve continuar correto sem uma dependencia opcional/fallback/provider;
- `precedence`: ordem de parsers, handlers, fallbacks ou fontes altera a correcao.

Nao considerar requisito estrutural fechado apenas porque um teste end-to-end termina com a resposta correta.

## `CANON-DIVERGENCE-001`

Aplicar quando coexistirem caminho especializado e caminho canonico para a mesma intencao/acao.

1. Escolher uma entrada que ambos reconhecem ou deveriam reconhecer.
2. Executar a mesma entrada nos dois caminhos antes da compensacao posterior.
3. Comparar todos os campos de dominio materialmente relevantes, inclusive ausencia/presenca, normalizacao e destino.
4. A implementacao errada plausivel e: o caminho especializado produz representacao mais pobre e um handler posterior mascara a perda reexecutando o caminho canonico.
5. O controle falha se o especializado perder, inventar ou contradizer qualquer campo que o canonico preserve, mesmo que o resultado publico final seja corrigido depois.
6. Repetir pelo menos dois casos irmaos variando dimensoes que causam divergencia, como verbo/preposicao, alias/acentuacao, ordem ou fallback.
7. Se houver vocabulario/regex/enum equivalente duplicado em mais de um caminho, exigir uma unica fonte compartilhada ou evidencia de que a duplicacao e deliberadamente gerada e testada contra divergencia.

O resultado deve ser evidenciado no SHA congelado e registrado em `structural_invariant_closures`.

## Fechamento

`structural_invariant_closures.status=passed` somente quando:

- toda obrigacao estrutural coberta estiver ligada a uma entrada;
- cada entrada declarar a implementacao errada plausivel;
- houver evidencia positiva e controle negativo discriminante;
- cenarios irmaos tiverem sido exercitados quando houver dimensoes equivalentes baratas;
- `unresolved_invariants=[]`.

Usar `not-applicable` somente quando nenhuma obrigacao da especificacao possuir familia estrutural.
