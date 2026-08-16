# Execucao em uma unica invocacao

## Regra de controle

Propagar `controller_mode=delivery-single-invocation` para todas as Skills participantes. `entregar-issue` e `auditar-issue` devem devolver resultados ao controlador e nao pedir nova conversa.

## Separacao de fases

No fallback `controller-adversarial`:

1. finalizar implementacao e congelar identidade;
2. bloquear edicoes;
3. construir pacote neutro sem justificativas do implementador;
4. rederivar contrato;
5. revisar diff e comportamento legado;
6. executar gates oficiais e controles negativos;
7. emitir parecer antes de reabrir escrita.

A ausencia de contexto limpo nao e bloqueio e nao autoriza chamar a auditoria de independente.

## Handoffs internos

- `pronto-para-auditoria-independente` vira `ready-for-controller-audit`.
- Handoff e artefato interno, nao mensagem ao usuario.
- Parecer com achado bloqueante inicia remediacao automaticamente.
- Parecer favoravel ainda passa pelo avaliador deterministico.

## Paradas permitidas

Parar em `INTERNALLY_APPROVED` quando a passagem interna estiver limpa mas nenhum auditor independente real estiver disponivel. Esse resultado e provisório e nao libera merge. Tambem parar por dez ciclos consumidos, impedimento externo real sem alternativa segura, acao destrutiva sem autorizacao ou issue impossivel de identificar unicamente.

## Pacote neutro v5

Antes da auditoria, congelar o manifesto de artefatos e bloquear escrita. A passagem controller-adversarial deve iniciar depois do freeze e terminar com `controller-audit-report.json` schema 3. Nao usar o handoff do implementador como substituto de `source-manifest`, rederivacao ou matriz de cobertura.

## Limite honesto da chamada unica

A chamada unica pode completar implementacao e auditoria controller-adversarial, mas nao deve fabricar independencia. Quando nenhum auditor independente realmente separado estiver disponivel, terminar em `INTERNALLY_APPROVED`, declarar o portao independente pendente e nao usar linguagem de conclusao operacional.

O pacote neutro destinado ao auditor independente deve conter somente fontes canonicas, identidade, diff, codigo, testes, manifests e evidencias brutas. Excluir resumo de implementacao, conclusoes, parecer anterior, lista de alegacoes atendidas e justificativas do implementador.
