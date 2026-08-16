# Contrato com o Entregar Issue

## Entrada

Receber identidade, handoff neutro, fontes, diff e caminhos dos artefatos. Tratar todos como alegacoes. Receber fingerprint da identidade auditada quando houver.

## Independencia e reutilizacao

Auditoria importavel exige contexto diferente do `implementation_context_id` e chave previamente confiada. Em controller, usar `controller-adversarial` e devolver ao controlador. Reutilizar relatorio somente para fingerprint identico e identidade vigente; qualquer mudanca material exige nova auditoria.

## Saida

Produzir relatorio, resultado conforme `schemas/subskill-result.schema.json` e artefatos de auditoria. No controller, incluir `controller_disposition`, parecer, garantia, identidade, findings, recomendacoes, fingerprint e indicador de reaproveitamento. Nunca alterar a implementacao.

## Envelope e reutilizacao

Emitir sempre `input_fingerprint` e `reused`. Execucao nova usa `reused=false` e nao inclui `reuse_source`. Reutilizacao usa `reused=true` somente com `reuse_source.result_path`, SHA-256 e fingerprint conferidos, identidade material vigente, `changed_files=[]` e `requires_refreeze=false`. Status `not-applicable`, `no-change` ou `contract-mismatch` exige `skip_reason` objetivo.

## Versao

Aceitar e emitir somente `contract_version=2026-08-06.2`. Retornar `contract-mismatch` antes de executar trabalho quando a versao recebida diferir.
