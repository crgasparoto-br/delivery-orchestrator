---
name: documentacao-repositorio
description: Governar documentacao versionada de repositorios em especificacao, implementacao, verificacao e auditoria. Usar para descobrir e atualizar AGENTS.md, README, ADRs, contratos, runbooks, API, ambiente, design system e fontes geradas. Manter um unico registro incremental por ciclo, reutilizar descoberta por fingerprint, executar delta scans e refazer descoberta completa apenas quando a identidade/fonte raiz mudar ou em auditoria independente. Bloquear conclusao quando documentacao obrigatoria estiver ausente ou divergente.
---

# Documentacao do Repositorio

## Objetivo

Manter documentacao como parte verificavel da entrega sem repetir a mesma descoberta em cada subskill.

## Modos

- `specification`;
- `implementation`;
- `internal-verification`;
- `independent-audit`;
- `guidance`.

Ler sempre `references/impact-record.md`. Ler `references/delivery-contract.md` somente sob composicao; `source-completeness.md` ao fechar inventario e `contradiction-scan.md` para mudanca de estado, rota, nome ou arquitetura.

## Registro unico

Manter um `documentation-impact.json` por ciclo com documentos aplicaveis, fontes canonicas/concorrentes, categorias, caminhos, validacoes, justificativas, `last_scanned_head` e fingerprint dos caminhos/termos.

Nenhuma outra skill deve criar registro paralelo. `entregar-issue` define o `write_owner` documental: se o nucleo de implementacao ja editou documentos atribuidos, esta Skill verifica o delta; se esta Skill for o owner, o nucleo de implementacao apenas informa a mudanca necessaria. Nunca executar duas edicoes documentais concorrentes.

## Descoberta e fast path

1. Fazer descoberta completa no inicio somente quando nao houver registro valido.
2. Em chamadas seguintes, examinar novos caminhos, termos e contratos por delta.
3. Reabrir apenas categorias invalidadas por mudanca de codigo, configuracao, escopo ou fonte.
4. Em auditoria independente, refazer descoberta completa em SHA congelado.
5. Retornar `not-applicable` quando matriz de impacto, caminhos e termos demonstrarem ausencia de efeito documental.
6. Nao aceitar `complete: true` sem inventario reproduzivel.
7. Para mudanca de estado, rota, nome ou arquitetura, executar varredura global por alegacoes antigas.

## Precedencia

1. instrucao explicita do usuario;
2. contrato desejado e decisoes vinculadas;
3. `AGENTS.md` aplicavel;
4. fontes canonicas versionadas;
5. codigo, testes e configuracao como baseline.

Nao atualizar documentacao para legitimar defeito.

## Fluxo

### Specification

Identificar fontes, divergencias, documentos a atualizar e criterios. Nao criar novo documento quando uma fonte canonica existente puder ser alterada.

### Implementation

Atualizar somente fontes afetadas quando for o `write_owner` documental, na mesma branch e PR. Caso os documentos ja tenham sido editados pelo owner anterior, operar como verificacao incremental sem reescrever. Validar links, comandos, exemplos, rotas, variaveis, screenshots e geradores alterados. Ausencia de mudanca exige justificativa objetiva.

### Verificacao e auditoria

Operar em leitura. Comparar comportamento, API, schema, comandos, ambiente, operacao, exemplos, ajuda e arquitetura. Em verificacao interna, emitir apenas parecer interno. Somente auditoria independente aprova o portao documental final.

## Eficiencia

- Reutilizar resultados por fingerprint de SHA, caminhos, termos e fontes.
- Nao varrer todo o repositorio em cada chamada incremental.
- Agrupar validacoes de links/comandos por documento alterado.
- Nao revalidar documento cujo conteudo e dependencias nao mudaram.

## Portao e entrega

Retornar resultado estruturado com registro, delta examinado, fontes, findings, validacoes, fingerprint e evidencias reutilizadas. Bloquear quando fonte obrigatoria estiver omitida, contradicao atual permanecer ou descoberta nao for reproduzivel. Nao criar branch, PR, issue ou comentario sob composicao.

## Composicao versionada

No modo orquestrado, aplicar `references/delivery-contract.md` como unica fonte do envelope, reutilizacao e versao. Toda execucao nova deve emitir `input_fingerprint` e `reused=false`; qualquer no-op deve incluir `skip_reason`. Nao duplicar estado, ciclo, identidade global ou delegacao.
