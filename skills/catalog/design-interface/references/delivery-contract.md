# Contrato com o Entregar Issue

Receber modo, contexto, requisitos visuais, rotas, cenarios, caminhos, perfil, registro documental e fingerprint. Nao reiniciar especificacao geral.

Deduplicar evidencia por classe de rota, audiencia, estado, layout e interacao. Reutilizar evidencia somente com SHA, dados, viewport e resultado identicos. Retornar JSON conforme `schemas/subskill-result.schema.json` com `data.visual_evidence`, classes cobertas, fingerprint e validacoes focadas.

## Reutilizacao verificavel

Emitir `input_fingerprint` em execucao nova. Usar `reused=true` somente com `reuse_source.result_path`, hash e fingerprint conferidos, identidade vigente, `changed_files=[]` e `requires_refreeze=false`.

## Versão

Aceitar e emitir somente `contract_version=2026-08-06.2`. Retornar `contract-mismatch` antes de executar trabalho quando a versão recebida diferir.
