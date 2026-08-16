# Matriz obrigatoria requisito -> ataque

## Objetivo

Impedir que um criterio de aceite ou cenario obrigatorio chegue pela primeira vez a auditoria independente sem ter sido transformado em um controle discriminante executado no SHA final.

## Aplicabilidade

Aplicar a toda entrega com requisito comportamental, invariantes de estado, persistencia, autorizacao, referencia, data, concorrencia, historico, fronteira publica ou integracao. Documentacao isolada pode usar controles de contradicao em vez de runtime.

## Artefato

Produzir `.audit/entregar-issue/requirement-attack-matrix.json` antes do freeze. Cada requisito coberto deve possuir:

- `requirement_id` e `obligation_ids`;
- `risk_families` derivadas da especificacao e do diff;
- `plausible_wrong_implementation`: uma implementacao errada que ainda passaria no caminho feliz;
- `positive_control` executado no SHA final;
- ao menos um `negative_control` discriminante executado no SHA final;
- `sibling_cases` que variem a dimensao atacada;
- `regression_controls` executados no SHA final.

Requisito sem ataque nao esta fechado, mesmo que exista teste nominalmente relacionado.

## Derivacao de ataques

Converter linguagem contratual em ataques, nao apenas em assercoes felizes. Exemplos:

- `continua valido`, `continua acessivel`, `revalidar`, `no momento da liberacao`, `apos aprovacao` -> `reference-liveness`;
- `futuro`, `passado`, `semana`, `periodo`, `vigencia`, `data alvo` -> `temporal-destination`;
- `mesmo contrato`, `outro tenant`, `escopo` -> `tenant-isolation`;
- `nao duplicar`, `duas chamadas concorrentes`, `retry` -> `idempotency`/`concurrency-atomicity`;
- `rollback`, `sem estado parcial` -> `rollback`;
- `historico`, `imutavel`, `nova revisao` -> `historical-immutability`;
- `nao revelar`, `404 generico`, `permissao` -> `public-boundary`/`authorization`.

## Qualidade minima

Um controle negativo deve responder: "esta implementacao plausivel e errada falharia aqui?". Se nao, o controle nao fecha o requisito.

Para familias materiais (`authorization`, `tenant-isolation`, `public-boundary`, `reference-liveness`, `temporal-destination`, `concurrency-atomicity`, `idempotency`, `rollback`, `historical-immutability`), exigir pelo menos dois `sibling_cases` por controle negativo. Para demais familias, exigir pelo menos um.

## Portao

Executar `scripts/validate_requirement_attack_matrix.py --requirement-closure ... --attack-matrix ...`. Qualquer requisito coberto sem ataque, evidencia, regressao, caso irmao ou SHA correto impede `INTERNALLY_APPROVED` e handoff independente.
