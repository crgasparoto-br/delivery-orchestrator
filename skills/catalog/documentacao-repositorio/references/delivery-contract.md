# Contrato com o Entregar Issue

Receber contexto, unico `documentation-impact.json`, caminhos/termos alterados e fingerprint anterior. Reutilizar o registro se head, fontes e fingerprint forem compativeis; ampliar apenas o delta. Retornar `not-applicable` quando ausencia de impacto for demonstravel. Na auditoria independente, refazer descoberta completa.

Retornar JSON conforme `schemas/subskill-result.schema.json` com registro atualizado, delta, fontes, contradicoes, validacoes, fingerprint e evidencias reutilizadas.

## Envelope e reutilizacao

Emitir sempre `input_fingerprint` e `reused`. Execucao nova usa `reused=false` e nao inclui `reuse_source`. Reutilizacao usa `reused=true` somente com `reuse_source.result_path`, SHA-256 e fingerprint conferidos, identidade material vigente, `changed_files=[]` e `requires_refreeze=false`. Status `not-applicable`, `no-change` ou `contract-mismatch` exige `skip_reason` objetivo.

## Versao

Aceitar e emitir somente `contract_version=2026-08-06.2`. Retornar `contract-mismatch` antes de executar trabalho quando a versao recebida diferir.
