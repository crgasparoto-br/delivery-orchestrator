# Relatorio externo assinado para o Entregar Issue

## Quando produzir

Produzir `external-audit.json` importavel somente quando:

- esta execucao ocorreu em conversa, agente, sessao ou ferramenta realmente separada da implementacao;
- existe identificador de contexto fornecido pela plataforma ou ferramenta, nao inventado pelo auditor;
- head, base e merge preview foram confirmados antes e depois;
- a chave privada Ed25519 pertence a um auditor previamente confiado e nunca esteve acessivel ao contexto de implementacao;
- o registro publico de auditores foi estabelecido antes da PR ou fica fora do repositorio.

Se qualquer condicao faltar, emitir somente pre-auditoria ou relatorio independente nao importavel. Nunca assinar uma autodeclaracao de independencia.

## Preparacao da chave

Executar uma unica vez em ambiente controlado pelo auditor:

```bash
python <skill>/scripts/generate_auditor_keypair.py \
  --private-out <local-seguro>/auditor-private.pem \
  --public-out <local-publico>/auditor-public.pem \
  --password-env AUDITOR_KEY_PASSWORD
```

Entregar somente a chave publica ao responsavel pelo Entregar Issue. Nunca compartilhar, anexar, versionar ou incluir a chave privada no ZIP da skill.

## Inicializar o relatorio

Usar os valores exatos do handoff:

```bash
python <skill>/scripts/init_external_audit_report.py \
  --repository <owner/repo> --issue <numero> --base-ref <base> \
  --head-sha <head> --base-sha <base-sha> \
  --merge-preview-sha <merge-preview> \
  --orchestration-cycle <ciclo> \
  --implementation-context-id <id-do-handoff> \
  --audit-context-id <id-real-desta-execucao> \
  --context-proof-kind <chatgpt-conversation-id|agent-run-id|tool-attestation> \
  --context-proof-value <id-real-desta-execucao> \
  --context-proof-issuer <plataforma-ou-ferramenta> \
  --origin <procedencia-verificavel> \
  --out <external-audit.json>
```

O arquivo inicial e um rascunho invalido ate ser completado e assinado.

## Completar

Preencher:

- `head_sha_after`, `base_sha_after` e `merge_preview_sha_after`;
- `verdict`;
- evidencias com ID, claim, source e `observed_at`;
- achados estruturados;
- limitacoes.

`approved` exige listas vazias de achados e limitacoes. `approved-with-reservations` nao fecha o ciclo no Entregar Issue.

## Metadados de aprendizado por achado

Cada finding material deve incluir `escape_category`, `required_gate`, `literal_case` e `sibling_cases` com pelo menos dois casos.

Mapeamento: `execution-state-gap`→F28, `control-propagation-gap`→F29, `capability-operation-drift`/`adapter-support-drift`→F30, `silent-translation-loss`→F31, `legacy-variant-gap`→F32 e `documentation-claim-drift`→F33. Usar `other` para achados fora dessas famílias.

## Assinar e validar

```bash
python <skill>/scripts/sign_external_audit_report.py \
  <external-audit.json> \
  --private-key <local-seguro>/auditor-private.pem \
  --key-id <id-da-chave> \
  --password-env AUDITOR_KEY_PASSWORD

python <skill>/scripts/validate_external_audit_report.py \
  <external-audit.json> \
  --trusted-auditors <trusted-auditors.json>
```

A assinatura cobre a serializacao canonica de todo o relatorio, exceto o proprio campo `signature`. Qualquer edicao posterior invalida a assinatura.

## Entrega

Entregar:

- relatorio humano detalhado;
- `external-audit.json` assinado;
- hash SHA-256 do arquivo;
- identificador da chave publica;
- indicacao de que a chave privada permaneceu fora do contexto de implementacao.

O bloco textual `AUDIT_HANDOFF` continua util para leitura humana, mas nao substitui o JSON assinado.

## Pacote neutro obrigatorio

O relatorio externo schema 3 deve conter `neutral_packet` com `implementation_conclusions_included=false` e `implementation_narrative_included=false`. O auditor deve rejeitar material contaminado e solicitar um pacote composto apenas por fontes canonicas, identidade, diff, codigo, testes e evidencias brutas.

## Escape de aprovacao interna

Quando `prior_internal_approval.head_sha` for igual ao SHA auditado e houver finding material, marcar `audit_escape=true` em cada finding escapado e preencher `reusable_control_requirement`. O relatorio rejeitado deve ser importado pelo Entregar Issue como causa raiz e melhoria de Skill obrigatorias na primeira ocorrencia.
