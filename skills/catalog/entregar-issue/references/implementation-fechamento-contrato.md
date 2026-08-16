# Fechamento do contrato da issue

## Matriz obrigatória

Antes de editar, mapear cada requisito atômico para todas as camadas necessárias:

- modelo e tipos;
- schema e persistência;
- serviço e regras;
- API e serialização pública;
- seed, fixtures ou migração;
- interface e estados visíveis;
- testes executáveis;
- documentação canônica.

Célula vazia exige justificativa baseada no contrato, não na solução escolhida. Quando a Entregar Issuea fornecer snapshot e `requirement-closure.json`, usar esses artefatos sem remover, resumir ou reclassificar obrigações.

## Extensão para contratos transitivos de runtime

Quando houver infraestrutura de IA, provider, adapter ou executor, expandir a matriz para `registry`, `required_operations`, `execution_state`, `executor_guard`, `adapter_method`, `adapter_implementation`, `sdk_translation`, `consumer_request`, `integration_test`, `legacy_variant` e `documentation_claim`.

A matriz permanece aberta quando o resolvedor classifica estado mas o executor ainda chama, o sinal não chega ao adapter, a matriz declara operação sem método, o request aceita campo ignorado, compatibilidade é inferida de arquivo não alterado ou documentação afirma garantia sem teste discriminante.

## Verbos não equivalentes

Tratar separadamente:

- `referenciar`: guardar vínculo íntegro com a origem;
- `consumir`: ler os dados relevantes da origem;
- `alimentar`: usar os dados como entrada de outra decisão;
- `impactar`: alterar resultado, alerta, restrição ou comportamento;
- `gerar` ou `derivar`: produzir saída calculada a partir da fonte.

Guardar um ID não comprova consumo. Aceitar um alerta enviado pelo cliente não comprova que o backend o derivou. Cada verbo exige cenário e controle negativo próprios.

## Catálogos e planilhas

Quando o contrato citar equivalência, planilha, aba, siglas, métodos, parâmetros ou catálogo:

1. preservar a fonte e sua extração textual;
2. enumerar todos os valores canônicos;
3. mapear cada valor para persistência, seed, consumidor e teste;
4. manter `unmapped_values` vazio;
5. não substituir catálogo explícito por exemplos genéricos ou seed mínimo.

## Contrato público

O tipo compartilhado, schema de saída e JSON HTTP real devem coincidir. Usar serializer ou DTO explícito quando entidades internas diferirem do contrato público. Validar a resposta real com o schema público e criar controle negativo que falhe quando nomes, cardinalidades ou estruturas internas vazarem.

## Fidelidade dos testes

Um teste só comprova a alegação quando alcança a condição declarada. Registrar precondições e usar dados que atravessem validações anteriores.

Para isolamento, testar separadamente aluno, objetivo, prescrição, parâmetro e demais recursos de outro tenant. Para concorrência, executar a versão obsoleta na fronteira pública. Nome amplo de teste não substitui cenários distintos.

## Documentação e PR

Não escrever `pendente`, `próxima evolução`, `apenas backend`, `não implementa` ou equivalente para obrigação ainda vigente. Primeiro atualizar a fonte canônica de escopo ou criar e vincular a issue de destino. Entrega parcial deve manter a issue pai aberta e usar referência não conclusiva na PR.

## Fechamento campo a campo

Quando houver histórico/versionamento, coleção/paginação ou o mesmo conceito em múltiplas superfícies, a matriz deve incluir `required_fields`, `canonical_source`, `public_projection`, `consumer`, `visible_surface`, `negative_control` e `documentation_sources`.

Saída produzida sem consumidor, campo removido na projeção pública, superfície não exercitada ou fixture sem divergência mantém a célula aberta. Timeline de evento não substitui histórico detalhado de valores.

