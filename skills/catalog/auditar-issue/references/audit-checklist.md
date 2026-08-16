# Checklist de auditoria

Aplicar os itens pertinentes e registrar `não aplicável` somente quando houver justificativa clara.

## Independência e versão

- a execução foi classificada como auditoria independente ou pré-auditoria;
- o auditor não implementou nem corrigiu o SHA auditado no mesmo contexto quando o parecer pretende aprovar;
- o SHA foi congelado antes da análise e confirmado novamente no encerramento;
- troca de skill ou nova etapa no mesmo contexto não foi tratada como independência;
- pré-auditoria sem achados não foi apresentada como aprovação final;
- descrição da PR e pareceres anteriores foram usados apenas para localizar alegações;
- a procedência do contexto separado foi demonstrada, não apenas declarada;
- a mesma resposta ou conversa não foi usada para implementar e aprovar;
- parecer posterior com achados no mesmo SHA invalidou explicitamente aprovação anterior incompatível.

## Requisitos e escopo

- todos os critérios de aceite foram atomizados;
- comentários e decisões posteriores foram considerados;
- subissues e dependências foram incluídas;
- itens explicitamente excluídos não foram cobrados;
- requisitos técnicos inferidos estão identificados como inferência.

## Fluxo funcional

- fluxo principal funciona de ponta a ponta;
- caminhos alternativos respeitam a mesma regra;
- criação, leitura, edição e exclusão foram avaliadas quando aplicáveis;
- estados vazio, loading, sucesso, erro e retry foram avaliados;
- entradas inválidas, limites e duplicidades foram avaliados;
- mensagens ao usuário são coerentes e acionáveis.

## Frontend

- tela, modal, formulário, tabela ou componente solicitado existe;
- dados exibidos vêm da fonte correta, sem hardcode;
- validação visual coincide com a regra do backend;
- responsividade e overflow foram considerados;
- acessibilidade básica, foco, labels, tooltip e teclado foram considerados;
- loading, erro e ausência de dados não quebram o layout;
- navegação, rotas e permissões visuais estão corretas;
- parâmetros de links e filtros usam a mesma fonte e regra de precedência da tela de destino;
- links filtrados foram testados com campos de data, conta, status ou identificador deliberadamente divergentes;
- testes visuais executam a ação crítica e comprovam o resultado de destino, não apenas a presença do controle;
- componentes correlatos não mantêm comportamento antigo conflitante.

## Auditoria especializada de interface

Quando houver impacto visual:

- `design-interface` foi carregada e executada em modo auditoria independente;
- a aplicação foi renderizada no estado e commit auditados;
- rota, dados, perfil e viewport foram registrados;
- desktop amplo, desktop de baixa altura e mobile foram avaliados conforme aplicável;
- arquitetura da informação, hierarquia, dimensionamento, densidade e ordenação foram avaliados;
- responsividade, overflow, modais, menus, tabelas e conteúdo longo foram testados;
- loading, vazio, erro, sucesso e permissão foram avaliados quando pertinentes;
- foco, teclado, labels, contraste e nomes acessíveis foram verificados;
- screenshots da implementação não foram reutilizados como conclusão automática;
- harness ou mocks visuais foram tratados como evidência limitada de layout, não como prova única de rota, dados, autorização ou navegação real;
- o parecer visual foi consolidado no relatório geral.

## Backend e regras de negócio

- endpoint, serviço, job ou consumidor está integrado ao fluxo real;
- validações obrigatórias existem no servidor;
- regras são aplicadas em todos os pontos de entrada;
- erros possuem códigos e mensagens coerentes;
- idempotência, concorrência e transações foram avaliadas quando relevantes;
- filtros e paginação não omitem ou misturam dados;
- comportamento não depende de ordem acidental ou estado global indevido.

## Contratos transitivos de runtime

Quando houver resolvedor, executor, retry/fallback, provider, adapter ou tradução de request:

- estados `invalid` e `disabled` impedem qualquer callback e outbound na fronteira comum;
- `degraded` preserva somente caminhos explicitamente elegíveis;
- timeout, deadline e cancelamento atravessam callback, contrato, adapter e SDK;
- retry/fallback começa somente após encerramento da chamada anterior;
- operações requeridas são derivadas dos requests reais dos consumidores;
- toda operação declarada possui método, implementação e teste de integração;
- campos comuns são traduzidos, validados ou rejeitados antes da rede, nunca ignorados;
- compatibilidade legada é provada pelo entrypoint real e por variante funcional;
- afirmações normativas da documentação são ligadas a código e teste discriminante.

Testes isolados do resolvedor, executor ou adapter não comprovam a cadeia completa.

## Banco de dados

- schema suporta o requisito;
- migration é segura e reproduzível;
- dados existentes continuam válidos ou possuem backfill;
- defaults, nulabilidade, índices e constraints são adequados;
- rollback ou impacto operacional foi considerado;
- consultas respeitam tenant, usuário e relacionamentos;
- seed, fixtures e tipos gerados estão atualizados quando necessário.

## Segurança e permissões

- autorização é validada no backend;
- payload e erro da fronteira pública foram inspecionados depois da serialização;
- schema de saída ou sanitização impede retorno de objetos internos e PII antes da autorização;
- casos existente, inexistente, inelegível, outro tenant e vínculo prévio foram comparados para detectar enumeração;
- helper ou mensagem genérica do frontend não foi usado como prova da segurança da API;
- preflight usa o entitlement ou recurso exato da rota de destino;
- negação confirmada é distinguida de falha temporária, rede, timeout, timezone e indisponibilidade;
- limpeza de contexto ocorre somente diante de negação autoritativa;
- usuário não acessa dados de outro usuário/tenant;
- papéis permitidos e negados foram testados;
- dados sensíveis não aparecem em logs ou respostas indevidas;
- inputs são tratados contra injeção e abuso pertinente;
- ações críticas possuem proteção apropriada.

## Integrações

- contratos, payloads e versões estão corretos;
- timeouts, retries, indisponibilidade e respostas inválidas são tratados;
- webhooks possuem autenticação, idempotência e correlação quando aplicável;
- variáveis de ambiente e documentação estão atualizadas;
- fallback não mascara falha nem produz dados incorretos.

## Testes e qualidade

- existem testes para cada critério crítico;
- testes cobrem sucesso, falha e limites relevantes;
- asserções comprovam o comportamento, não apenas execução;
- teste falharia se a implementação fosse removida ou quebrada;
- teste também falharia para uma implementação plausível que use o campo, filtro, data ou fonte de verdade errada;
- fixtures não usam valores coincidentes quando o requisito define precedência entre campos;
- reprodução da causa raiz provoca a condição anterior ou uma falha equivalente controlada;
- testes antigos não foram enfraquecidos para passar;
- type-check, lint, build e gates oficiais foram executados;
- testes flaky, skips e TODOs relevantes foram registrados.

## Regressões e compatibilidade

- fluxos próximos foram revalidados;
- APIs e formatos anteriores permanecem compatíveis quando exigido;
- dados históricos continuam legíveis e editáveis;
- feature flags e rollout não deixam caminhos inconsistentes;
- performance de consultas e renderização não sofreu degradação evidente;
- documentação e ajuda ao usuário não ficaram desatualizadas.

## Documentação

- todo `AGENTS.md` aplicável ao caminho alterado foi identificado;
- README, ADRs, contratos, runbooks, exemplos e ajuda afetados foram verificados;
- comandos, caminhos, variáveis, payloads, versões e screenshots continuam coerentes;
- documentação gerada corresponde à fonte e ao gerador oficial;
- não existe fonte concorrente materialmente contraditória;
- a ausência de alteração documental possui justificativa objetiva e verificável;
- o registro da implementação foi tratado apenas como alegação e a descoberta documental foi refeita independentemente;
- as fontes canônicas necessárias aparecem no diff da mesma branch e PR da implementação;
- regras estáveis introduzidas pela mudança estão registradas em fonte canônica dentro do repositório;
- descrição de PR, comentário de issue ou memória externa não estão sendo usados como substitutos da documentação necessária;
- checks de documentação foram executados quando disponíveis.

## Sinais de implementação incompleta

- TODO, FIXME, mock ou stub no fluxo;
- hardcode de usuário, valor, status ou resposta;
- componente/serviço sem chamadas reais;
- função não referenciada ou rota não registrada;
- tratamento implementado em apenas uma tela ou endpoint;
- migration sem uso no domínio;
- teste removido, ignorado ou simplificado sem justificativa;
- comportamento antigo ainda acessível por rota alternativa;
- comentário indicando etapa futura necessária para concluir o requisito.


## Passagem adversarial

- auditorias e resumos anteriores foram ignorados como evidência;
- foi formulada uma hipótese concreta de implementação incorreta para cada requisito crítico;
- cenários discriminantes usam valores diferentes entre fontes concorrentes;
- caminhos alternativos e dados históricos foram verificados quando aplicáveis;
- nenhuma conclusão depende apenas de CI verde, nome de teste ou descrição da PR;
- atividades ainda não executadas foram classificadas como pendência ou limitação;
- o parecer somente foi definido depois da tentativa explícita de refutação.

## Enforcement controller v3

- existe `source-manifest` completo e hasheado;
- todo requisito aponta para uma fonte do manifesto;
- a rederivacao foi feita na fase somente leitura;
- a matriz cobre exatamente todos os requisitos;
- todo requisito implementado possui evidencia positiva, controle negativo e regressao;
- todo gate possui atestacao com comando, cwd, SHA, horarios, exit code e hashes de stdout/stderr;
- `controller-audit-report.json` passou no validador schema 3;
- o relatorio e o resultado estruturado possuem os mesmos requisitos, findings, gates e limitacoes;
- inicio e termino da auditoria sao posteriores ao freeze e coerentes;
- `Aprovado` nao coexistiu com finding bloqueante, requisito pendente, gate falho ou limitacao material.
- [ ] `approval_scope=internal-only` em controller-adversarial;
- [ ] `release_gate_satisfied=false` em controller-adversarial;
- [ ] pacote neutro exclui conclusoes e narrativa da implementacao;
- [ ] findings independentes contra SHA aprovado internamente foram marcados como audit escapes.

## Parsers, decoders e adaptadores de entrada

- a familia `input-parser` foi ativada quando aplicavel;
- cada controle negativo declara a implementacao errada plausivel que pretende detectar;
- `consumed_fields` foi derivado dos leitores reais e nenhum campo foi representado apenas por uma tag amostral;
- a matriz `modo x campo consumido x posicionamento` cobre `direct`, `generic-container` e `scalar-container`;
- `IP-RAW-001`, `IP-MODE-001`, `IP-SCOPE-001`, `IP-INACTIVE-001` e `IP-EFFECT-001` possuem evidencia executada e hasheada;
- fronteiras, truncamento, encoding, tamanho e ausencia de efeitos parciais foram verificados;
- ambiguidades e precedencias usam valores discriminantes, nao coincidentes;
- em formatos hierarquicos, registros fora do container canonico nao sao extraidos;
- comentarios, conteudo escapado, exemplos, CDATA ou blocos inativos nao viram registros ativos;
- metadados de uma secao nao sao aplicados a registros de outra secao;
- secoes repetidas, aninhadas, reordenadas ou concorrentes possuem comportamento definido;
- a evidencia registra procedimento, esperado, observado, SHA e hash do artefato.

## Transicao de estado documental

- mudancas de ausente/futuro/parcial/experimental para operacional executaram busca global por alegacoes antigas;
- mudancas de rota, nome, arquitetura ou fonte canonica executaram busca pelos termos antigos e novos;
- ocorrencias fora do diff foram classificadas como atuais, historicas, compatibilidade, exemplo ou contradicao;
- `complete: true` nao foi aceito sem inventario reproduzivel de fontes descobertas e declaradas;
- fonte canonica concorrente permanece finding bloqueante mesmo quando o documento novo esta correto.

## Entrada não confiável — prevenção de gaps recorrentes

- [ ] As branches reais do parser foram enumeradas, inclusive variante sem declaração/cabeçalho.
- [ ] Existe matriz modo × invariante e matriz modo × campo consumido × posicionamento, não apenas exemplos isolados.
- [ ] Todo campo efetivamente lido aparece em `consumed_fields`; uma tag amostral não representa os demais.
- [ ] Tags escalares usadas como contêineres são testadas separadamente de wrappers óbvios.
- [ ] O valor bruto foi rastreado pela rota, helper, validação, hash e parser.
- [ ] Ausente, vazio, somente espaços, limite exato, `limite + 1`, padding externo acima do limite e excesso reduzível por normalização possuem códigos observados.
- [ ] Pelo menos uma chamada usa a fronteira pública e confirma ausência de persistência e efeitos.
