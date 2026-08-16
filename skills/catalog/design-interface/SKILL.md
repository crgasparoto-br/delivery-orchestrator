---
name: design-interface
description: Projetar, implementar, verificar e auditar interfaces de software com arquitetura da informacao, hierarquia visual, responsividade, acessibilidade e consistencia com o design system real. Usar quando uma issue altera conteudo, estado, interacao, layout, navegacao ou componente visivel. Sob `entregar-issue`, consumir o recorte recebido, deduplicar cenarios por classe de rota/estado/layout/audiencia, produzir evidencia estruturada e nao repetir descoberta geral, suite agregada, branch paralela ou Figma.
---

# Design de Interface

## Objetivo

Entregar interface clara e operavel sem transformar preferencia estetica em requisito ou repetir verificacoes equivalentes.

## Modos

- `implementation`;
- `internal-verification`;
- `independent-audit`;
- `guidance`.

Quando composta, ler `references/delivery-contract.md`. Carregar `interface-standards.md`, `screen-patterns.md` ou `visual-audit.md` somente para a etapa correspondente.

## Aplicabilidade

Aplicar somente para efeito percebido ou operado pelo usuario: texto, icone, ordem, layout, dimensao, estado, interacao, permissao visivel, responsividade ou navegacao. Mudanca interna sem efeito visivel e `not-applicable`.

## Composicao

1. Consumir requisitos, rotas, cenarios, componentes, caminhos e perfil recebidos.
2. Nao reler toda a issue nem redescobrir documentacao vigente.
3. Nao criar branch, PR, issue, comentario ou entrega no Figma sob `entregar-issue`.
4. Respeitar `write_owner`: em `guidance`, produzir restricoes antes da escrita; em `internal-verification`, operar em leitura e retornar findings; editar somente em `implementation` quando o recorte tiver sido atribuido exclusivamente a esta Skill.
5. Implementar e verificar antes do freeze; auditar sobre SHA congelado.
6. Harness mockado comprova somente renderizacao; integracao real exige evidencia propria.

## Implementar

1. Inspecionar somente componentes, tokens, icones e breakpoints relacionados.
2. Definir hierarquia, ordem, acao primaria, estados e estrategia responsiva.
3. Reutilizar componentes existentes e alterar o menor conjunto coeso.
4. Tratar loading, vazio, erro, sucesso, indisponibilidade, permissao, teclado, foco, contraste e overflow quando aplicaveis.
5. Atualizar Storybook, ajuda e documentacao afetados.
6. Executar testes focados de componente/rota, acessibilidade e type-check; deixar o conjunto final agregado para `entregar-issue`.

## Plano de evidencia eficiente

Agrupar casos por classe distinta de:

- rota e audiencia;
- estado visual/semantico;
- composicao responsiva;
- interacao de teclado ou permissao.

Executar uma amostra representativa por classe, usando desktop e mobile quando houver layouts distintos. Incluir tablet somente quando breakpoint ou composicao mudar. Nao repetir screenshot/E2E quando rota, dados, viewport, estado, SHA e resultado tiverem fingerprint identico.

## Verificacao e auditoria

Operar em leitura. Rederivar criterios no modo independente; no modo interno, usar o recorte recebido. Testar conteudo longo, viewport reduzida, teclado, zoom, estados e permissoes somente quando vinculados ao risco/contrato.

Quando o mesmo estado atende audiencias distintas, exigir contrato explicito por audiencia e controles negativos que rejeitem a copy das audiencias irmas. rota autenticada, rota publica tokenizada e area administrativa devem ter semantica discriminante quando o contexto for diferente.

## Evidencia minima

Registrar rota, cenario, SHA, viewport, dados, interacao, observacao ou screenshot, requisito, resultado e fingerprint. Screenshot isolado sem contexto nao basta.

## Entrega

Retornar status, requisitos visuais, arquivos, classes de cenario, viewports, evidencias, findings, validacoes focadas, impacto documental, fingerprints e limitacoes. Nao fazer merge nem declarar auditoria independente no contexto de implementacao.

## Contrato de reutilizacao

Emitir `input_fingerprint` em toda execucao. Resultado novo usa `reused=false`. Reaproveitamento usa `reused=true` somente com `reuse_source` verificavel, identidade vigente, `changed_files=[]` e `requires_refreeze=false`; caso contrario, executar o recorte novamente.

## Contrato de composição versionado

Retornar `contract_version=2026-08-06.2` e não possuir ciclo, identidade global, estado compartilhado ou delegação de outras Skills. Consumir apenas o recorte e fingerprint recebidos do Entregar Issue; devolver `not-applicable` cedo quando o domínio não se aplicar.
