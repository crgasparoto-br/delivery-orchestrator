# Gate F34 — Entrada nao confiavel e parser

Preencher `risk_profile.input_parser_contract` com `accepted_modes`, `structural_invariants`, `mode_invariant_matrix`, `consumed_fields`, `field_scope_placements`, `mode_field_scope_matrix`, `raw_boundary_stages`, `raw_boundary_cases`, `error_precedence_cases`, `control_ids` e `hierarchical`.

A matriz de campo e o produto cartesiano completo `modo x campo consumido x posicionamento`; em hierarquia, incluir `direct`, `generic-container` e `scalar-container`. Um campo representativo nao substitui o inventario integral.

Casos brutos obrigatorios: `missing`, `empty`, `whitespace-only`, `exact-limit`, `limit-plus-one`, `valid-plus-external-padding-over-limit`, `over-limit-before-transformation`, `representation-changing-transform` e `invalid-encoding-or-header`.

Controles obrigatorios: `IP-RAW-001`, `IP-MODE-001`, `IP-SCOPE-001`, `IP-INACTIVE-001` e `IP-EFFECT-001`.

Checks F34 obrigatorios: `parser-direct-call`, `public-boundary-call`, `raw-input-preserved`, `missing-empty-distinguished`, `whitespace-only-domain-error`, `exact-size-boundary`, `limit-plus-one-rejected`, `valid-plus-external-padding-rejected`, `over-limit-before-transformation`, `error-code-precedence`, `identity-or-hash-representation-verified`, `all-consumed-fields-covered` e `no-side-effects-on-rejection`. Em hierarquia, incluir `direct-scope-membership`, `scalar-as-container`, `unknown-wrapper`, `inactive-content`, `cross-scope-metadata`, `duplicate-or-reordered-sections` e `mode-without-declaration-or-equivalent`.

Cenarios F34 listam `mode_invariant_pairs`, `mode_field_scope_cases`, `boundary_stages`, `boundary_cases`, `error_precedence_cases`, `control_ids`, `checks` e evidencia `boundary-call` mais evidencia discriminante.
