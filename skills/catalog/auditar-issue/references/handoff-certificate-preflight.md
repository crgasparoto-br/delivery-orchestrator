# Preflight de certificado de handoff

## Objetivo

Evitar gastar uma auditoria independente para descobrir que a entrega nao executou gates deterministas de readiness e validar corretamente certificados persistidos em um commit filho somente de resultados.

## Regra fail-closed

Antes de descoberta ampla, exigir `.audit/entregar-issue/handoff-ready.json` quando a auditoria consumir uma entrega preparada por `entregar-issue`.

Validar com `<AUDIT_SKILL_ROOT>/scripts/check_delivery_preflight.py`; este script pertence a Skill `auditar-issue`, nao ao repositorio auditado.
Esse preflight delega a validacao criptografica/estrutural para `<AUDIT_SKILL_ROOT>/scripts/validate_handoff_certificate.py`; ambos os caminhos sao relativos ao pacote instalado da Skill.

O preflight deve validar:

- versao contratual esperada;
- proveniencia da Skill produtora;
- hashes de `specification-snapshot.json`, `requirement-closure.json`, `requirement-attack-matrix.json`, `risk-saturation.json` e `inherited-controls.json`;
- em reauditoria, hashes de `audit-escape-closure.json` e `learning-closure.json`;
- identidade material certificada;
- politica de publicacao do certificado.

## Certificado exact-head legado

Para schema v1 sem `certificate_commit_policy`, `identity.head_sha`, base e merge preview devem corresponder exatamente ao candidato auditado.

## Certificado schema v2 em result-only child

Um certificado versionado no repositorio nao consegue certificar o SHA do commit que o contem sem autorreferencia. Para schema v2, o modelo canonico e:

```text
base ---- material M ---- handoff H
```

O arquivo em `H` certifica `M`. Antes de executar saturation ou reauditoria:

1. ler `identity.material_head_sha` do certificado;
2. obter por fonte remota o parent do head publicado `H`;
3. obter os changed paths de `M..H` ou do commit `H`;
4. executar `check_delivery_preflight.py` passando `--head-sha H`, `--candidate-parent-sha M` e cada `--candidate-changed-path`;
5. aceitar apenas se `parent(H) == M` e todos os caminhos estiverem em `certificate_commit_policy.allowed_paths`;
6. usar `M`, nao `H`, como `head_sha` de attack matrix, saturation, inherited controls e closure;
7. manter `H` como `published_handoff_head_sha` para revalidacao remota e estado de merge/CI.

Qualquer arquivo de produto, teste, config ou documentacao material em `M..H` invalida o modo result-only child. Nesse caso o head publicado deve ser tratado como novo candidato material e necessita novo certificado.

## Classificacao de falha

Certificado realmente ausente no candidato, stale, com hash divergente, parent incorreto ou path fora da allowlist implica `delivery-not-ready`. Nao iniciar suite cara, descoberta ampla ou nova passagem adversarial.

Quando a unica causa for ausencia/staleness do handoff e nao houver finding funcional demonstrado, emitir tambem o retorno estruturado:

```text
return_control_to=entregar-issue
reason=handoff-not-produced|handoff-stale
recovery_scope=handoff-only
```

Esse retorno nao autoriza o auditor a criar ou corrigir o certificado; apenas permite ao produtor usar o fast path sem reimplementar a issue.

O certificado e indice de readiness, nao prova de correcao. Depois de valida-lo, a auditoria continua rederivando requisitos e executando seus proprios ataques discriminantes.

## Limitacao do runtime

Se o validador existir no pacote da Skill, mas o runtime nao permitir executa-lo ou nao permitir materializar os bytes exatos dos artefatos remotos, classificar `audit-runtime-limitation` e retornar `INCONCLUSIVA`. Nao classificar como `delivery-not-ready` e nao criar finding contra a issue. A ausencia comprovada do artefato no candidato, ao contrario, continua sendo `delivery-not-ready`.


## CI pendente nao substitui certificado

O certificado e produzido a partir do material head localmente pronto e deve estar publicado mesmo quando o snapshot de GitHub Actions ainda estiver `pending-no-run`, `queued`, `in_progress` ou `waiting`. Esses estados pertencem ao preflight de gates, nao ao readiness do handoff. Portanto nao aceitar a ausencia de `.audit/entregar-issue/handoff-ready.json` como consequencia normal de CI pendente; devolver `delivery-not-ready`/`handoff-only` para corrigir a composicao do produtor.
