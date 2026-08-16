# Contrato com o Entregar Issue

Receber contexto, lacunas materiais do readiness gate, fontes preliminares, versao e registro documental. Limitar a revisao aos pontos bloqueantes; nao repetir descoberta ou reescrever secoes nao afetadas.

Retornar JSON conforme `schemas/subskill-result.schema.json` com readiness, versoes, `invalidates_previous_snapshot`, fontes alteradas, perguntas abertas, fingerprint de entrada e escopo examinado. Retornar `not-applicable` para lacuna apenas editorial. Nao iniciar implementacao.

## Envelope e reutilizacao

Emitir sempre `input_fingerprint` e `reused`. Execucao nova usa `reused=false` e nao inclui `reuse_source`. Reutilizacao usa `reused=true` somente com `reuse_source.result_path`, SHA-256 e fingerprint conferidos, identidade material vigente, `changed_files=[]` e `requires_refreeze=false`. Status `not-applicable`, `no-change` ou `contract-mismatch` exige `skip_reason` objetivo.

## Versao

Aceitar e emitir somente `contract_version=2026-08-06.2`. Retornar `contract-mismatch` antes de executar trabalho quando a versao recebida diferir.
