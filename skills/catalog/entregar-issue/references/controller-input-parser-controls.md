# Controles reutilizaveis para input-parser

- `IP-RAW-001`: ausente, vazio, somente espacos, limite exato, `limite + 1`, documento valido com padding externo acima do limite e excesso reduzido por normalizacao, medidos antes de `trim`, decode ou canonicalizacao.
- `IP-MODE-001`: mesmos invariantes em todas as branches reais, inclusive modo sem declaracao, cabecalho ou marcador.
- `IP-SCOPE-001`: matriz completa `accepted_modes x consumed_fields x field_scope_placements`, com `direct`, `generic-container` e `scalar-container`.
- `IP-INACTIVE-001`: comentario, CDATA, escape, exemplo e bloco inativo nao influenciam cardinalidade, metadado ou extracao.
- `IP-EFFECT-001`: fronteira publica confirma status/codigo exatos, zero persistencia, zero mutacao e log/auditoria redigidos.

Gerar `input-parser-attack-matrix.json` antes do freeze e rederivar seu inventario na auditoria. Campo representativo, nome de teste ou CI verde nao satisfazem o portao.
