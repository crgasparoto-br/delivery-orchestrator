# Contrato de auditoria externa confiavel

## Objetivo

Evitar que a implementacao se autoaprove por meio de um arquivo preenchido manualmente. O Entregar Issue aceita `approved` somente quando o relatorio estruturado foi assinado com uma chave Ed25519 previamente confiada e mantida fora do alcance do contexto de implementacao.

## Preparacao unica da confianca

O auditor independente gera a chave em ambiente separado com a skill `auditar-issue`:

```bash
python <auditar-issue>/scripts/generate_auditor_keypair.py \
  --private-out <local-seguro>/auditor-private.pem \
  --public-out <local-publico>/auditor-public.pem \
  --password-env AUDITOR_KEY_PASSWORD
```

Nunca incluir a chave privada no repositorio, ZIP da skill, PR, pacote de auditoria ou conversa de implementacao.

Criar o registro de confianca somente com a chave publica:

```bash
python <skill>/scripts/init_trusted_auditors.py \
  --key-id <id-estavel> --name <auditor> \
  --public-key <auditor-public.pem> \
  --repository <owner/repo> \
  --out <trusted-auditors.json>
```

Se o registro estiver dentro do repositorio, ele deve existir inalterado no `base_sha`; uma PR nao pode confiar numa chave introduzida por ela mesma. Preferir registro externo controlado pelo proprietario do processo.

## Relatorio

O relatorio usa `schemas/external-audit.schema.json`, `schema_version: 2`, e deve conter:

- `report_id` unico;
- repositorio, issue, base, head, base SHA e merge preview antes/depois;
- ciclo e `implementation_context_id` do handoff;
- `audit_context_id` diferente e prova de origem;
- evidencias observadas;
- achados e limitacoes;
- veredito;
- assinatura Ed25519 sobre a serializacao canonica do documento sem o campo `signature`.

O auditor cria, completa, assina e valida o arquivo com os scripts da skill `auditar-issue`.

## Politica fail-closed

Rejeitar quando:

- a chave nao estiver no registro ou nao estiver autorizada para o repositorio;
- o registro tiver sido alterado pelo diff da implementacao;
- a assinatura ou hash canonico divergir;
- report ID ou contexto ja tiver sido importado;
- o contexto de auditoria coincidir com o de implementacao;
- qualquer identidade antes/depois mudar;
- o relatorio for anterior ao handoff do ciclo atual;
- `approved` contiver achados, limitacoes ou encontrar achados abertos no estado;
- os artefatos atuais do gate nao pertencerem ao mesmo ciclo.

Sem assinatura confiavel, manter `pronto para auditoria independente`; nunca promover por conveniencia.

## Revalidacao de vigencia

A importacao nao encerra a verificacao. Executar imediatamente e antes de apresentar a aprovacao:

```bash
python <skill>/scripts/validate_approved_state.py <orchestration-state.json>
```

O comando deve realizar nova verificacao local e remota e retornar zero. Rejeitar quando relatorio, registro, artefato, head, base, merge preview, run, job, step, artifact attestation ou handoff tiver mudado. O bypass remoto e exclusivo de testes automatizados com `ORCHESTRATOR_TEST_MODE=1`; nao usar em entrega real.
