# Certificado de handoff independente

## Objetivo

Impedir que uma auditoria independente seja consumida para descobrir ausencia de artefatos de readiness que a entrega ja consegue verificar de forma deterministica, sem criar autorreferencia entre o certificado versionado e o SHA do commit que o contem.

## Regra

Nenhum handoff para auditoria independente existe sem `.audit/entregar-issue/handoff-ready.json` valido para o candidato material.

O certificado deve ser produzido por `scripts/build_handoff_certificate.py` somente depois de:

- cobertura integral da especificacao validada contra as fontes canonicas;
- requirement closure valida;
- requirement attack matrix completa;
- risk saturation completa;
- inherited controls completos no SHA material final;
- audit escape closure completa quando houver rejeicao independente anterior;
- learning closure completa quando houver rejeicao independente anterior;
- identidade material final congelada.

## Identidade material e commit de resultados

O certificado schema v2 usa `identity.material_head_sha` como identidade do codigo/testes/docs auditados. `identity.head_sha` permanece apenas como alias de compatibilidade para esse mesmo SHA material.

Quando o certificado for persistido no repositorio, publicar o pacote em um **filho direto somente de resultados** do material head. O certificado declara:

```json
{
  "schema_version": 2,
  "identity": {
    "material_head_sha": "<M>",
    "head_sha": "<M>",
    "base_sha": "<B>",
    "material_merge_preview_sha": "<MP-M>"
  },
  "certificate_commit_policy": {
    "mode": "result-only-child",
    "allowed_paths": [".audit/entregar-issue/..."]
  }
}
```

O SHA do filho de handoff `H` nao aparece dentro do certificado. O auditor aceita `H` somente se comprovar que:

- `parent(H) == M`;
- o diff `M..H` contem apenas `allowed_paths`;
- nenhum arquivo material do produto mudou;
- os artefatos certificados continuam hasheados e vinculados a `M`.

Isso evita a impossibilidade de fazer um arquivo versionado certificar o proprio SHA do commit que o contem.

## Proveniencia

O certificado deve registrar hashes dos artefatos, identidade material do candidato, versao contratual, hash da Skill produtora e hashes dos validadores usados. Alteracao de qualquer input material invalida o certificado.

## Regra de consumo

`auditar-issue` deve validar o certificado antes de iniciar descoberta ampla ou suites caras. Certificado ausente, stale ou inconsistente implica `delivery-not-ready`, nao uma nova auditoria ampla.

Em `result-only-child`, o auditor deve validar parent e changed paths do head publicado antes de usar o material head certificado para saturation, inherited controls e reauditoria.

## Runtime connector-only

Ausencia de checkout local nao autoriza omitir o certificado. Seguir `references/connector-only-handoff.md`: materializar os bytes necessarios em workspace efemero, executar os validadores da Skill, gerar o certificado e publicar um unico commit de resultados. Se isso for impossivel por limite real do connector, bloquear o handoff internamente e nao consumir auditoria independente.

## Drift pos-freeze e remediacao de CI

Mudanca **material** posterior ao freeze torna o certificado anterior historico/stale, inclusive remediacao por `corrigir-ci`, formatacao, documentacao, teste ou mudanca colateral fora da allowlist de resultados.

Quando `corrigir-ci` alterar o head material depois de um handoff:

1. `corrigir-ci` nao pode editar ou regenerar `.audit/entregar-issue/*`;
2. deve retornar controle com `reason=post-ci-refreeze`, SHA material congelado anterior e head atual;
3. `entregar-issue` deve comparar o delta e invalidar somente evidencias dependentes, mas sempre refazer a identidade material congelada;
4. executar novamente validadores afetados no novo material head;
5. gerar e validar novo `handoff-ready.json` para o novo material head;
6. publicar novo result-only child;
7. somente entao permitir novo consumo por `auditar-issue`.

Um commit que seja comprovadamente o result-only child autorizado nao e drift material e nao exige refazer os gates de produto vinculados ao parent material.


## Gate terminal do produtor

Gerar o certificado localmente nao basta. Antes de retornar ao usuario, `entregar-issue` deve comprovar no remoto que o head atual e o result-only child publicado e executar `scripts/validate_terminal_handoff.py`. O gate falha quando o head publicado ainda e o material head, quando o filho nao tem o material head como parent, quando `handoff-ready.json` nao faz parte do commit de resultados ou quando existe path fora da allowlist. CI pendente e ortogonal a esse gate e nunca autoriza omitir o certificado.
