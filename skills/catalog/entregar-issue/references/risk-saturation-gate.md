# Gate de saturacao de risco antes do handoff

## Objetivo

Impedir que uma familia material de risco seja descoberta pela primeira vez na auditoria independente.

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

Cada familia deve aparecer em `.audit/entregar-issue/risk-saturation.json` como `applicable=true|false`, com motivo. Familia aplicavel exige `status=passed` e ao menos um `control_id` presente na `requirement-attack-matrix.json`.

## Varredura de saturacao

Antes do freeze:

1. rederivar familias a partir da especificacao, nao apenas do diff;
2. cruzar requisitos, flags, entrypoints, persistencia, estados e fronteiras publicas;
3. procurar familias sem controle discriminante;
4. para cada lacuna, criar ataque antes de publicar candidato;
5. depois do primeiro finding interno, continuar a varredura barata por todos os requisitos/familias ainda nao saturados, nao apenas pela mesma causa raiz.

## Portao

Executar `scripts/validate_risk_saturation.py --attack-matrix ... --risk-saturation ...`. `material_families_missing_controls` deve estar vazio. Familia aplicavel sem controle impede handoff.
