# Fechamento de fluxos de alto risco

Aplicar este contrato antes de declarar uma implementação pronta.

## Fronteira pública e não enumeração

Comparar pelo menos dois estados secretos que não podem ser distinguidos pelo chamador. Provar igualdade ou equivalência contratual de:

- status, código, shape e texto público;
- headers relevantes e desafios de autenticação;
- efeitos persistentes, eventos e logs expostos;
- posição de rate limit, autenticação e guards sensíveis;
- faixa de latência sob amostra suficiente quando o custo interno divergir.

Executar o controle diretamente no endpoint público. Não aceitar teste exclusivo de helper, middleware ou frontend.

## Mutação condicionada e concorrência

Para cada operação, produzir uma tabela com: decisão de negócio, fontes mutáveis, autorização/escopo, lock ou isolamento, constraints, mutação, efeitos derivados e retry.

Manter a decisão definitiva e a mutação na mesma fronteira transacional. Revalidar depois do lock e antes do commit quando houver janela mutável. Se a regra depender de ausência ou unicidade, apoiar a garantia no banco ou em serialização equivalente.

Executar interleavings com duas conexões:

1. preflight aprovado;
2. pausa controlada;
3. sessão concorrente cria conflito, revoga autoridade, muda escopo, responsável, tenant, versão ou dado revisado;
4. sessão original tenta concluir;
5. provar rollback sem mutação, evento, timestamp ou resposta sensível.

## Vigência e revisão

Tratar “vigente”, “atual”, “revisado” e “aprovado” como comparação, não presença.

- Comparar versão/fingerprint persistida à fonte canônica atual.
- Persistir o conjunto ou fingerprint das fontes revisadas.
- Invalidar a revisão quando qualquer fonte relevante mudar.
- Testar cada fonte individualmente, inclusive origem, unidade, responsável, observações e configuração/consentimento quando fizerem parte da decisão.

## Relações canônicas e dados legados

Para relações de consolidação, substituição ou canonicalização:

- definir invariantes de grafo: sem ciclo, sem cadeia, sem múltiplos destinos e sem destino posteriormente convertido em origem;
- proteger inserção, atualização dos dois lados e operações administrativas;
- validar dados legados antes do backfill e o resultado depois dele;
- preferir constraint/trigger/índice ou transação serializável quando a regra atravessar linhas;
- testar criação direta, atualização posterior, concorrência e dataset legado patológico.

## Revisão administrativa e permissões

Derivar da issue um inventário de campos e ações. Para cada item, registrar fonte, estado vazio, sensibilidade e permissão específica.

Testar a matriz de capacidades: leitura sem ação, ação com leitura mínima necessária, link sensível ausente sem permissão e presente com ela. Não reutilizar uma permissão ampla como pré-requisito acidental de outra ação.

## Transição terminal

Para cada transição de estado visível, comprovar:

- confirmação inequívoca do resultado;
- próximas ações com o identificador/contexto correto;
- persistência após reload e navegação;
- consulta, aba ou filtro capaz de localizar o estado terminal;
- ausência de dependência em estado efêmero de navegação;
- permissões mínimas necessárias para ver e executar cada ação.

## Erros publicos e validacao antes do adapter

Para endpoints que recebem IDs, enums, datas ou outros valores tipados pelo banco:

- validar formato e combinacao na fronteira publica antes de executar query, SDK ou adapter;
- cobrir o caso literal e pelo menos dois IDs irmaos de papeis diferentes, como origem, destino e categoria;
- exigir codigo 4xx controlado e provar ausencia de mensagens de cast, SQLSTATE, constraint ou SQL;
- para falha inesperada de persistencia, injetar marcadores sensiveis na mensagem bruta e provar que a resposta retorna apenas codigo 5xx generico, mensagem fixa e `correlationId`;
- mapeamentos conhecidos de banco devem usar texto estatico controlado, nunca `error.message`;
- verificar rollback, chave idempotente nao consumida e ausencia de efeito parcial no mesmo cenario.

Controle reutilizavel `PB-ERR-001`: uma excecao do adapter com `code=P0001` e marcadores `fingerprint`, `idempotencyKey` e valor financeiro deve produzir `API_UNEXPECTED_ERROR` sem nenhum marcador na resposta.

## Formularios transacionais com retry e idempotencia

Quando a interface coordena chave idempotente, timeout ambiguo ou bloqueio de envio duplicado:

- executar o entrypoint real em navegador, interceptando apenas a rede necessaria para provocar timeout ou resposta ambigua;
- provar uma requisicao por confirmacao, mesma chave no retry ambiguo, chave nova apos correcao material confirmada e ausencia de duplicacao persistida;
- provar modal e valores preservados, controle restaurado apos falha e bloqueio de dupla submissao;
- cobrir desktop, mobile e teclado quando citados no contrato, com evidencia bruta e screenshots;
- rejeitar teste que apenas busca strings, regex ou nomes de funcoes no source.

## Evidência mínima

Não aceitar apenas teste unitário do caminho feliz. Exigir pelo menos uma prova pública ou de integração, uma prova concorrente quando houver mutação condicionada e um controle negativo que passe na implementação correta e falhe na aproximação plausível.
