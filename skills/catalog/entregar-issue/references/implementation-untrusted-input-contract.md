# Fechamento de entrada nao confiavel

## Aplicabilidade

Usar para upload, arquivo textual/binario, parser, decoder, desserializador, lexer, tokenizer, adaptador de payload ou qualquer campo cujo valor bruto participe de tamanho, encoding, hash, idempotencia ou estrutura.

## Pipeline bruto

Mapear a cadeia real `transporte -> body parser -> helper de campo -> validador -> hash/identidade -> parser -> persistencia`. Para cada etapa, registrar se preserva, normaliza ou descarta bytes/caracteres.

Regras obrigatorias:

- Validar tipo e presenca sem alterar o valor.
- Separar `rawContent` de qualquer `normalizedContent`; nunca sobrescrever o bruto.
- Medir limite e calcular hash na representacao definida pelo contrato, antes de `trim`, normalizacao de quebra de linha, decode de entidade ou canonicalizacao.
- Distinguir campo ausente, arquivo vazio e arquivo somente com espacos pelo codigo publico esperado.
- Nao usar `requireString`, DTO coercivo ou schema com `trim()` para conteudo de arquivo quando isso alterar tamanho, vazio, hash ou diagnostico.
- Manter a mesma representacao em preview e criacao para impedir identidades divergentes.

## Matriz de modos

Enumerar todos os modos que ativam branches diferentes do parser. Para cada modo, executar os mesmos invariantes aplicaveis. Em formatos hierarquicos, incluir no minimo:

- registro como filho direto do contêiner canonico;
- campo como filho direto do registro;
- tag escalar usada como contêiner;
- wrapper conhecido, desconhecido e Unicode;
- namespace/prefixo;
- comentario, CDATA, escape ou exemplo inativo;
- metadado em secao concorrente;
- secao duplicada, aninhada, reordenada ou incompleta.

Se a declaracao ou cabecalho muda a branch do parser, incluir explicitamente a variante sem declaracao/cabecalho. Nao inferir que “XML” e uma unica modalidade.

## Inventario de campos consumidos e matriz tripla

Antes de escrever ou aceitar testes, derivar `consumed_fields` diretamente das chamadas de leitura, seletores, schemas e adaptadores usados pelo parser. O inventario deve incluir todo campo capaz de alterar data, valor, identidade, descricao, contexto, autorizacao ou persistencia.

Para formato hierarquico, classificar pelo menos estes posicionamentos:

- `direct`: campo como filho direto do registro canonico;
- `generic-container`: campo dentro de wrapper ou extensao conhecida, desconhecida ou Unicode;
- `scalar-container`: outro campo consumido usado como contêiner, por exemplo valor dentro de nome ou registro dentro de memo.

Construir a matriz completa `accepted_modes x consumed_fields x field_scope_placements`. Cada celula deve declarar se e valida ou deve ser rejeitada, com justificativa quando nao aplicavel. Nao usar um unico campo representativo para comprovar todos os leitores: se o parser consome seis tags, as seis devem aparecer no inventario e na matriz ou possuir justificativa canonica individual.

## Ordem de validacao e erros

Definir e testar a precedencia observavel:

1. corpo/objeto valido;
2. campo presente e do tipo correto;
3. vazio conforme representacao bruta;
4. limite em bytes;
5. encoding;
6. estrutura;
7. semantica e elegibilidade;
8. persistencia.

A ordem pode variar apenas se a fonte canonica definir outra. O teste deve confirmar o codigo exato, nao somente que ocorreu erro.

## Controles discriminantes obrigatorios

Executar e registrar estes IDs estaveis quando aplicaveis:

- `IP-RAW-001`: campo ausente, vazio, somente espacos, limite exato, `limite + 1` e documento valido acrescido de padding externo que ultrapassa o limite; todos medidos antes de `trim`, decode ou canonicalizacao.
- `IP-MODE-001`: o mesmo invariante executado em cada branch real, inclusive variante sem declaracao, cabecalho, marcador ou delimitador que altere a estrategia.
- `IP-SCOPE-001`: matriz completa `modo x campo consumido x posicionamento`, incluindo filho direto, wrapper generico e outro campo escalar usado como contêiner.
- `IP-INACTIVE-001`: comentarios, CDATA, escapes, exemplos e blocos inativos nao contam para cardinalidade nem viram registros ou metadados ativos.
- `IP-EFFECT-001`: toda rejeicao pela fronteira publica confirma codigo/status exatos, zero persistencia, zero mutacao financeira e auditoria/log redigidos.

O controle de tamanho deve incluir separadamente `limite + 1` e um arquivo semanticamente valido cujo excesso esteja somente em espacos ou padding nas bordas; testar apenas um payload grande dentro do envelope nao detecta normalizacao prematura. Cada caso literal deve ter pelo menos dois casos irmaos de modos, campos ou contêineres diferentes.

## Fechamento

Nao declarar o requisito concluido enquanto a matriz de modos, o inventario integral de campos consumidos, a matriz tripla, a cadeia de transformacoes, os controles `IP-*` e a precedencia de erros nao estiverem registrados e executados. CI verde, amostra de uma tag e teste de parser isolado nao comprovam que a rota preserva o valor bruto ou aplica o mesmo escopo a todos os campos.
