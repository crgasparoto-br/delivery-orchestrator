# Desenho de controles adversariais

## Regra central

Um controle negativo nao e um nome de teste. Ele deve provar que uma implementacao plausivel, mas incorreta, seria rejeitada no SHA auditado.

Para cada requisito implementado, produzir `negative_controls` e `negative_control_evidence` com correspondencia exata de IDs. Cada evidencia deve declarar familia de risco, dimensao, modo de falha, implementacao errada plausivel, procedimento reproduzivel, resultado esperado, resultado observado, SHA e arquivo hasheado.

## Metodo

1. Escrever a implementacao errada plausivel em uma frase.
2. Construir dados em que a implementacao correta e a errada produzam resultados diferentes.
3. Executar pela fronteira real quando possivel.
4. Confirmar resultado publico, estado persistido e ausencia de efeitos indevidos.
5. Variar ao menos um caso irmao para evitar ajuste ao exemplo literal.
6. Registrar evidencia bruta; nome de teste ou CI verde nao basta.

## Entradas estruturadas

Para parsers, decoders, desserializadores e adaptadores de entrada nao confiavel, verificar dimensoes adequadas ao formato:

- fronteiras, truncamento e encoding;
- ambiguidade e precedencia;
- pertencimento do registro ao container ou secao canonica;
- conteudo comentado, escapado ou inativo;
- metadados capturados da secao errada;
- secoes multiplas, duplicadas, aninhadas ou reordenadas;
- limites de tamanho e ausencia de efeitos parciais.

Em formatos hierarquicos, nao aceitar como prova a mera presenca global de um token, tag ou chave. Demonstrar que o registro e o contexto pertencem ao mesmo escopo estrutural.

## Documentacao

Quando a mudanca altera disponibilidade, estado atual, rota canonica, nomenclatura ou arquitetura, executar busca por alegacoes antigas em todo o repositorio, inclusive fora do diff. Uma fonte atual contraditoria e finding bloqueante mesmo quando o documento novo esta correto.

## Fechamento reforcado para entrada nao confiavel

Para parser ou upload, nao encerrar com “tres dimensoes” genericas. Exigir `raw-boundary-preservation`, `validation-order-error-precedence` e `syntax-mode-invariant-matrix`. Em formato hierarquico, exigir tambem `scope-membership`, `inactive-content` e `cross-scope-context`.

A matriz deve identificar todas as branches aceitas, todos os campos efetivamente consumidos e os posicionamentos `direct`, `generic-container` e `scalar-container`. Se uma declaracao, cabecalho, versao ou delimitador altera a estrategia de parsing, criar caso proprio. Nao aceitar um unico campo representativo. Incluir cada campo consumido dentro de outro campo escalar, alem de `limite + 1` e documento valido com excesso somente em padding externo que desapareceria apos `trim`; esses casos detectam lacunas que wrappers obvios e arquivos grandes comuns nao detectam. Usar os IDs `IP-RAW-001`, `IP-MODE-001`, `IP-SCOPE-001`, `IP-INACTIVE-001` e `IP-EFFECT-001`.


## Fronteira publica, banco e mensagens de erro

Aplicar o controle reutilizavel `PB-ERR-001` quando uma rota chama banco, fila, cache ou provider:

1. Injetar uma falha inesperada do adapter com `code=P0001` ou SQLSTATE equivalente e mensagem contendo marcadores `fingerprint`, `idempotencyKey` e um valor financeiro.
2. Executar pela rota publica.
3. Exigir 5xx com codigo generico, mensagem fixa e `correlationId`.
4. Provar que codigo bruto, SQLSTATE, mensagem, SQL, stack e marcadores nao aparecem no payload.
5. Provar rollback e ausencia de chave, evento, timestamp ou registro parcial.

Para campos tipados como UUID ou identificador estruturado, testar o caso literal e pelo menos dois casos irmaos com papeis diferentes. Exemplo: `accountId`, `destinationAccountId` e `categoryId`. O controle deve exigir 4xx de contrato antes do adapter e falhar se o banco responder `22P02`, mensagem de cast ou erro interno.

Mapeamento de constraint conhecido deve ser testado com `error.message` deliberadamente sensivel; a resposta deve usar exclusivamente o texto estatico do contrato.

## Retry e idempotencia na interface

Quando o requisito pertence a um formulario web:

- usar navegador real e entrypoint real;
- provocar timeout ou falha de rede depois que a chave foi formada;
- verificar uma chamada por confirmacao e a mesma chave no retry ambiguo;
- provocar erro de validacao definitivo, corrigir materialmente o payload e verificar chave nova;
- disparar duas submissoes no mesmo turno e provar uma unica chamada;
- consultar a persistencia depois do fluxo para excluir duplicacao;
- cobrir os viewports e teclado exigidos no contrato.

Leitura do source, regex, snapshot estatico ou workflow visual sem o cenario especifico sao evidencias auxiliares, nunca o controle discriminante principal.
