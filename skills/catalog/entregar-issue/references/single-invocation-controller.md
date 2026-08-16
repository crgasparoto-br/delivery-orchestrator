# Contrato de controlador de chamada unica

## Ativacao

Aplicar quando `execution-context.json` contiver:

```json
{
  "controller_mode": "issue-loop-single-invocation",
  "controller_context_id": "<id>",
  "controller_cycle_limit": 10
}
```

## Responsabilidade

Consumir o plano validado produzido pelo `entregar-issue`; nao repetir planejamento quando os fingerprints conferirem. Executar especificacao, implementacao, validacoes, higienizacao, freeze, estado remoto e dossie normalmente. Ao atingir o handoff, devolver controle ao `entregar-issue` no mesmo prompt.

## Retorno obrigatorio

Retornar resultado conforme `schemas/subskill-result.schema.json`:

```json
{
  "schema_version": 1,
  "contract_version": "2026-08-06.2",
  "skill": "entregar-issue",
  "mode": "issue-loop-single-invocation",
  "status": "passed",
  "findings": [],
  "validations": [],
  "artifacts": [],
  "changed_files": [],
  "limitations": [],
  "requires_refreeze": false,
  "input_fingerprint": "<sha256>",
  "reused": false,
  "data": {
    "controller_disposition": "ready-for-controller-audit",
    "canonical_state": "pronto-para-auditoria-independente",
    "head_sha": "...",
    "base_sha": "...",
    "merge_preview_sha": "..."
  }
}
```

Usar `findings`, `specification-gap` ou `blocked` quando aplicavel. Nunca pedir ao usuario que abra nova conversa neste modo.

## Integridade

- Nao declarar auditoria independente.
- Nao transicionar para `aprovado` por parecer do mesmo run.
- Nao ocultar handoff, pacote ou identidade do controlador.
- Nao encerrar a chamada principal; o controlador decide auditar, remediar ou parar.
- Qualquer mudanca apos freeze exige `requires_refreeze=true`.

## Handoff v5

O handoff controller deve incluir manifesto de artefatos com path, SHA-256 e head SHA; `changed_files`; familias de risco; gates atestados; e resultados hasheados de subskills. A ausencia de qualquer item aplicavel deve retornar `controller_disposition=remediation-required`, nunca `ready-for-controller-audit`.
