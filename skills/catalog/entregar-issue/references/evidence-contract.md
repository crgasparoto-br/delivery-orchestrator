# Contrato de evidencias

## Versoes

- `evidence.json`: `schema_version: 9`, incluindo F34 quando `input_parser=true`;
- snapshot canônico: `specification-snapshot.json`, `schema_version: 1`;
- fechamento semantico: `requirement-closure.json`, `schema_version: 2`;
- pacote: metadata e manifesto `schema_version: 3`;
- grafo de runtime: `schema_version: 2`;
- plano da Passagem B: `schema_version: 3`;
- snapshot remoto: `schema_version: 4`;
- metricas visuais: `schema_version: 2`;
- estado da orquestracao: `schema_version: 3`;
- relatorio do gate: `schema_version: 4`;
- relatorio de auditoria externa: `schema_version: 2`;
- registro de auditores confiados: `schema_version: 1`;
- attestation de artefato remoto: `schema_version: 2`.

Usar os scripts inicializadores. Nao criar estruturas paralelas. O validador executa os JSON Schemas em `schemas/`; um arquivo apenas sintaticamente valido nao satisfaz o contrato.

## Topo de `evidence.json`

Campos obrigatorios:

- repositorio, caminho local, issue, base e SHA;
- pacote e hash do manifesto;
- referencia e hash do estado canonico;
- referencia e hash da deteccao de riscos;
- referencia e hash do fechamento semantico;
- overrides de risco;
- snapshot remoto e hash;
- perfil de risco;
- requisitos, implementacoes erradas, evidencias, cenarios e familias;
- Passagens A, B e Passagem C no artefato de fechamento semantico;
- achados e achados posteriores;
- validacoes finais;
- handoff.

## Fechamento semantico

`requirement-closure.json` deve ser gerado do snapshot canônico antes da primeira edição e registrado como artefato do SHA final. O gate exige:

- snapshot contendo issue, comentários, subissues, decisões, anexos e documentos canônicos aplicáveis;
- fonte binária acompanhada de extração textual rastreável;
- cobertura exata de todos os candidatos recompostos das fontes;
- obrigações classificadas como `covered`, `deferred` ou `not-applicable`, sem `out-of-scope` livre;
- `deferred` ligado a decisão canônica, issue de destino e manutenção da issue pai aberta;
- todo requisito ligado a pelo menos uma obrigação de origem;
- asserção observável para qualificadores e verbos semânticos como consumir, alimentar, impactar, gerar e derivar;
- inventário fechado para todos, cada, suportados, equivalentes, catálogos, siglas, métodos e planilhas;
- `scope_reduction_review` recomposto do diff final;
- paridade entre produtores e consumidores, `unmapped_values=[]` e ausência de fallback genérico em domínio fechado;
- Passagem C cobrindo exatamente requisitos, obrigações e todas as fontes sem usar a descrição da PR.

Evidencia de componente, timestamp ou existencia de map nao substitui o significado solicitado. Consultar `requirement-closure-gate.md`.

## Riscos

Toda deteccao de alta confianca deve permanecer habilitada. Para reduzir um campo, registrar:

```json
{
  "field": "visual",
  "detected_value": true,
  "declared_value": false,
  "rationale": "Justificativa objetiva com pelo menos 30 caracteres.",
  "evidence": ["arquivo-ou-saida"]
}
```

Fronteiras persistentes devem possuir nome unico, `adapter_paths`, durabilidade valida e `fallback_paths`. Dependencias externas e fontes de elegibilidade devem ser textos nao vazios. Operacoes transacionais devem possuir nome e `terminal_retry` booleano.

## Evidencia executada

Usar `output_path` nao vazio, comando e exit code. Controles adversariais tambem exigem:

```json
{
  "restored": true,
  "clean_head_after": "<sha>"
}
```

`dependency-outage` e `persistence-boundary` exigem `uses_real_adapter=true` e `environment=production`.

Nenhum destes vinculos pode ficar vazio:

- evidencias de implementacao incorreta plausivel;
- evidencias de cada cenario;
- evidencias da Passagem A;
- evidencias da Passagem B;
- evidencias de achados importados.

IDs de evidencias, cenarios, familias e implementacoes erradas devem ser unicos. Requisitos, cenarios, familias e evidencias devem apontar uns para os outros de forma coerente.

## Evidencia visual

O contrato visual associa superficies e controles a uma rota:

```json
{
  "routes": ["/cartoes"],
  "validator_paths": ["scripts/visual/cards.mjs"],
  "workflow_paths": [],
  "documentation_paths": ["docs/CARDS.md"],
  "controls_rationale": "",
  "controls": [
    {"route": "/cartoes", "name": "abrir-fatura", "selector": "button[data-open]", "control_role": "button"},
    {"route": "/cartoes", "name": "detalhes", "selector": "a[data-details]", "control_role": "link"}
  ],
  "dynamic_surfaces": [],
  "dynamic_surfaces_rationale": "Nao existem regioes dinamicas nesta rota.",
  "table_surfaces": [],
  "table_surfaces_rationale": "A rota nao contem tabela ou lista tabular.",
  "dialog_surfaces": [],
  "dialog_surfaces_rationale": "A rota nao abre dialogs."
}
```

Quando `visual=true`, rotas, validadores e documentacao nao podem ficar vazios. `workflow_paths` pode ficar vazio quando nao houver workflow existente aplicavel; nao criar workflow para preencher a lista. Arrays de superficies ou controles vazios exigem justificativa objetiva. Nas metricas, registrar `control_interactions[].keys_passed`. Botao exige Enter e Espaco; link exige Enter; checkbox, switch e radio exigem Espaco. Para papel composto nao predefinido, declarar `required_keys` no contrato.

## Requisito

```json
{
  "id": "REQ-001",
  "essential": true,
  "status": "verified",
  "evidence": ["EV-001", "EV-002"],
  "wrong_implementations": ["WI-001"],
  "scenario_cases": ["SC-001"]
}
```

Todo requisito essencial exige evidencia observavel e discriminante.

## Cenarios

```json
{
  "id": "SC-001",
  "family_id": "F10",
  "requirement_ids": ["REQ-001"],
  "description": "Concorrencia preserva efeito unico.",
  "source": "contract-derived",
  "novel": true,
  "result": "passed",
  "evidence": ["EV-002"]
}
```

F17, F18 e F19 devem incluir os campos adicionais definidos em `persistence-authorization-gates.md`. F20 a F24 devem incluir os inventarios e campos definidos em `critical-closure-gates.md`.

## Snapshot remoto

O snapshot precisa ter proveniencia dos payloads brutos paginados, timestamps, versao e hash do coletor, observacao antes/depois, base, head, merge preview, inventario de workflows, eventos dos runs, jobs, steps e artefatos. Fonte `fixture` e valida somente em testes.

O validador recompõe os campos derivados a partir desses payloads. Rotulos, endpoints, hashes ou dados ausentes/incompatíveis reprovam. Para workflow aplicavel de PR, apenas run com evento `pull_request` ou `pull_request_target`, jobs nao vazios e steps inspecionados pode satisfazer o portao.

Nenhum workflow aplicavel e um resultado valido somente quando:

- todos os workflows versionados foram inventariados;
- nenhum workflow de PR e aplicavel ao diff;
- `no_applicable_pr_workflows=true`;
- `no_applicable_evidence` aponta para arquivo nao vazio.

Artefato remoto e evidencia adicional por padrao. Exigir kind remoto somente quando `audit_packet_published=true`, caso em que `audit-manifest` deve existir. Evidencias visual, de persistencia, migration e documentacao permanecem locais e atestadas. Quando um artefato remoto for considerado, o ZIP deve conter `orquestrador-artifact.json` schema 2, checks estruturados e resultados internos nao vazios com hashes, comandos, exit codes e ligacao bidirecional. Nome, heuristica, texto autodeclarado ou `--artifact-kind` nao atribuem kind.

## Estado canonico

Cada artefato registrado deve conter caminho, hash, `head_sha`, `base_sha`, `merge_preview_sha` e ciclo de origem. O gate rejeita qualquer divergencia entre o estado, pacote, plano e snapshot remoto.

## Handoff

```json
{
  "independent_audit_required": true,
  "same_conversation_prohibited": true,
  "new_conversation_instruction": "ABRA UMA NOVA CONVERSA...",
  "audit_command": "@Auditar Issue 123 no repositorio owner/repo, PR 456, SHA abc...",
  "issue_completion": "complete",
  "remaining_issue_ids": [],
  "parent_issue_must_remain_open": false
}
```

O validador comprova coerencia e proveniencia dos arquivos coletados. Ele nao transforma uma verificacao interna em auditoria independente.

## Atestacao de gates

No modo controller v5, cada gate deve ser executado por `scripts/run_attested_gate.py`. Guardar stdout e stderr imutaveis e referenciar o SHA-256 de `attestation.json` no `gate-report`.

Nao aceitar logs manuais, arquivos com texto generico, exit code sem captura de processo ou evidencia produzida para outro SHA.

## F34

Quando `risk_profile.input_parser=true`, `evidence.json` deve preencher `input_parser_contract`, marcar F34 aplicavel e incluir cenarios que cubram toda a matriz modo/invariante, todos os campos consumidos, a matriz modo/campo/posicionamento, todos os estagios do valor bruto, casos de fronteira, controles `IP-*` e precedencia de erros. F34 exige evidencia `boundary-call` e evidencia discriminante.
