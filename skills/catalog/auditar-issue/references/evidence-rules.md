# Regras de evidência

## Validade do parecer

Evidência forte não transforma autoavaliação em auditoria independente. Uma execução no mesmo agente, conversa ou contexto da implementação pode encontrar e bloquear falhas e pode alimentar o gate operacional de um controlador de chamada unica, mas não pode aprovar o portão canônico de auditoria independente. Toda aprovação independente deve declarar contexto separado, procedência verificável e SHA imutável. Autodeclaração de independência dentro da mesma resposta ou conversa não é evidência.

## Hierarquia de confiança

Priorizar evidências nesta ordem, combinando mais de uma quando necessário:

1. comportamento observado em execução com entrada e saída reproduzíveis;
2. teste específico que valida o critério de aceite e passou;
3. código completo do fluxo, incluindo chamadas e persistência;
4. schema, migration, configuração ou contrato técnico efetivamente usado;
5. documentação técnica atualizada, validada e coerente com o código;
6. análise de impacto documental com justificativa comprovável de ausência de alteração;
7. descrição de PR, mensagem de commit, checklist ou comentário.

Itens do nível 7 servem apenas para localizar a implementação, nunca para comprová-la isoladamente. A documentação pode comprovar contrato ou intenção, mas não substitui comportamento executado quando este for verificável.

## Evidência mínima por status

### Implementado

Exigir:

- evidência do ponto de entrada;
- evidência da regra principal;
- evidência do resultado ou efeito persistido;
- validação dos cenários críticos;
- ausência de contradição relevante em outro caminho do sistema;
- cenário discriminante quando houver mais de uma fonte, campo, data, filtro ou regra de precedência;
- comprovação de que uma implementação plausível, porém incorreta, faria o teste falhar;
- `negative_control_evidence` executada, vinculada ao SHA e a arquivo bruto hasheado.

### Parcial

Usar quando houver evidência concreta de uma parte funcional, mas faltar qualquer obrigação relevante, camada necessária ou cenário expressamente solicitado.

### Não implementado

Registrar as buscas realizadas, locais esperados e ausência de evidência. Não afirmar ausência apenas porque o diff não contém um arquivo esperado.

### Incorreto

Demonstrar a divergência entre comportamento solicitado e comportamento implementado. Preferir um exemplo reproduzível.

### Não verificável

Explicar:

- qual evidência era necessária;
- por que não pôde ser obtida;
- qual impacto isso tem no parecer;
- qual ação permitiria concluir a verificação.

## Evidências inválidas isoladamente

Não aceitar como prova única:

- nome de branch, função, componente ou teste;
- checkbox marcado;
- texto “feito”, “resolvido” ou equivalente;
- arquivo criado sem integração ao fluxo;
- teste verde sem asserção sobre o requisito;
- componente visível sem integração com API ou persistência;
- endpoint criado sem consumidor ou autorização;
- migration criada mas não compatível com dados existentes;
- tratamento no frontend sem validação equivalente no backend;
- mensagem genérica na interface enquanto o endpoint retorna PII, detalhes internos ou erros distinguíveis;
- teste de helper de apresentação usado como prova do payload público;
- policy ampla de autorização usada como prova da capacidade exata exigida pela rota;
- captura genérica de qualquer exceção usada para afirmar revogação de acesso;
- screenshot sem confirmação do cenário, dados e versão auditada;
- aprovação visual baseada apenas em leitura de código, snapshot estático ou captura produzida pela própria implementação;
- harness mockado como prova única de integração real;
- texto de `auditoria independente aprovada` escrito pela própria execução que implementou a mudança.

## Controles negativos estruturados

Nao aceitar `negative_controls` como lista de rotulos sem prova. Cada controle deve declarar a implementacao errada plausivel, a dimensao adversarial, procedimento reproduzivel, esperado, observado, status, SHA e evidencia hasheada. Os IDs declarados e as evidencias devem coincidir exatamente.

Para parsers e adaptadores de entrada, verificar fronteira, malformed input e ambiguidade. Em formatos hierarquicos, derivar todos os campos consumidos e executar matriz modo x campo x posicionamento; uma tag representativa nao basta. Testar tambem pertencimento ao escopo, conteudo inativo, contexto capturado de secao concorrente, `limite + 1` e documento valido com padding externo acima do limite antes de qualquer normalizacao.

## Rastreabilidade

Cada evidência deve indicar, quando disponível:

- repositório e commit;
- arquivo e intervalo de linhas;
- comando e resultado;
- cenário testado;
- requisito associado;
- data ou ambiente quando relevante;
- para interface: rota, perfil, dados, viewport e interação executada.


## Evidência discriminante

Quando o requisito escolher entre duas ou mais fontes possíveis, não aceitar fixtures em que todas produzam o mesmo resultado.

Exigir valores deliberadamente diferentes, por exemplo:

- `occurredOn` em um mês e `effectiveOn` em outro;
- conta original diferente da conta revisada;
- tenant autorizado diferente do tenant consultado;
- payload anterior diferente do registro persistido;
- estado antes do commit diferente do estado após releitura;
- schema anterior diferente do schema esperado pela aplicação.

Perguntar: **uma implementação que usasse o campo errado também passaria neste teste?** Se a resposta for sim, a evidência não comprova o requisito.

## Proveniencia em reenvio semanticamente identico

Quando um fluxo persiste autoria, instante, origem, justificativa ou snapshot de uma decisao confirmada, exigir o controle `PROV-NOOP-001`:

- ator A confirma a decisao com valores de proveniencia observaveis;
- ator B reenvia o mesmo estado efetivo enquanto altera somente um campo irmao;
- a releitura persistida deve manter autor, instante, origem, justificativa e snapshot de A;
- um caso irmao deve mudar realmente a decisao e provar transferencia da proveniencia para B;
- IDs, instantes e snapshots precisam ser deliberadamente distintos para refutar atribuicao automatica ao ultimo editor.

A implementacao errada plausivel e regravar `confirmedBy`/`confirmedAt` sempre que o payload contiver o campo confirmado. Teste de finalizacao que preserva o autor nao detecta necessariamente a reatribuicao anterior causada pelo endpoint de edicao. Quando a protecao estiver em migration, trigger ou constraint, executar tambem a cadeia reduzida/legada usada pelos gates; migration verde apenas em banco novo nao comprova compatibilidade. Registrar evidencia bruta, SHA e estado persistido antes/depois.

## Reprodução de causa raiz

Quando a issue exigir diagnóstico ou reprodução, diferenciar:

- **teste do resultado corrigido**: comprova que o fluxo funciona no estado atual;
- **teste da causa raiz**: provoca a condição anterior ou equivalente e comprova que a correção atua exatamente nessa fronteira.

Não substituir a segunda categoria pela primeira. Documentação da causa, contrato estático ou migration aplicada em banco novo não comprovam, isoladamente, falha causada por schema pendente em banco existente.

## Evidência de contratos transitivos

Para políticas e adapters, exigir evidência na fronteira exata:

- `state` retornado pelo resolvedor não prova bloqueio de execução;
- callback mockado que recebe `AbortSignal` não prova propagação ao SDK;
- enum ou matriz não prova método implementado;
- SDK upstream suportar recurso não prova suporte no adapter local;
- request aceito sem erro não prova tradução de tools, schema ou mídia;
- arquivo de consumidor não alterado não prova compatibilidade funcional;
- documentação técnica não prova a própria afirmação.

Preferir testes integrados com espião de outbound e SDK mockado somente no último limite externo.

## Evidência de fronteira pública

Para requisitos de privacidade, não enumeração, autorização, elegibilidade ou isolamento, a evidência mínima deve incluir:

- chamada direta à procedure, endpoint ou resolver público;
- payload de sucesso depois da serialização;
- erro público depois de formatter e mapeamentos;
- casos existentes, inexistentes, inelegíveis e de outro tenant, quando aplicáveis;
- verificação de que respostas observáveis não revelam existência, nome, e-mail, telefone, estado interno, canal ativo ou outro detalhe protegido;
- teste que falhe se o backend voltar a retornar objeto interno mesmo que o frontend continue escondendo-o.

A proteção na camada visual é complementar, nunca substituta.

## Evidência de autorização e falha temporária

Quando uma ação valida acesso antes de navegar ou carregar dados, exigir:

- capacidade ou entitlement exato do destino;
- distinção entre negação confirmada e falha transitória;
- preservação de contexto e oferta de retry em falhas recuperáveis;
- limpeza de dados apenas diante de revogação, negação ou identidade inválida comprovada;
- teste discriminante para `FORBIDDEN` versus rede, timeout, timezone ou `SERVICE_UNAVAILABLE`.

## Conflito entre pareceres

Para o mesmo SHA, um achado material posterior supera qualquer aprovação anterior incompatível. O relatório novo deve nomear a aprovação superada, explicar a evidência nova e definir o estado vigente como reprovado ou em correção até nova auditoria.



## Completude documental

Nao aceitar manifesto `complete: true` sem inventario reproduzivel. Exigir comandos de descoberta, caminhos encontrados, caminhos declarados, omissoes justificadas e varredura de alegacoes antigas quando houver mudanca de estado, rota, nome ou arquitetura.

## Evidencia remota de PR

Quando houver PR, consultar a fonte remota independentemente antes e depois da auditoria. Registrar head, SHA da base, merge preview, mergeabilidade, workflows aplicaveis e artefatos. Snapshot produzido pela implementacao orienta a busca, mas nao substitui a nova coleta. Mudanca de head, base ou merge preview invalida o parecer.
