# Preflight de gates e alcance de evidencia

## Objetivo

Fechar cedo o que ja e determinante sem reduzir cobertura de blockers baratos. Consultar o estado remoto do candidato antes de gastar orcamento com provas caras e distinguir claramente teste declarado de teste realmente alcancado e aprovado.

## Ordem obrigatoria

1. Congelar `head`, base e merge preview.
2. Consultar runs/statuses existentes para a identidade atual em modo somente leitura; nunca disparar ou reexecutar workflow.
3. Obter o conjunto de arquivos alterados antes de atribuir causa a uma falha.
4. Classificar cada gate obrigatorio como `green`, `red-candidate-caused`, `red-inherited-or-infra`, `not-reached`, `missing` ou `unknown`. Registrar separadamente `audit-runtime-limitation` quando a propria infraestrutura do auditor impedir observar/executar o gate; essa classificacao nao e estado do candidato.
5. Registrar a matriz de alcance de testes antes de usar nomes de testes como evidencia.

## Classificacao de origem da falha

Usar `red-candidate-caused` somente quando houver evidencia discriminante de que a falha pertence ao candidato, por exemplo:

- arquivo reportado pelo gate pertence a `changed_files`;
- stack trace termina em arquivo ou teste adicionado/alterado pela PR;
- fixture, script ou configuracao nova do candidato falha deterministicamente;
- o diff introduz a pre-condicao que causa a falha observada.

Se a atribuicao for ambigua, usar `unknown` e investigar base/infra somente o suficiente para resolver a classificacao. Nao culpar a PR por proximidade temporal.

## Matriz declared/reached/passed

Para suites sequenciais, registrar por teste ou familia material:

| Campo | Significado |
|---|---|
| `declared` | existe no codigo, manifest ou comando da suite |
| `reached` | o runner realmente iniciou esse teste/familia no run auditado |
| `passed` | o teste/familia terminou com sucesso no run auditado |

Regras:

- `declared=true` nunca implica `reached=true`;
- quando a suite aborta no primeiro erro, testes posteriores ficam `reached=false`, `passed=false`;
- nao usar teste nao alcancado para marcar requisito como implementado operacionalmente;
- um teste focado verde pode provar apenas o escopo que executou, nao a suite inteira.

## Modo blocker-bounded

Entrar em `blocker-bounded` quando qualquer gate obrigatorio estiver `red-candidate-caused`, `missing` ou materialmente `not-reached` **por responsabilidade demonstrada do candidato/entrega**. Nao entrar em `blocker-bounded` por `audit-runtime-limitation`; encerrar como `INCONCLUSIVA` sem finding de produto. A partir desse ponto:

1. o parecer nao pode ser aprovatorio enquanto a identidade permanecer igual;
2. cancelar provas caras nao relacionadas;
3. continuar somente a varredura barata capaz de revelar blockers adicionais, agrupar causa raiz ou reduzir a remediacao;
4. reutilizar evidencia verde existente para escopos ja comprovados, sem repetir a suite;
5. manter verificacoes obrigatorias de seguranca/privacidade diretamente relacionadas ao diff, mesmo com gate vermelho;
6. revalidar identidade e estado remoto no encerramento.

A varredura barata minima deve cobrir:

- todos os arquivos alterados diretamente citados pela falha;
- entrypoints e consumidores imediatos do requisito bloqueado;
- fronteiras de autorizacao, privacidade, persistencia ou segredo tocadas pelo mesmo diff;
- contradicoes documentais introduzidas pelo candidato que declarem como concluido um gate ainda vermelho;
- outros blockers observaveis sem nova infraestrutura ou suite cara.

Nao encerrar no primeiro blocker quando outros equivalentes sao baratos de observar. O objetivo e devolver um conjunto coeso de work items no mesmo ciclo.

## Reuso de evidencia verde

Quando um job oficial verde corresponde exatamente ao SHA/merge preview congelado, ambiente e escopo relevantes:

- aceitar o resultado como evidencia de execucao para aquele escopo;
- abrir harness/script somente para entender o que foi efetivamente exercitado;
- nao rerodar apenas para produzir nova atestacao;
- nao extrapolar um job visual verde para backend, persistencia ou retry completo que ele nao executou.

## Precedencia de estado

Para identidade e operacao corrente, usar a seguinte precedencia:

1. metadata remota atual e runs/statuses existentes;
2. artefatos brutos do run atual;
3. codigo/testes/configuracao do candidato;
4. descricao da PR, checklist, comentario ou narrativa da implementacao.

Se a descricao da PR disser que nao existem runs, mas a consulta remota atual mostrar runs, considerar a descricao desatualizada e usar o estado remoto.

## Saida minima do preflight

Registrar:

- identidade congelada;
- gates obrigatorios e classificacao;
- causa atribuida e evidencia de `changed_files` quando aplicavel;
- matriz `declared/reached/passed` para suites afetadas;
- `blocker_bounded=true|false`;
- provas caras puladas e `skip_reason` objetivo;
- evidencias verdes reutilizadas e escopo de cada uma.


## Limitação da infraestrutura do auditor

Nao transformar incapacidade do runtime de montar recursos internos da Skill, baixar bytes completos ou executar um validador em `missing`, `not-reached` ou `red-candidate-caused`. Registrar `audit-runtime-limitation`, manter o gate sem conclusao sobre o candidato e impedir aprovacao sem atribuir culpa a implementacao.
