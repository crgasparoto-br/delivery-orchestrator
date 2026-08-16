# Portoes de persistencia, elegibilidade e TOCTOU

## F19 - persistencia e indisponibilidade

Para cada fronteira persistente:

- declarar adapter, durabilidade e fallback;
- executar o adapter real em ambiente de producao ou equivalente;
- indisponibilizar banco, fila, cache, provider ou rede;
- executar reinicio;
- executar multiplas instancias quando a durabilidade for obrigatoria;
- provar ausencia de outbound orfao e mutacao antes da persistencia;
- provar reconstrucao e efeito unico quando aplicavel.

Memoria do processo nao equivale a persistencia duravel, salvo contrato versionado explicito.

### Limite de aplicação de F19

F19 aplica-se a persistência, durabilidade, reconstrução, efeitos órfãos e múltiplas instâncias. Retry ou fallback entre providers sem estado durável não ativa F19 por si só. Nesses casos usar F28 a F31. Não classificar ausência de tráfego produtivo como bloqueio quando a propriedade pode ser provada por contrato e integração adapter–SDK em ambiente de teste equivalente.

## F17 - elegibilidade

Para autorizacao ou privacidade persistente:

- listar todas as fontes canonicas mutaveis;
- cobrir `allowed-to-denied` e `denied-to-allowed`;
- reavaliar antes de carregar ou gravar dados sensiveis;
- cobrir mudancas administrativas, migrations e fallback aplicaveis.

## F18 - TOCTOU

Para cada operacao transacional:

- perder autoridade depois do preflight e antes do lock;
- perder autoridade depois do lock e antes do commit quando injetavel;
- revalidar definitivamente dentro da transacao;
- cobrir retry terminal/idempotente quando aplicavel;
- provar ausencia de mutacao, evento, timestamp ou resposta sensivel depois da perda de autoridade.
- incluir guards de negocio mutaveis, como ausencia de duplicidade, responsavel, unidade, escopo e status; middleware ou preflight fora da transacao nunca constitui revalidacao definitiva;
- executar com duas conexoes e barreiras controladas, nao apenas mocks sequenciais.
