# Catalogo cumulativo de padroes de audit escape

## Objetivo

Transformar cada escape independente em conhecimento reutilizavel, evitando reincidencia na mesma issue e em issues futuras do repositorio.

## Artefato local

Manter `.audit/entregar-issue/audit-escape-pattern-catalog.json`. Para cada escape fechado registrar:

- `escape_class` generalizavel;
- `trigger_terms` e sinais estruturais;
- `plausible_wrong_implementation`;
- `required_risk_families`;
- controles preventivos e detectivos com IDs estaveis;
- casos irmaos reutilizaveis;
- issue/SHA de origem.

Antes de planejar uma nova issue, consultar o catalogo e ativar os padroes cujos `trigger_terms` ou estruturas estejam presentes no contrato atual.

## Padroes semente

- `stale-reference-after-approval`: referencia valida em preparacao/aprovacao deixa de existir ou muda de elegibilidade antes de release/execucao -> ativar `reference-liveness`;
- `temporal-destination-drift`: data valida sintaticamente, mas fora do periodo/futuro exigido -> ativar `temporal-destination`;
- `canonical-path-divergence`: caminho especializado replica/intercepta fonte canonica -> ativar `structural-contract`;
- `public-boundary-enumeration`: backend distingue recurso inexistente, inelegivel ou cross-tenant -> ativar `public-boundary` + `tenant-isolation`.

## Atualizacao

Depois de cada `audit-escape-closure.json` aprovado, incorporar o escape ao catalogo antes de novo handoff. A correcao do caso literal sem catalogacao deixa a prevencao incompleta.
