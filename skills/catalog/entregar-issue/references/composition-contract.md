# Contrato de composicao

## Propriedade

`entregar-issue` possui identidade, ciclo, plano, estado, work items, implementacao, higiene, gates, freeze, publicacao e decisao. Nenhuma Skill composta pode recriar esses artefatos ou encerrar a entrega.

## Skills externas permitidas

- `revisar-issue`: somente para lacuna material de readiness;
- `documentacao-repositorio`: somente para impacto documental amplo;
- `design-interface`: somente para recorte visual material;
- `fluxos-conversacionais`: somente para continuidade assincrona material;
- `auditar-issue`: verificacao somente leitura; independente apenas em contexto separado.
- `corrigir-ci`: owner temporario apenas da observacao/remediacao de CI quando invocado fora ou depois do ciclo principal. Se publicar novo head apos freeze/handoff, nao pode editar `.audit/entregar-issue/*` nem encaminhar para auditoria; deve devolver `return_control_to=entregar-issue`, `reason=post-ci-refreeze` e os SHAs anterior/atual.

## Envelope

Toda delegacao recebe contrato, requisitos, caminhos, identidade, `input_fingerprint`, write ownership e modo. Toda resposta inclui `contract_version`, `input_fingerprint`, `reused`, findings, validacoes, artefatos e caminhos alterados.

## Escrita

Definir um unico `write_owner` por caminho antes da chamada. Skills externas nao podem editar caminhos pertencentes ao nucleo e vice-versa. Quando a especialidade apenas verifica, usar modo somente leitura.

## Reuso

Para `reuse-candidate`, conferir fonte, hash, fingerprint, identidade, schema e artefato. Falha em qualquer verificacao converte a acao em `run`.

## Compatibilidade

Skills legadas nao participam do fluxo. O modo antigo e aceito apenas como alias de entrada; novos artefatos usam `delivery-single-invocation` e `return_control_to=entregar-issue`.


## Drift de identidade apos freeze

Qualquer Skill externa que publique um novo commit apos o freeze invalida o handoff por identidade material. A unica excecao e o `result-only-child` produzido pelo proprio `entregar-issue`, filho direto do material head e restrito a `certificate_commit_policy.allowed_paths`. O retorno ao controlador deve ocorrer antes de nova auditoria independente.

Para `corrigir-ci`, o envelope minimo de retorno e:

```json
{
  "return_control_to": "entregar-issue",
  "reason": "post-ci-refreeze",
  "previous_frozen_sha": "<sha anterior>",
  "current_head_sha": "<sha atual>",
  "ci_state": "green"
}
```

`entregar-issue` compara o delta, invalida somente gates e evidencias dependentes, revalida o novo material head, refaz o freeze, gera novo `handoff-ready.json` e publica novo result-only child. A mudanca ser apenas formatacao ou arquivo colateral fora da allowlist de resultados nao permite reutilizar certificado do material head anterior.
