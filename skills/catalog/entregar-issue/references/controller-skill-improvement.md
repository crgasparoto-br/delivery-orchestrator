# Protocolo de melhoria de Skills

## Quando alterar

Alterar Skill quando evidencia mostrar que instrucoes, contratos, schemas, scripts ou exemplos omitiram gate, permitiram conclusao prematura, exigiram novo prompt sem necessidade, confundiram garantia com continuidade, repetiram defeito sistemico ou produziram composicao insuficiente.

Nao alterar Skill para mascarar bug pontual, reduzir gate ou justificar comportamento incorreto.

## Procedimento

1. Registrar nome, caminho e SHA-256 da Skill atual.
2. Relacionar o achado a lacuna concreta.
3. Formular regra generalizavel e verificavel.
4. Fazer a menor intervencao coerente.
5. Adicionar teste que falharia antes da mudanca.
6. Validar e empacotar a Skill completa. Para mudanca no ecossistema, executar `bash scripts/run_ecosystem_tests.sh --skills-root <raiz> --report <arquivo>`; o runner isola cada modulo de teste e evita dependencia de ordem.
7. Registrar hash anterior e posterior, arquivos e validacoes.
8. Criar `operational_amendment` com identificador, regra, escopo, justificativa e ciclo de inicio.
9. Aplicar a emenda localmente nos ciclos restantes.
10. Invalidar artefatos dependentes e continuar o loop.

## Autoalteracao e hot reload

Uma Skill carregada nao deve afirmar que foi recarregada durante a mesma invocacao. A versao empacotada vale para futuras invocacoes. No run atual, usar apenas a emenda operacional registrada, sem reinterpretar decisoes anteriores.

## Restricoes

Nunca flexibilizar limite de ciclos, identidade, evidencia, protecao de regressao, autorizacao destrutiva, classificacao honesta do nivel de garantia ou proibicao de aprovacao com achado bloqueante.

## Primeiro audit escape

Um `audit_escape` e causa sistemica por definicao. No primeiro escape, nao esperar recorrencia:

- classificar a causa entre `audit-defect`, `skill-defect` e causas contributivas;
- alterar ao menos uma Skill de prevencao, responsavel por especificacao/implementacao, e uma Skill de deteccao, responsavel por gate/auditoria, quando o mesmo SHA havia sido aprovado internamente; registrar `role: prevention|detection` em cada mudanca;
- adicionar teste de contrato da Skill;
- criar controle adversarial reutilizavel com ID estavel, familia de risco, comando ou procedimento e evidencia de falha anterior;
- registrar o vinculo entre escape, mudanca de Skill e controle.

## Falha dupla de controle

Finding independente contra SHA aprovado internamente implica duas lacunas ate prova em contrario: o defeito entrou na implementacao e o gate interno nao o distinguiu. A remediacao deve fortalecer ambos os lados. Para entrada nao confiavel, a prevencao deve exigir representacao bruta e matriz modo x invariante; a deteccao deve exigir F34, caso literal e casos irmaos executados.
