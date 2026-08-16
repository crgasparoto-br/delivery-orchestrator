# Fechamento de infraestrutura, adapters e políticas de runtime

Aplicar quando a issue criar ou alterar registro de capacidades, resolvedor, executor comum, retry/fallback, timeout, cancelamento, provider, adapter, matriz de suporte ou tradução de request.

## Matriz obrigatória

Mapear cada requisito para tipo público, registro, resolvedor, estado e elegibilidade, política executável, interface do adapter, implementação, SDK/HTTP, consumidor, teste unitário, teste de integração, compatibilidade legada por variante e documentação canônica.

Célula vazia exige justificativa derivada do contrato. Não usar “será implementado pelo consumidor futuro” para fechar garantia pedida à fundação.

## Fronteira comum aplica a regra

Quando o contrato pedir executor ou fronteira única:

- bloquear `invalid` e `disabled` antes do primeiro callback;
- não depender de cada caller lembrar de validar o estado;
- propagar timeout, deadline, cancelamento e contexto de tentativa até o SDK;
- aguardar encerramento antes de retry/fallback;
- impedir terceiro modelo, retorno ao primário e paralelismo quando proibidos.

## Suporte significa execução local disponível

Declarar uma operação como suportada somente quando existirem método no contrato, implementação local, tradução até o SDK/HTTP, teste de integração e rejeição local para operação não suportada.

Capacidade do SDK upstream não comprova suporte no adapter do projeto. Não expandir suporte por enum sem inventário individual.

## Tradução fail-closed

Para cada campo aceito pelo request comum, traduzir, validar, rejeitar antes da rede ou declarar não aplicável pelo contrato. Nunca ignorar silenciosamente tools, schemas, keywords, mídia, MIME, áudio, metadados, formatos ou sinais de cancelamento.

## Compatibilidade legada

Criar matriz por consumidor e variante funcional. Exercitar pelo entrypoint real texto, visão, schema, ferramentas, embeddings, áudio, imagem e variáveis legadas conforme aplicável.

Ausência de import novo ou arquivo não alterado não comprova equivalência observável.

## Testes mínimos

- configuração `invalid` e `disabled` com callback espião: zero chamadas;
- timeout pelo adapter real com SDK mockado e sinal observado;
- operação declarada sem método falha no gate;
- recurso não suportado é rejeitado antes do SDK;
- consumidores irmãos com recursos diferentes geram operações diferentes;
- cada variante legada relevante é exercitada separadamente;
- afirmações normativas da documentação possuem teste discriminante correspondente.
