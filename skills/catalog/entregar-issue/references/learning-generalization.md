# Generalizacao de aprendizado operacional

## Objetivo

Transformar uma rejeicao concreta em defesa reutilizavel sem acoplar a Skill a repositorio, produto, issue, PR, branch, SHA, framework ou caminho especifico.

## Separacao obrigatoria

Manter dois niveis distintos:

1. Evidencia local da entrega: pode conter repositorio, issue, PR, SHA, arquivos, caso literal e logs. Persistir em `.audit/entregar-issue/`.
2. Regra promovida da Skill: deve conter somente a classe generalizada da falha, sinais estruturais, familias de risco, prevencao, deteccao e controles transferiveis.

Nunca copiar identificadores concretos do nivel 1 para regras, referencias ou testes permanentes da Skill.

## Learning event em toda rejeicao

Toda rejeicao independente deve produzir `learning-closure.json`, mesmo quando nao houver alteracao permanente de Skill.

Classificar o evento como:

- `implementation-only`: defeito local sem lacuna sistemica no processo. Exigir regressao no repositorio e justificar por que nenhuma regra global e necessaria.
- `systemic-escape`: finding que escapou de parecer interno favoravel, handoff incorreto, gate ausente, regra ambigua ou falha de composicao. Exigir promocao de aprendizado generico.

## Promocao de aprendizado sistemico

Para `systemic-escape`, exigir:

- `escape_class` sem referencia a dominio concreto;
- `generalized_failure_pattern`;
- `plausible_wrong_implementation`;
- sinais/termos estruturais de ativacao;
- familias de risco aplicaveis;
- um controle reutilizavel com ID estavel;
- uma regra de prevencao e uma de deteccao;
- ao menos dois `transfer_cases` em superficies distintas e sinteticas;
- mudanca de Skill de prevencao e de deteccao quando o mesmo candidato havia sido aprovado internamente;
- testes genericos que falhariam antes da mudanca.

Se a regra so puder ser descrita citando a issue original, ela ainda nao foi generalizada e nao pode ser promovida.

## Genericidade obrigatoria

Em campos promovidos e testes permanentes, proibir:

- numero de issue/PR real como chave do teste;
- slug de repositorio real;
- SHA de candidato;
- branch real;
- caminho de arquivo do sistema que originou o finding como requisito da regra;
- nome de produto, entidade de negocio ou frase literal que seja necessaria apenas para reproduzir o caso de origem.

Fixtures permanentes devem usar nomes sinteticos como `canonical_adapter`, `specialized_adapter`, `public_entrypoint`, `tenant_a`, `historical_period` e equivalentes.

## Fechamento

Executar `scripts/validate_learning_closure.py` para validar o evento. Quando houver promocao de Skill, executar tambem `scripts/validate_skill_genericity.py` e a suite da Skill/ecossistema antes de novo handoff.
