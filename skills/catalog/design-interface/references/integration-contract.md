# Contrato de integração com as skills de issue

## Com `entregar-issue`

O `entregar-issue` deve:

1. detectar impacto visual na preparação;
2. carregar `design-interface` quando houver criação ou alteração visível;
3. executar o modo implementação antes de considerar o portão de implementação concluído;
4. exigir evidência visual inicial;
5. executar verificação interna no mesmo contexto apenas como pré-auditoria;
6. exigir auditoria visual independente em contexto separado sobre o SHA final;
7. devolver qualquer reprovação visual à fase de correção;
8. repetir a auditoria visual independente após toda alteração que afete UI;
9. manter a mesma branch e PR durante todo o ciclo.

A `design-interface` não deve criar branch ou PR própria dentro desse fluxo. O `entregar-issue` deve executar `documentacao-repositorio` em todas as fases, reutilizar um único registro compartilhado para descobrir instruções locais, validar Storybook, padrões de interface, ajuda e exemplos e bloquear a entrega quando fontes canônicas necessárias estiverem desatualizadas.

## Com nucleo interno de implementacao

A nucleo interno de implementacao deve delegar a esta skill quando a issue:

- cria ou altera página, modal, formulário, tabela, lista, dashboard, editor ou navegação;
- modifica layout, componentes, textos, estados ou responsividade;
- corrige defeito visual ou de usabilidade;
- possui screenshot, protótipo ou referência visual;
- altera frontend de forma perceptível ao usuário.

Executar `design-interface` em modo implementação. Incorporar arquitetura, código, testes e evidências à entrega da issue. Executar sempre `documentacao-repositorio`: primeiro para criar ou reutilizar o registro compartilhado e mapear impacto e instruções locais; depois para atualizar no próprio repositório os padrões visuais, exemplos, ajuda ou outras fontes afetadas, ou registrar justificativa objetiva de ausência de impacto.

## Com `auditar-issue`

A `auditar-issue` deve delegar a esta skill quando o escopo auditado possuir impacto visual. Executar em modo auditoria independente e somente leitura apenas quando o contexto estiver separado da implementação; caso contrário, classificar como verificação interna. Incluir `documentacao-repositorio` em modo auditoria para refazer a verificação das fontes visuais canônicas e instruções locais; o registro produzido na implementação serve apenas para localizar alegações.

A `design-interface` deve:

- rederivar critérios sem confiar na implementação;
- renderizar o produto e distinguir harness mockado de rota real;
- registrar viewports e cenários;
- emitir `Aprovada`, `Reprovada` ou `Não verificável` apenas na auditoria independente; em verificação interna, usar estado preliminar compatível;
- entregar achados rastreáveis para a matriz geral.

A `auditar-issue` deve:

- consolidar os achados no relatório principal;
- relacioná-los aos requisitos;
- considerar reprovação ou não verificação visual no parecer geral;
- não duplicar a auditoria especializada com uma checklist superficial.

## Impacto visual

Considerar impacto visual quando a alteração puder mudar qualquer elemento percebido ou operado pelo usuário, incluindo:

- conteúdo, label, mensagem, ícone ou ordem;
- layout, spacing, dimensionamento ou densidade;
- interação, foco, teclado, loading, erro ou vazio;
- visibilidade por permissão;
- responsividade, navegação ou fluxo;
- componente compartilhado com efeito em outras telas.

Mudanças internas sem efeito perceptível podem marcar a auditoria visual como não aplicável, com justificativa.
