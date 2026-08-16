# Portões de contratos transitivos de runtime

Aplicar estes portões quando a mudança introduzir ou alterar resolvedores, executores, políticas de retry/fallback, adapters, providers, matrizes de suporte, tradução de requests, compatibilidade legada ou afirmações técnicas normativas.

O objetivo é provar que a decisão percorre todas as camadas até a chamada externa correta — ou é bloqueada antes dela — sem depender de disciplina informal dos callers.

## F28 — Elegibilidade de execução

Aplicar quando houver estados como `ready`, `degraded`, `disabled`, `invalid`, `configured` ou `unavailable`.

Inventariar `execution_state_boundaries` com a fronteira comum, estados executáveis, estados bloqueados e o ponto de validação anterior ao primeiro callback, adapter ou SDK.

Executar pelo resolvedor e executor integrados:

- `ready`: primário pode executar;
- `degraded` com primário válido: primário pode executar e fallback inelegível não executa;
- `disabled`: zero chamadas externas;
- `invalid`: zero chamadas externas;
- segredo ausente: zero chamadas externas;
- operação incompatível: zero chamadas externas;
- timeout ou tentativas inválidos: zero chamadas externas.

Não aceitar teste isolado que apenas confira o valor de `state`. A fronteira comum deve aplicar a proibição.

## F29 — Propagação de controle operacional

Aplicar quando houver timeout, retry, fallback, `AbortSignal`, deadline, cancelamento ou contexto de tentativa.

Inventariar `control_propagation_paths` para cada controle:

`executor -> callback -> contrato do adapter -> implementação -> SDK/HTTP`.

Provar criação, passagem pelo tipo público, recebimento pelo adapter, propagação pela implementação, recebimento pela chamada SDK/HTTP e encerramento da chamada anterior antes de retry/fallback.

Mockar o SDK externo é permitido. Mockar toda a cadeia depois do executor não comprova integração.

## F30 — Fechamento capacidade–operação–adapter

Aplicar quando houver registro de capacidades, matriz de suporte, provider/modelo ou adapters.

Inventariar `capability_operation_mappings` com capacidade, consumidores reais, recursos usados nos requests, operações requeridas, adapters elegíveis, método do contrato, implementação local, teste de integração e rejeição local para operação não suportada.

Regras:

- `tools` de busca implicam `web_search`;
- imagem implica `vision`;
- schema implica `structured_output`;
- chamada de embeddings implica `embeddings`;
- áudio implica `transcription`;
- geração e edição permanecem separadas quando os contratos forem distintos;
- capacidade disponível no SDK upstream não significa suporte no adapter do projeto.

Uma operação declarada sem método, implementação ou teste reprova.

## F31 — Tradução fail-closed

Aplicar quando um request comum for traduzido para contratos específicos de provider ou integração.

Inventariar `request_translation_mappings` para cada campo aceito pelo request comum, com disposição `translated`, `validated`, `rejected-pre-network` ou `not-applicable-by-contract`.

Cobrir ferramentas, schemas e keywords, mídia/MIME, áudio, metadados, formato de resposta, timeout/cancelamento e opções específicas do provider.

Executar recurso suportado até o SDK e recurso não suportado com erro local e zero chamadas ao SDK. Ignorar silenciosamente um campo recebido reprova.

## F32 — Compatibilidade legada por variante

Aplicar quando o contrato exigir preservar consumidores atuais, variáveis legadas, modelos, providers ou ausência de mudança observável.

Inventariar `legacy_compatibility_matrix` por consumidor e variante funcional, incluindo quando aplicável texto, visão, Structured Output, ferramentas, embeddings, áudio, imagem, modelo/provider legado e formato real de URL, payload ou mídia.

Cada variante deve ser exercitada pelo entrypoint real. Teste direto do adapter não comprova o consumidor; teste textual não comprova visão.

## F33 — Veracidade documental executável

Aplicar quando documentação alterada afirmar que o sistema suporta, garante, rejeita, preserva, nunca executa, sempre executa, executa somente sob condição, bloqueia antes da rede ou funciona ponta a ponta.

Inventariar `documentation_claim_inventory` com documento, localização, afirmação normativa, contrato/código que deveria realizá-la, teste discriminante e controle negativo.

Exigir ligação `documento -> runtime -> teste`. Documentação criada no próprio diff não comprova o comportamento descrito.

## Evidência mínima comum

Para F28 a F33 exigir cenário executado derivado do contrato, evidência discriminante, controle negativo, inventário sem pendências, pesquisa fora do diff e documentação alinhada somente depois da prova executável.

## F34 — Entrada nao confiavel

F34 e complementar a F28-F33. Exigir parser direto e fronteira publica, matriz completa de modos e invariantes, inventario de campos, matriz modo x campo x posicionamento, preservacao do valor bruto antes de tamanho/encoding/hash, controles `IP-*` e codigos de erro discriminantes.
