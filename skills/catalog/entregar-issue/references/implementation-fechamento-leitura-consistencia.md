# Fechamento de leitura, fonte canônica e documentação concorrente

## Quando aplicar

Aplicar quando a issue mencionar histórico, versões, autoria, origem, supersessão, vigência, paginação, coleção, timeline, fonte canônica, coerência entre superfícies, alteração de rota, substituição, redirect ou aposentadoria de fluxo.

## Matriz campo a campo

Para cada requisito, registrar:

| Campo | Conteúdo obrigatório |
|---|---|
| `required_fields` | dados e metadados explicitamente exigidos |
| `canonical_source` | fonte autoritativa do conceito |
| `producer` | serviço/repositório que produz o dado |
| `public_projection` | schema/DTO/serializer realmente exposto |
| `consumer` | hook/query/caller que consome a projeção |
| `visible_surface` | rota, aba, card, tabela ou relatório onde o usuário observa |
| `negative_control` | implementação incompleta que deve fazer o teste falhar |
| `documentation_sources` | fontes versionadas que descrevem o comportamento |

Não aceitar `serviço existe`, `componente existe`, `endpoint retorna` ou `timeline registra` como fechamento integral.

## Histórico e versionamento

Separar sempre:

1. estado atual;
2. coleção histórica;
3. metadados históricos, incluindo autoria, origem, vigência e supersessão quando solicitados;
4. descoberta, ordenação e paginação;
5. apresentação somente leitura;
6. teste com pelo menos duas versões deliberadamente diferentes.

O teste deve falhar quando a interface mostra somente a versão atual, quando o DTO remove metadados ou quando o backend produz uma coleção sem consumidor.

## Fonte canônica em múltiplas superfícies

Declarar a fonte canônica antes de implementar. Pesquisar todos os consumidores do mesmo conceito. Criar fixture em que a fonte canônica e cada fonte alternativa tenham valores diferentes. Confirmar a mesma regra no cabeçalho, resumo, lista, detalhe, relatório e formulário aplicáveis.

## Mudança de contrato documentado

Quando um fluxo for renomeado, substituído, aposentado ou mantido apenas como redirect:

1. listar termos, rotas e frases do contrato antigo;
2. listar termos e rotas do contrato novo;
3. pesquisar o repositório inteiro, não apenas o diff;
4. classificar cada ocorrência como atual, histórica, legado aposentado, compatibilidade, exemplo ou contradição;
5. corrigir toda fonte canônica que ainda descreva o comportamento antigo como atual;
6. repetir a busca no SHA final.

## Condição de conclusão

Não declarar a entrega pronta enquanto houver saída não consumida, campo exigido não mapeado, superfície sem teste divergente ou contradição documental não resolvida.
