# Fechamento obrigatorio de audit escape

## Objetivo

Impedir ciclos `auditar -> corrigir caso literal -> auditar novamente` quando uma auditoria independente encontra defeito material em candidato antes aprovado internamente. Um `audit_escape` demonstra lacuna dupla: prevencao deixou o defeito entrar e deteccao interna nao o distinguiu.

## Aplicabilidade

Ativar quando um finding independente bloqueante ou alto contradizer parecer interno favoravel do mesmo candidato ou da mesma familia de implementacao. Consumir o finding estruturado sem redescobrir requisitos nao afetados.

## Fechamento da classe, nao do sintoma

Antes de editar, registrar:

- `escape_id` e finding de origem;
- `escape_class` generalizavel;
- implementacao plausivel errada que passou no gate interno;
- fronteira exata em que o controle deveria ter falhado;
- caso literal reproduzivel;
- no minimo dois `sibling_cases` baratos que variem uma dimensao relevante;
- `required_attack_dimensions`: conjunto minimo de ataques que a proxima entrega deve provar, cada um com `risk_family`, `surface` e `dimension`;
- `prevention_change` e `detection_change`;
- teste preventivo que falharia antes da correcao;
- controle adversarial reutilizavel com ID estavel;
- `trigger_terms`/sinais para reconhecer a classe em issues futuras;
- `required_risk_families` que devem ser saturadas quando o padrao reaparecer.

Nao considerar fechado quando somente o fixture ou branch literal do finding foi corrigido. Para classes que podem atravessar mais de um canal, `required_attack_dimensions` deve cobrir superficies distintas quando a arquitetura as expuser. Dois casos `environment` nao fecham uma classe que tambem pode ocorrer em `filesystem`, credential store persistente, artifact ou identidade de processo.

## Artefato obrigatorio

Produzir `.audit/entregar-issue/audit-escape-closure.json` com uma entrada por escape:

```json
{
  "escape_id": "A-001",
  "escape_class": "role-secret-boundary-leak",
  "source_audit": {"head_sha": "...", "finding_id": "A-001"},
  "plausible_wrong_implementation": "Filter environment variables but leave another cross-role secret channel readable.",
  "literal_case": {"procedure": "...", "status": "passed", "evidence": "..."},
  "sibling_cases": [
    {"id": "env-reciprocal", "surface": "environment", "dimension": "reciprocal-role", "status": "passed", "evidence": "..."},
    {"id": "fs-cross-read", "surface": "filesystem", "dimension": "cross-role-file-readability", "status": "passed", "evidence": "..."}
  ],
  "required_attack_dimensions": [
    {"risk_family": "authorization", "surface": "environment", "dimension": "env-secret-filtering"},
    {"risk_family": "authorization", "surface": "filesystem", "dimension": "cross-role-file-readability"}
  ],
  "prevention_change": {"skill_or_code": "...", "evidence": "..."},
  "detection_change": {"skill_or_gate": "...", "control_id": "...", "evidence": "..."},
  "trigger_terms": ["..."],
  "required_risk_families": ["authorization"],
  "status": "passed"
}
```

Exigir evidencia no SHA final para caso literal e casos irmaos. `status=passed` somente quando prevencao e deteccao foram fortalecidas, todas as `required_attack_dimensions` foram incorporadas a `requirement-attack-matrix.json` e todos os controles obrigatorios passaram. Depois, executar `scripts/merge_audit_escape_patterns.py` para incorporar a classe, as dimensoes obrigatorias e os sinais ao catalogo e registrar os controles em `inherited-controls.json`.

## Regra de reenvio

Nao congelar nem encaminhar para nova auditoria independente enquanto qualquer escape estiver `open`, `failed`, `not-run`, sem `required_attack_dimensions` suficientes ou com uma dimensao obrigatoria nao coberta no novo SHA. Depois do fechamento, executar novamente o gate adversarial interno completo afetado. A auditoria independente seguinte deve confirmar a defesa, nao ser a primeira a executar uma nova superficie da mesma classe.
