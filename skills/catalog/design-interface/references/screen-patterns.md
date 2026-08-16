# Padrões de distribuição por tipo de tela

Escolher o padrão pela tarefa dominante. Misturar padrões apenas quando houver justificativa funcional.

## Tela analítica ou dashboard

Ordenar normalmente:

1. título, período e contexto;
2. filtros globais essenciais;
3. indicadores principais, em quantidade limitada;
4. tendência, comparação ou composição;
5. exceções, alertas e itens que exigem decisão;
6. detalhamento tabular ou lista;
7. ações secundárias, exportação e metodologia.

Regras:

- não transformar toda medida em card;
- priorizar indicadores que mudem decisão;
- manter filtros próximos do conteúdo que afetam;
- usar gráficos somente quando facilitarem comparação, tendência ou distribuição;
- não repetir o mesmo dado em card, gráfico e tabela sem função distinta;
- apresentar unidades, período, fonte e estado de atualização.

## Tela de lista, inbox ou registros

Ordenar normalmente:

1. título, contagem ou contexto;
2. ação principal;
3. busca, filtros e ordenação;
4. lista ou tabela;
5. paginação ou carregamento progressivo;
6. ações de linha e seleção em massa;
7. estado vazio orientado à próxima ação.

Regras:

- manter linhas compactas e escaneáveis;
- priorizar data, identificação, status, valor e ação conforme o domínio;
- permitir ordenar campos temporais relevantes;
- não usar cards grandes para registros repetitivos quando lista resolve melhor;
- manter filtros ativos visíveis e fáceis de limpar.

## Formulário de criação ou edição

Ordenar normalmente:

1. título e contexto mínimo;
2. identificação essencial;
3. dados principais por domínio;
4. opções e detalhes secundários;
5. revisão ou consequências importantes;
6. ações de salvar e cancelar.

Regras:

- agrupar por significado;
- apresentar dependências antes dos campos que elas alteram;
- ocultar opções avançadas somente quando forem realmente secundárias;
- usar etapas quando o volume ou a dependência tornar uma página única difícil de compreender;
- não usar duas colunas em campos longos ou com erro multilinha.

## Tela de escrita, editor ou conteúdo

Ordenar normalmente:

1. título/documento e status;
2. ações principais de salvar, publicar ou enviar;
3. área de escrita dominante;
4. metadados essenciais;
5. opções de revisão, histórico ou colaboração;
6. configurações avançadas em painel secundário.

Regras:

- dar espaço visual à tarefa de escrita;
- evitar painéis laterais competindo com o conteúdo;
- manter estado de salvamento visível sem interromper;
- preservar foco, atalhos e recuperação de conteúdo;
- separar edição do conteúdo de configurações editoriais.

## Tela de detalhe

Ordenar normalmente:

1. identificação e status;
2. ações do registro;
3. resumo dos dados mais relevantes;
4. seções por domínio ou linha do tempo;
5. relacionamentos e anexos;
6. histórico, auditoria e ações destrutivas.

Regras:

- evitar uma grade uniforme de cards para todos os campos;
- destacar dados que orientem decisão;
- usar definition list, tabela ou pares label/valor conforme a natureza do dado;
- manter ações destrutivas no final ou em menu separado.

## Configurações

Ordenar normalmente:

1. navegação por categoria;
2. título e consequência da configuração;
3. controles relacionados;
4. ajuda contextual apenas onde houver ambiguidade;
5. salvar, aplicar ou feedback de persistência;
6. zona de risco separada.

Regras:

- evitar uma página longa sem agrupamento;
- não misturar preferências pessoais, integrações e segurança na mesma seção;
- indicar quando a alteração é imediata, global ou irreversível.

## Fluxo ou wizard

Ordenar normalmente:

1. progresso e nome da etapa;
2. objetivo da etapa;
3. campos ou decisões atuais;
4. validação e ajuda contextual;
5. voltar e avançar;
6. revisão final antes da confirmação.

Regras:

- usar wizard somente quando houver sequência ou dependência real;
- preservar dados ao voltar;
- permitir compreender o que falta;
- não dividir um formulário simples em etapas artificiais.

## Escolha entre modal, drawer e página

- **Modal**: ação curta, foco único, baixa quantidade de dados.
- **Drawer**: inspeção ou edição contextual mantendo referência à lista.
- **Página**: tarefa longa, múltiplas seções, URL própria, navegação ou risco elevado.

## Ordenação lógica universal

Quando nenhum padrão se encaixar, ordenar por:

1. orientação: onde estou e sobre o quê;
2. contexto: período, status, entidade e restrições;
3. decisão: o que preciso entender;
4. ação: o que posso fazer agora;
5. detalhe: evidências e dados complementares;
6. exceção: erros, riscos e itens raros;
7. histórico: rastreabilidade e ações destrutivas.
