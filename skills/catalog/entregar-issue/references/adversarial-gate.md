# Gate adversarial interno

## Pacote neutro

O pacote deve ser criado a partir do SHA limpo e conter:

- issue normalizada;
- patches separados de producao, testes e documentacao;
- arquivos de instrucao versionados;
- grafo de runtime com dependencias e callers reversos;
- snapshots imutaveis dos arquivos do fechamento, usando o head para arquivos vigentes e a base para arquivos removidos;
- imports nao resolvidos e cobertura dos resolvers;
- deteccao automatica do perfil de risco;
- manifesto com hash de todos os arquivos.

O grafo deve considerar aliases, workspaces e convencoes da stack. Limitacao material ou stack nao suportada deve ser explicita e reprovar o gate quando impedir a analise do fluxo.

## Passagem A

Rederivar os requisitos sem usar descricao da PR. Para cada requisito:

1. mapear o caminho real de producao;
2. registrar evidencia observavel;
3. formular uma implementacao incorreta plausivel;
4. registrar evidencia discriminante que a refute;
5. ligar ao menos um cenario executado;
6. decompor substantivo, qualificadores, negacoes, tempo, isolamento e cardinalidade em obrigacoes separadas quando produzirem comportamentos diferentes.

## Passagem B

Criar o plano antes de usar `tests.patch` como fonte. Usar issue, producao, documentacao, instrucoes e contexto transitivo. Registrar hash do plano.

Minimos:

- perfil comum: 3 cenarios em 2 familias;
- persistencia/fallback: 4 cenarios, incluindo F19;
- autorizacao/privacidade persistente: 5 cenarios em 4 familias, incluindo F17 e F18.
- perfil com F20 a F24: incluir cada familia aplicavel nos cenarios novos; um mesmo requisito pode exigir mais de um cenario quando as provas publicas, transacionais, de migration e visuais ocorrerem em fronteiras diferentes.
- perfil de contratos transitivos: incluir cada F28 a F33 aplicável. Exigir configuração não executável com callback espião, timeout pelo adapter real com SDK mockado, operação declarada sem método, recurso não traduzido, consumidores irmãos com recursos divergentes e variante legada distinta.
- perfil de entrada nao confiavel: incluir F34, inventario de branches reais, matriz modo x invariante, pipeline bruto e precedencia de erros.

Os cenarios devem atacar implementacoes plausiveis que satisfazem apenas parte do texto. Nao aceitar teste que passa igualmente com timestamp no lugar de resumo, label generica no lugar de tipo canonico, frontend no lugar da fronteira publica ou fixture em que fontes concorrentes possuem o mesmo valor.

## Passagem C — fechamento semantico

Executar integralmente [requirement-closure-gate.md](requirement-closure-gate.md).

A Passagem C deve:

- cobrir exatamente todos os requisitos e todas as obrigacoes extraidas da issue;
- provar qualificadores observaveis com controle negativo;
- fechar inventarios de dominios quando houver todos, cada, demais, suportados, integralmente ou equivalentes;
- comparar produtores, persistencia, API, consumidores e fallbacks, inclusive fora do diff;
- falhar se qualquer valor canonico conhecido cair em fallback generico;
- ser concluida sem usar a descricao da PR como fonte de verdade.

Sem `requirement-closure.json` valido e `pass_c` aprovado, o estado nao pode avancar para `pronto-para-auditoria-independente`.

## Correcao de achado

Para cada achado:

1. vincular aos requisitos e obrigacoes de origem;
2. classificar a causa do escape;
3. formular um invariante generalizado;
4. corrigir o caso literal;
5. criar pelo menos dois casos irmaos de familias distintas;
6. procurar o padrao em outros entrypoints, valores de dominio, superficies e dependencias;
7. atualizar o inventario semantico e, quando aplicável, `execution_state_boundaries`, `control_propagation_paths`, `capability_operation_mappings`, `request_translation_mappings`, `legacy_compatibility_matrix` e `documentation_claim_inventory`;
8. congelar novo SHA e repetir Passagens A, B e C.
9. para escapes de seguranca, concorrencia, migration ou transicao visivel, atualizar tambem os inventarios e cenarios de F20 a F24; nao registrar o caso apenas como teste irmao generico.

## F34 — Parsers e valor bruto

Quando `input_parser=true`, a Passagem B deve ser planejada antes de ler os testes e incluir matriz completa entre modos aceitos e invariantes, inventario dos campos consumidos e matriz modo x campo x posicionamento. Os cenarios devem comparar parser direto e fronteira publica e executar limite exato, `limite + 1`, documento valido com padding externo acima do limite, excesso reduzido por normalizacao e precedencia de codigo. Para formato hierarquico, cada campo consumido como filho direto, tag escalar como contêiner, wrapper desconhecido/Unicode, conteudo inativo, metadado concorrente e variante sem declaracao sao obrigatorios. Registrar os controles `IP-*`.
