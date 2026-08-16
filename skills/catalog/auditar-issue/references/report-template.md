# RESULTADO: [APROVADA | APROVADA COM RESSALVAS | APROVADA INTERNAMENTE | INCONCLUSIVA | REPROVADA]

**Validade:** [Independente | Controller-adversarial | Pre-auditoria]
**Libera merge/release:** [SIM | NAO]

# Auditoria da implementacao — [issue/titulo]

## Motivo determinante

[Explicar em um paragrafo o motivo determinante do resultado, mencionando requisitos bloqueadores, ressalvas ou a evidencia que sustenta a aprovacao.]

## Validade da execucao

- justificativa da independencia: [...]
- procedencia verificavel do contexto separado: [...]
- relacao com o contexto de implementacao: [nenhuma | explicar por que nao e independente]
- SHA congelado: `[...]`
- SHA confirmado no encerramento: `[...]`
- SHA da base antes/depois: `[...]` / `[...]`
- merge preview antes/depois: `[...]` / `[...]`

### Regras do cabecalho

- `APROVADA`: apenas auditoria independente com portao de release satisfeito.
- `APROVADA COM RESSALVAS`: apenas auditoria independente, sem bloqueio, com ressalva material nao bloqueante.
- `APROVADA INTERNAMENTE`: controller-adversarial ou pre-auditoria favoravel; `Libera merge/release: NAO`.
- `INCONCLUSIVA`: limitacao do runtime/ferramenta/connector da auditoria impede prova obrigatoria sem evidencia de falha do candidato; `Libera merge/release: NAO`; nao gerar finding da issue para essa causa.
- `REPROVADA`: finding bloqueante, gate material falho/ausente por responsabilidade do candidato/entrega, identidade invalida ou handoff materialmente inconsistente.

## Resumo executivo

- requisitos obrigatórios: [quantidade]
- implementados: [quantidade]
- parciais: [quantidade]
- não implementados: [quantidade]
- incorretos: [quantidade]
- não verificáveis: [quantidade]
- achados bloqueantes abertos: [quantidade]
- recomendacoes opcionais: [quantidade]

[Resumir o que foi entregue e as principais lacunas. Não usar o percentual como substituto do parecer.]

## Escopo auditado

- repositório: `[owner/repo]`
- issue principal: `[#n]`
- subissues: `[#n, #n]`
- branch/PR: `[identificação]`
- commit auditado: `[sha]`
- validade da execução: `[independente | pré-auditoria]`
- base de comparação: `[branch/sha]`
- base remota antes/depois: `[sha]` / `[sha]`
- merge preview antes/depois: `[sha]` / `[sha]`
- documentos consultados: `[lista]`
- impacto documental declarado: `[arquivos ou sem impacto com justificativa]`
- registro documental recebido: `[identificação/estado, tratado como alegação]`
- limitações: `[nenhuma ou lista objetiva; usar audit-runtime-limitation quando externa ao candidato]`

## Estado dos gates e alcance de testes

Preencher quando houver CI/status remoto relevante, suite abortada ou `blocker-bounded`.

| Gate/teste ou familia | Estado do gate | declared | reached | passed | Origem/observacao |
|---|---|---:|---:|---:|---|
| `...` | green/red-candidate-caused/red-inherited-or-infra/not-reached/missing/unknown | sim/nao | sim/nao | sim/nao | ... |

- `blocker_bounded`: `[true|false]`
- provas caras puladas: `[lista + skip_reason]`
- evidencias verdes reutilizadas: `[run/job + escopo comprovado]`

Nao marcar teste posterior ao primeiro abort como executado. Nao extrapolar job verde alem do harness/cenario que ele realmente exercitou.

## Matriz de requisitos

| ID | Origem | Requisito atômico | Evidência | Status | Severidade/observação |
|---|---|---|---|---|---|
| REQ-001 | issue | ... | `arquivo:linhas`, teste ou comportamento | Implementado | ... |

Usar uma linha por requisito. Não combinar requisitos diferentes para aparentar cobertura.

## Achados bloqueantes

Incluir apenas observacoes com `disposition=blocking`.

### Modelo de achado

### [BLOQUEADOR/ALTO/MÉDIO/BAIXO] A-001 — [título objetivo]

- **Requisitos afetados:** REQ-...
- **Categoria de escape:** `execution-state-gap | control-propagation-gap | capability-operation-drift | adapter-support-drift | silent-translation-loss | legacy-variant-gap | documentation-claim-drift | other`
- **Portão requerido:** `F28` a `F33` quando aplicável
- **Caso literal:** ...
- **Casos irmãos:** pelo menos dois cenários de famílias ou superfícies distintas
- **Solicitado:** ...
- **Encontrado:** ...
- **Evidência:** ...
- **Impacto:** ...
- **Lacuna a corrigir:** ...

Repetir por achado, em ordem decrescente de severidade.


## Recomendacoes opcionais

Listar observacoes com `disposition=recommendation`. Elas nao ampliam o contrato da issue e, isoladamente, nao produzem ressalva nem bloqueiam parecer `Aprovado`.

## Testes e validações

| Comando/cenário | Resultado | Evidência/observação |
|---|---|---|
| `comando` | passou/falhou/não executado | ... |

Listar também testes relevantes que deveriam existir, mas não existem.

## Fronteira pública, privacidade e autorização

Preencher quando houver requisito de não revelação, autorização, elegibilidade ou isolamento.

- **Procedures/endpoints auditados:** [...]
- **Payload público observado:** [...]
- **Erro público observado:** [...]
- **Casos discriminantes:** [existente, inexistente, inelegível, outro tenant, vínculo prévio...]
- **Dados protegidos ausentes da resposta:** [...]
- **Entitlement/recurso exato do destino:** [...]
- **Negação versus falha temporária:** [...]
- **Testes diretos na fronteira:** [...]
- **Achados:** [...]

## Auditoria documental

- **Parecer documental:** [Aprovada | Reprovada | Não verificável]
- **Fontes canônicas avaliadas:** [...]
- **Fontes canônicas presentes no diff e atualizadas, ou justificativa de ausência de impacto:** [...]
- **Comparação com o registro declarado pela implementação:** [...]
- **Verificação independente realizada:** [...]
- **Regras estáveis sem fonte versionada:** [nenhuma | listar]
- **Validações:** [...]
- **Divergências e achados:** [...]

Relacionar cada achado documental aos requisitos e à severidade no relatório principal.

## Auditoria de interface

Preencher quando houver impacto visual.

- **Parecer visual:** [Aprovada | Reprovada | Não verificável]
- **Rotas e cenários:** [...]
- **Viewports:** [...]
- **Evidências:** [screenshots, execução e passos reproduzíveis]
- **Achados materiais:** [...]
- **Limitações:** [...]

Relacionar cada achado visual aos requisitos e à severidade no relatório principal.

## Regressões e riscos

[Descrever regressões confirmadas, riscos plausíveis sustentados por evidência e áreas não verificadas. Separar fato de risco inferido.]

## Pendências objetivas

1. [ação necessária vinculada ao requisito e ao achado]
2. ...

## Proposta de issues corretivas

### [Título sugerido]

**Objetivo:** ...

**Requisitos afetados:** REQ-...

**Critérios de aceite:**

- ...
- ...

**Evidência da lacuna:** ...

Não criar as issues sem autorização expressa.


## Artefato de auditoria externa

Quando a execucao for independente e houver chave previamente confiada:

- arquivo: `external-audit.json`;
- schema: `schemas/external-audit.schema.json`, versao 3;
- report ID: `[uuid]`;
- audit context ID e issuer: `[...]`;
- key ID: `[...]`;
- SHA-256 do arquivo assinado: `[...]`;
- validacao: `validate_external_audit_report.py ...` `[PASS|FAIL]`;
- custodia da chave privada fora do contexto de implementacao: `[confirmada|nao demonstravel]`.

Se a custodia ou o contexto separado nao puderem ser demonstrados, nao assinar e nao apresentar o arquivo como aprovacao importavel.

## Artefatos controller v3

Quando em `controller-adversarial`, acrescentar:

- `source-manifest.json`: caminho e SHA-256;
- `requirements-rederivation.json`: caminho e SHA-256;
- `coverage-matrix.json`: caminho e SHA-256;
- `controller-audit-report.json`: caminho, SHA-256 e resultado de `validate_controller_audit_result.py`.

A matriz de requisitos deve registrar separadamente evidencia positiva, IDs de controles negativos, `negative_control_evidence` estruturada e regressao. Nao resumir esses campos em uma unica coluna generica nem aceitar nome de teste sem artefato hasheado.

## Audit escape

Incluir secao explicita quando uma auditoria independente refutar aprovacao interna previa do mesmo SHA: SHA e hash do relatorio interno anterior, findings escapados, motivo da falha dos gates internos, Skill governante a revisar e controle adversarial reutilizavel requerido.


## Resultado inconclusivo por runtime

Quando o resultado for `INCONCLUSIVA` por `audit-runtime-limitation`:

- nao listar a limitacao em **Achados bloqueantes**;
- declarar explicitamente que nao foi identificado defeito funcional novo por essa causa;
- registrar `blocker_bounded=false`;
- listar em **Pendencias objetivas** apenas a acao de infraestrutura da auditoria, nunca mudanca no repositorio;
- no resultado estruturado usar `status=blocked`, `findings=[]` para a causa de runtime, `limitations` com categoria `audit-runtime-limitation` e `requires_refreeze=false` se a identidade estiver estavel.
