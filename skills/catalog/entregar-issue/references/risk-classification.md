# Classificacao do perfil de risco

## Deteccao

Executar `scripts/detect_risk_profile.py` sobre o diff e o contexto do repositorio. O detector produz sinais com confianca, caminhos e trechos correspondentes.

Sinais principais:

- persistencia: ORM, repository, schema, migrations, SQL, storage, cache duravel;
- fallback: `catch`, memoria, cache, degradacao, provider alternativo, retry;
- visual: paginas, componentes, estilos, templates, rotas de frontend;
- autorizacao/privacidade: tenant, role, permission, entitlement, auth, dados sensiveis;
- multi-step: webhook, callback, fila, job, estado pendente, eventos posteriores;
- multiplos entrypoints: routers, controllers, handlers, jobs, CLI e simuladores;
- migration/dados historicos: migrations, backfill, compatibilidade de schema;
- documentacao: contrato, operacao, API, setup, runbook ou comportamento publico;
- runtime-policy: resolvedor, executor, retry, fallback, timeout, `AbortSignal`, deadline ou cancelamento;
- adapter-contract: capability registry, support matrix, provider, adapter ou operação declarada;
- request-translation: tools, schema, Structured Output, multimodal, embeddings, transcrição, geração/edição de imagem ou conversão de request;
- legacy-compatibility: compatibilidade legada, preservação de comportamento, consumidor não migrado ou ausência de mudança observável;
- documentation-claims: documentação que afirma suporte, garantia, rejeição, preservação, bloqueio pré-rede ou comportamento ponta a ponta;
- input-parser: parser, decoder, desserializador, lexer, tokenizer, upload ou helper que transforma conteudo bruto usado em tamanho, vazio, encoding, hash, identidade ou escopo estrutural.

## Declaracao

O `risk_profile` deve incorporar todos os sinais de confianca alta. Uma reducao somente e aceita em `risk_overrides` com:

- campo reduzido;
- valor detectado e valor declarado;
- justificativa objetiva;
- arquivos e evidencias que demonstram falso positivo.

O validador rejeita reducao sem override e justificativa suficiente.

## Familias derivadas

- sempre: F01, F02 e F15;
- multiplas entidades: F03, F04 e F05;
- multi-step: F06 e F07;
- persistencia multi-step: F08, F09, F10 e F11;
- multiplos entrypoints: F12;
- migration ou fallback: F13;
- autorizacao ou privacidade: F14;
- visual: F16;
- autorizacao/privacidade persistente: F17 e F18;
- persistencia duravel: F19; fallback de provider sem persistência não ativa F19;
- autorizacao ou privacidade: F20;
- persistencia: F21;
- migration ou backfill: F22;
- autorizacao/privacidade persistente: F23;
- visual e multi-step: F24;
- runtime-policy: F28 e F29;
- adapter-contract: F30;
- request-translation: F31;
- legacy-compatibility: F32;
- documentation-claims: F33;
- input-parser: F34.
