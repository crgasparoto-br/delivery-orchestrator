# Contrato com o Entregar Issue

Receber modo, contexto, requisitos de continuidade, produtores, entrypoints, caminhos, perfil, registro documental e fingerprint. Nao repetir descoberta geral.

Centralizar produtores equivalentes, selecionar cenarios por risco e usar pairwise quando o mesmo contrato cobre canais/variantes. Retornar JSON conforme `schemas/subskill-result.schema.json` com maquina de estados, produtores, persistencia, classes/casos, fingerprint e resultados discriminantes.

## Envelope e reutilizacao

Emitir sempre `input_fingerprint` e `reused`. Execucao nova usa `reused=false` e nao inclui `reuse_source`. Reutilizacao usa `reused=true` somente com `reuse_source.result_path`, SHA-256 e fingerprint conferidos, identidade material vigente, `changed_files=[]` e `requires_refreeze=false`. Status `not-applicable`, `no-change` ou `contract-mismatch` exige `skip_reason` objetivo.

## Versao

Aceitar e emitir somente `contract_version=2026-08-06.2`. Retornar `contract-mismatch` antes de executar trabalho quando a versao recebida diferir.
