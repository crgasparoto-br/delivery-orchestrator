# Gate de saturacao de risco antes do handoff

## Objetivo

Impedir que uma familia **ou uma superficie material da mesma familia** seja descoberta pela primeira vez na auditoria independente.

## Familias canonicas

Classificar explicitamente toda entrega nas familias:

- `authorization`;
- `tenant-isolation`;
- `public-boundary`;
- `reference-liveness`;
- `temporal-consistency`;
- `temporal-destination`;
- `concurrency-atomicity`;
- `idempotency`;
- `rollback`;
- `historical-immutability`;
- `structural-contract`;
- `documentation`.

Cada familia deve aparecer em `.audit/entregar-issue/risk-saturation.json` como `applicable=true|false`, com motivo. Familia aplicavel exige `status=passed`, `control_ids` e `dimensions` para **todas** as superficies declaradas na `requirement-attack-matrix.json`.

Cada entrada de `dimensions` deve possuir:

- `surface`: nome estavel da superficie;
- `reason`: por que a superficie e material;
- `control_ids`: controles negativos primarios cuja `risk_family + surface` coincida exatamente;
- `status=passed` no SHA congelado.

Uma familia nao esta saturada quando apenas uma de suas superficies esta verde. Exemplo: `authorization.environment=passed` nao permite fechar `authorization` se a arquitetura tambem expuser `filesystem`, `persistent-credential-store` ou outra superficie material.

## Varredura de saturacao

Antes do freeze:

1. rederivar familias a partir da especificacao, nao apenas do diff;
2. rederivar superficies a partir de requisitos, implementacao errada plausivel, entrypoints, processos, filesystem, stores persistentes, artifacts, estados e fronteiras publicas;
3. cruzar cada `family + surface` com controles negativos primarios executados;
4. procurar familias e superficies sem controle discriminante;
5. para cada lacuna, criar ataque antes de publicar candidato;
6. depois do primeiro finding interno, continuar a varredura barata por todos os requisitos/familias/superficies ainda nao saturados, nao apenas pela mesma causa raiz.

## Audit escapes

Quando existir `audit-escape-closure.json` com `status=passed`, cada escape deve declarar `required_attack_dimensions`. Cada item possui `risk_family`, `surface` e `dimension`. O gate de saturacao confirma que essas dimensoes existem de fato na matriz atual, inclusive quando aparecem como casos irmaos.

Para uma classe que escapou por um canal e reapareceu por outro, as dimensoes obrigatorias devem atravessar superficies. Nao aceitar fechamento de `role-secret-boundary-leak`, por exemplo, apenas com duas variacoes de `environment` quando filesystem ou credential store persistente estiverem presentes.

## Portao

Executar `scripts/validate_risk_saturation.py --attack-matrix ... --risk-saturation ...`. `material_families_missing_controls` deve estar vazio, toda superficie requerida deve possuir dimensao `passed` com controle correspondente, e todas as `required_attack_dimensions` de escapes fechados devem estar cobertas. Qualquer lacuna impede handoff.
