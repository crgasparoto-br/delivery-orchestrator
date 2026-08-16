# Varredura de contratos concorrentes

## Aplicabilidade

Executar quando a mudanca alterar rota, arquitetura, nomenclatura, estado atual, disponibilidade, fluxo principal, redirect, aposentadoria, substituicao ou compatibilidade legada.

## Inventario

Registrar:

- termos, rotas e frases do contrato anterior;
- termos, rotas e frases do contrato novo;
- sinonimos e expressoes de transicao (`ainda nao`, `futuro`, `pendente`, `parcial`, `experimental`, `somente`, `atual`, `operacional`, `disponivel`);
- comando ou mecanismo de busca executado no SHA final;
- raiz, inclusoes e exclusoes da busca;
- ocorrencias encontradas em todo o repositorio, inclusive fora do diff;
- classificacao de cada ocorrencia: contrato atual, historica, legado aposentado, compatibilidade, exemplo ou contradicao;
- contradicoes corrigidas e nova busca sem pendencias.

## Regra discriminante

Uma ocorrencia do comportamento antigo que contenha `atual`, `atualmente`, `existente`, `linha de base`, `hoje` ou equivalente deve ser tratada como contradicao, salvo quando a propria passagem declarar claramente que o comportamento e historico, aposentado ou apenas redirect de compatibilidade.

Quando uma capacidade muda de ausente, futura, parcial ou experimental para operacional, a busca global e obrigatoria mesmo que os documentos especializados tenham sido atualizados. README, indice central, matriz de status, ajuda e runbook devem ser comparados entre si.

Markdown valido, link correto, CI verde, descricao de PR ou atualizacao de outro documento nao compensam uma fonte canonica concorrente.
