# Controles herdados cumulativos

## Objetivo

Garantir que cada novo candidato preserve as defesas exigidas por todas as auditorias independentes anteriores da mesma issue, PR ou familia, em vez de corrigir apenas o ultimo finding.

## Artefato

Manter `.audit/entregar-issue/inherited-controls.json` com:

- `head_sha` do candidato atual;
- `source_audits` identificando auditorias anteriores consideradas;
- `controls` com ID estavel, finding/escape de origem, `status`, evidencia e `head_sha`;
- `unresolved_controls`.

Se nunca houve rejeicao independente, o arquivo ainda deve existir com listas vazias. Se houve rejeicao, todo controle preventivo/detectivo herdado deve ser executado novamente no SHA final quando ainda aplicavel.

## Regra

Novo finding nao substitui controles antigos. Corrigir A-003 nao permite deixar de executar controles herdados de A-001/A-002. `unresolved_controls` nao vazio ou controle aplicavel `not-run/failed` bloqueia freeze e handoff.
