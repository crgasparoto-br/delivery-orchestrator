# Completude da descoberta documental

## Principio

`complete: true` nao prova que a descoberta esta completa. A completude deve ser sustentada por inventario reproduzivel e comparacao entre fontes descobertas e fontes declaradas.

## Evidencia minima

Registrar no resultado documental:

- raiz e SHA examinados;
- comandos ou mecanismo de descoberta;
- padroes e exclusoes utilizados;
- caminhos descobertos;
- caminhos declarados como fontes aplicaveis;
- caminhos omitidos com justificativa;
- fontes concorrentes e precedencia aplicada;
- consultas de termos antigos e novos;
- ocorrencias contraditorias abertas e resolvidas.

Nao aprovar quando uma fonte obrigatoria por `AGENTS.md`, README indice, documentacao central ou contrato afetado nao estiver declarada ou justificada.

## Mudanca de estado

Quando a entrega muda o estado de uma capacidade, rota, arquitetura ou nomenclatura, executar varredura global por alegacoes anteriores. A busca deve incluir sinonimos e frases de transicao como:

- ainda nao, futuro, pendente, parcial, experimental;
- somente, apenas, legado, temporario;
- atual, atualmente, hoje, operacional, disponivel;
- nomes, rotas e componentes substituidos.

Classificar cada ocorrencia como contrato atual, historico, compatibilidade, exemplo ou contradicao. Historico explicito pode permanecer; alegacao atual conflitante bloqueia conclusao.
