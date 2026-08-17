# Catalogo cumulativo de padroes de audit escape

## Objetivo

Transformar cada escape independente em conhecimento reutilizavel, evitando reincidencia na mesma issue e em issues futuras do repositorio.

## Artefato local

Manter `.audit/entregar-issue/audit-escape-pattern-catalog.json`. Para cada escape fechado registrar:

- `escape_class` generalizavel;
- `trigger_terms` e sinais estruturais;
- `plausible_wrong_implementation`;
- `required_risk_families`;
- `required_attack_dimensions`, com `risk_family`, `surface` e `dimension`;
- controles preventivos e detectivos com IDs estaveis;
- casos irmaos reutilizaveis;
- issue/SHA de origem.

Antes de planejar uma nova issue, consultar o catalogo e ativar os padroes cujos `trigger_terms` ou estruturas estejam presentes no contrato atual. Quando um padrao for ativado, copiar suas `required_attack_dimensions` aplicaveis para a derivacao da nova `requirement-attack-matrix.json`; nao reduzir o padrao apenas a `required_risk_families`.

Se a arquitetura atual expuser uma superficie adicional da mesma classe, ampliar a matriz e os controles antes do freeze. O catalogo e piso cumulativo, nao lista fechada de canais.

## Padroes semente

- `stale-reference-after-approval`: referencia valida em preparacao/aprovacao deixa de existir ou muda de elegibilidade antes de release/execucao -> ativar `reference-liveness` e suas superficies de armazenamento/consumo;
- `temporal-destination-drift`: data valida sintaticamente, mas fora do periodo/futuro exigido -> ativar `temporal-destination`;
- `canonical-path-divergence`: caminho especializado replica/intercepta fonte canonica -> ativar `structural-contract`;
- `public-boundary-enumeration`: backend distingue recurso inexistente, inelegivel ou cross-tenant -> ativar `public-boundary` + `tenant-isolation`;
- `role-secret-boundary-leak`: segredo ou credencial de um papel pode chegar a outro -> ativar `authorization` e enumerar canais acessiveis como `environment`, `filesystem`, `persistent-credential-store`, `artifact-export` e `process-identity` quando presentes.

## Atualizacao

Depois de cada `audit-escape-closure.json` aprovado, incorporar o escape ao catalogo com `required_attack_dimensions` antes de novo handoff. A correcao do caso literal sem catalogacao ou sem transportar as superficies/dimensoes deixa a prevencao incompleta.
