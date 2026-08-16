# Auditoria de parser e entrada nao confiavel

## Objetivo

Detectar implementacoes que passam nos exemplos conhecidos, mas divergem entre modos do parser ou alteram o conteudo antes de validar tamanho, vazio, encoding, hash e identidade.

## 1. Classificar modos reais

Nao agrupar por rotulo comercial. Identificar as branches executadas pelo codigo, por exemplo:

- XML com declaracao;
- XML sem declaracao;
- SGML/cabecalho legado;
- modo estrito versus tolerante;
- delimitador ou versao de schema diferente.

Se uma condicao como `startsWith("<?xml")` muda o algoritmo, ela define modos distintos.

## 2. Inventariar campos e construir matriz tripla

Derivar `consumed_fields` das funcoes reais de leitura, seletores, schemas e adaptadores. Listar os invariantes e executar a matriz `accepted_modes x consumed_fields x field_scope_placements`. Em hierarquia, os posicionamentos minimos sao `direct`, `generic-container` e `scalar-container`; incluir tambem pai direto do registro, cardinalidade, metadado da secao, wrappers, namespaces e conteudo inativo.

Um teste em XML declarado nao comprova XML sem declaracao. Um wrapper desconhecido nao comprova tag escalar usada como contêiner. Uma tag financeira escolhida como exemplo nao comprova que todos os demais campos consumidos respeitam o mesmo escopo.

## 3. Rastrear o valor bruto

Inspecionar cada etapa entre a requisicao e o parser. Registrar:

- valor recebido;
- helper usado;
- `trim`, coercao, decode, normalizacao de linha ou canonicalizacao;
- ponto do limite em bytes;
- ponto do hash e da identidade;
- valor persistido ou descartado.

Controles obrigatorios:

- campo ausente;
- string vazia;
- somente espacos;
- limite exato;
- `limite + 1`;
- documento valido com excesso somente em espacos ou padding externo;
- bruto acima do limite que ficaria abaixo apos `trim`;
- BOM/encoding invalido;
- codigo publico exato e ausencia de efeitos.

## 4. Evidencia

Exigir simultaneamente chamada direta do parser e chamada pela fronteira publica real. A evidencia deve mostrar status/codigo/corpo, estado persistido e ausencia de dados sensiveis. Nome de teste ou CI verde nao basta.

## 5. Controles estaveis

Exigir evidencia executada e hasheada para os controles:

- `IP-RAW-001`: preservacao do bruto e limites antes de normalizacao;
- `IP-MODE-001`: paridade dos invariantes em todas as branches reais;
- `IP-SCOPE-001`: matriz completa modo x campo consumido x posicionamento;
- `IP-INACTIVE-001`: conteudo inativo nao influencia cardinalidade, metadado ou extracao;
- `IP-EFFECT-001`: rejeicao publica com codigo exato e zero efeito persistido.

Nenhum desses IDs pode ser satisfeito apenas pelo nome de um teste ou por uma amostra de campo.

## 6. Dimensoes canonicas

Usar estes IDs quando aplicaveis para permitir enforcement:

- `raw-boundary-preservation`;
- `validation-order-error-precedence`;
- `syntax-mode-invariant-matrix`;
- `scope-membership`;
- `inactive-content`;
- `cross-scope-context`.

Para formato hierarquico, as seis dimensoes sao obrigatorias. Cada controle deve ter pelo menos dois casos irmaos de modos, campos ou contêineres diferentes, e a cobertura deve incluir todos os campos do inventario consumido.
