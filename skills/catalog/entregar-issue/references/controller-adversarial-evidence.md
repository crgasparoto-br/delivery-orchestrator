# Evidencia adversarial discriminante

## Objetivo

Impedir que um requisito seja aprovado apenas porque existe um teste chamado "negativo". Um controle negativo valido deve distinguir a implementacao correta de uma implementacao plausivel, executavel e incorreta.

## Contrato do controle negativo

Para cada identificador em `negative_controls`, registrar uma entrada correspondente em `negative_control_evidence` com:

- `id`: identificador estavel e unico no requisito;
- `risk_family`: familia de risco atacada;
- `dimension`: aspecto discriminante verificado;
- `failure_mode`: comportamento incorreto que o controle tenta revelar;
- `plausible_wrong_implementation`: implementacao errada que ainda poderia passar pelo caminho feliz;
- `control_type`: `test`, `gate`, `scenario` ou `procedure`;
- `procedure`: comando ou passos reproduziveis;
- `expected`: resultado exigido pelo contrato;
- `observed`: resultado efetivamente obtido no SHA congelado;
- `status`: `passed`, `failed` ou `not-run`;
- `evidence_path` e `evidence_sha256`: evidencia bruta verificavel;
- `head_sha`: SHA em que o controle foi executado;
- `sibling_cases`: variacoes proximas que impedem ajuste excessivo ao caso literal.

Um requisito `Implementado` exige correspondencia exata entre os IDs de `negative_controls` e `negative_control_evidence`, evidencia presente e hasheada, `status=passed` e `head_sha` igual ao SHA congelado.

## Qualidade minima

Rejeitar controles que:

- apenas repetem o caminho feliz com dados invalidos obvios;
- usam nome de teste, checklist ou descricao sem evidencia bruta;
- nao declaram qual implementacao errada seriam capazes de detectar;
- usam valores coincidentes entre fontes cuja precedencia esta em disputa;
- verificam somente que ocorreu erro, sem confirmar codigo, payload, estado ou ausencia de efeito;
- compartilham a mesma suposicao estrutural da implementacao auditada.

## Parsers e adaptadores de entrada

Quando houver parser, decoder, lexer, tokenizer, desserializador ou adaptador de entrada nao confiavel, ativar a familia `input-parser`. Toda entrada exige as tres dimensoes canonicas `raw-boundary-preservation`, `validation-order-error-precedence` e `syntax-mode-invariant-matrix`. Formatos hierarquicos exigem tambem `scope-membership`, `inactive-content` e `cross-scope-context`. Dimensoes complementares podem usar:

- `boundary-validity`: inicio, fim, tamanho, encoding e limites;
- `malformed-input`: truncamento, ordem invalida e estrutura incompleta;
- `ambiguity`: multiplas interpretacoes plausiveis ou campos concorrentes;
- `scope-membership`: registro fora do container, secao ou envelope canonico;
- `inactive-content`: comentario, bloco escapado, exemplo, CDATA ou conteudo desativado;
- `cross-scope-context`: metadado de uma secao aplicado indevidamente a outra;
- `duplicate-or-reordered-sections`: secoes repetidas, aninhadas ou reordenadas;
- `encoding-or-size`: BOM, caracteres invalidos, expansao e limites de memoria.

Para formatos hierarquicos ou baseados em containers, as seis dimensoes canonicas sao obrigatorias. Cada controle `input-parser` deve possuir pelo menos dois casos irmaos. O parser deve provar que extrai registros do escopo canonico, nao apenas que as tags ou tokens existem em algum ponto do documento. Derivar `consumed_fields` dos leitores reais e cruzar todas as branches — incluindo variante sem declaracao/cabecalho — com cada campo e os posicionamentos `direct`, `generic-container` e `scalar-container`; um campo representativo nao comprova os demais. A fronteira publica deve comprovar que helpers nao executam `trim`, coercao ou normalizacao antes de tamanho, vazio, encoding, hash e identidade, incluindo `limite + 1` e documento valido com padding externo acima do limite.

## Mudancas de estado documental

Quando uma funcionalidade muda de ausente, futura, parcial, experimental ou pendente para operacional, ativar uma verificacao `stale-claim-scan`. Buscar no repositorio inteiro alegacoes antigas e classificar cada ocorrencia como atual, historica, compatibilidade ou contradicao. Atualizar somente fontes canonicas; nao reescrever historico deliberado.


## Artefato obrigatorio de ataque

Quando `input-parser` estiver ativo, produzir `input-parser-attack-matrix.json` antes do freeze com `accepted_modes`, `consumed_fields`, `field_scope_placements`, matriz completa `mode_field_scope_matrix`, `raw_boundary_cases`, `error_precedence_cases`, `control_ids`, evidencias e hashes por celula requerida.

Os controles minimos sao `IP-RAW-001`, `IP-MODE-001`, `IP-SCOPE-001`, `IP-INACTIVE-001` e `IP-EFFECT-001`. Ausencia de uma celula requerida, de um campo consumido ou de evidencia no SHA congelado impede `INTERNALLY_APPROVED`.
