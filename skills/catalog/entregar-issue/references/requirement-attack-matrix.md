# Matriz obrigatoria requisito -> ataque

## Objetivo

Impedir que um criterio de aceite, superficie de risco ou cenario obrigatorio chegue pela primeira vez a auditoria independente sem ter sido transformado em um controle discriminante executado no SHA final.

## Aplicabilidade

Aplicar a toda entrega com requisito comportamental, invariantes de estado, persistencia, autorizacao, referencia, data, concorrencia, historico, fronteira publica ou integracao. Documentacao isolada pode usar controles de contradicao em vez de runtime.

## Artefato

Produzir `.audit/entregar-issue/requirement-attack-matrix.json` antes do freeze. Cada requisito coberto deve possuir:

- `requirement_id` e `obligation_ids`;
- `risk_families` derivadas da especificacao e do diff;
- `risk_surfaces`: todas as superficies materiais pelas quais a mesma familia pode falhar, cada uma com `risk_family`, `surface` e `reason`;
- `plausible_wrong_implementation`: uma implementacao errada que ainda passaria no caminho feliz;
- `positive_control` executado no SHA final;
- ao menos um `negative_control` discriminante **primario por superficie material** executado no SHA final;
- `sibling_cases` que variem pares `surface + dimension`, nao apenas valores do mesmo fixture;
- `regression_controls` executados no SHA final.

Requisito sem ataque ou com superficie declarada sem controle primario nao esta fechado, mesmo que exista teste nominalmente relacionado.

## Superficies e dimensoes

Familia de risco nao e superficie. Para `authorization`, por exemplo, a mesma classe pode atravessar `environment`, `filesystem`, `persistent-credential-store`, `artifact-export`, `process-identity`, endpoint ou storage. Para cada superficie realmente exposta pela arquitetura, criar uma entrada em `risk_surfaces` e um controle negativo cujo `surface` corresponda exatamente.

Nao omitir superficie evidente para fazer o gate passar. O validador rederiva um conjunto minimo de superficies sensiveis a partir da implementacao errada e dos procedimentos declarados. Sinais como `process.env`/`extraEnv`, `private key`/filesystem, `CODEX_HOME`/`auth.json`, artifact upload e mesma identidade de processo ativam respectivamente as superficies genericas correspondentes. A inferencia automatica e apenas piso de seguranca; a entrega continua responsavel por declarar outras superficies derivaveis da arquitetura.

Cada `negative_control` deve registrar:

- `id`;
- `risk_family`;
- `surface`;
- `dimension`;
- `failure_mode`;
- `plausible_wrong_implementation`;
- `control_type`: `test`, `gate`, `scenario` ou `procedure`;
- `procedure`, `expected` e `observed`;
- `evidence_path`/`evidence` e `evidence_sha256`;
- `head_sha` e `status=passed`;
- `sibling_cases` com `id`, `surface`, `dimension` e `status`.

## Derivacao de ataques

Converter linguagem contratual em ataques, nao apenas em assercoes felizes. Exemplos:

- `continua valido`, `continua acessivel`, `revalidar`, `no momento da liberacao`, `apos aprovacao` -> `reference-liveness`;
- `futuro`, `passado`, `semana`, `periodo`, `vigencia`, `data alvo` -> `temporal-destination`;
- `mesmo contrato`, `outro tenant`, `escopo` -> `tenant-isolation`;
- `nao duplicar`, `duas chamadas concorrentes`, `retry` -> `idempotency`/`concurrency-atomicity`;
- `rollback`, `sem estado parcial` -> `rollback`;
- `historico`, `imutavel`, `nova revisao` -> `historical-immutability`;
- `nao revelar`, `404 generico`, `permissao` -> `public-boundary`/`authorization`;
- segredo ou credencial atravessando papeis -> enumerar todos os canais tecnicamente acessiveis, por exemplo ambiente, filesystem, credential store persistente, artifacts e identidade de processo.

## Qualidade minima

Um controle negativo deve responder: "esta implementacao plausivel e errada falharia aqui?". Se nao, o controle nao fecha o requisito.

Para familias materiais (`authorization`, `tenant-isolation`, `public-boundary`, `reference-liveness`, `temporal-destination`, `concurrency-atomicity`, `idempotency`, `rollback`, `historical-immutability`), exigir pelo menos dois `sibling_cases` com pares `surface + dimension` distintos por controle negativo. Quando houver mais de uma superficie material, a matriz deve demonstrar ataque cross-surface; duas variacoes dentro de `environment`, por exemplo, nao fecham uma classe que tambem possui `filesystem`.

## Portao

Executar `scripts/validate_requirement_attack_matrix.py --requirement-closure ... --attack-matrix ...`. Qualquer requisito coberto sem ataque, superficie, evidencia hasheada, regressao, caso irmao discriminante ou SHA correto impede `INTERNALLY_APPROVED` e handoff independente.
