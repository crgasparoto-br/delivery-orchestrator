## Problema

No fluxo de adoção legada, quando uma auditoria independente falha por infraestrutura/control plane antigo e o controller rearma a auditoria com um novo `auditDispatchNonce`, o checkpoint `delivery-v2-legacy-adoption` pode continuar vinculado ao nonce/run de uma tentativa de infraestrutura anterior.

Ao concluir a auditoria substituta, `attachLegacyAdoptionAuditRun()` falha com:

```text
Error: legacy audit nonce mismatch
```

Reprodutor observado em SolverFin #619 / PR #676: a auditoria substituta `36280069275` terminou `success` e `approved`, mas o controller `36280056335` falhou ao anexar o resultado porque o checkpoint legado ainda apontava para um audit run mais antigo.

## Causa raiz

O estado operacional rearma `auditRunId/auditDispatchNonce`, mas o checkpoint durável de adoção legada não é realinhado para a identidade substituta. Em recuperações encadeadas, o checkpoint pode ficar mais de uma geração atrás.

## Requisitos

- realinhar o checkpoint legado antes de anexar o audit run substituto;
- permitir realinhamento somente quando o audit anterior do checkpoint pertence ao conjunto comprovado de workflows de auditoria falhos da mesma recuperação;
- exigir mesma identidade/candidate SHA e decisão ainda não consumida;
- não incrementar `legacyAdoptionAuditAttempts` durante recovery de infraestrutura;
- manter reentrada idempotente;
- continuar fail-closed para nonce/run não autorizados ou resultado já consumido;
- cobrir recuperação encadeada (mais de uma geração de audit run falho);
- manter `npm test`, `npm run validate` e `npm run verify:v2` verdes;
- não introduzir merge automático.

## Evidência

- controller run: `36280056335`
- audit run aprovado: `36280069275`
- erro: `legacy audit nonce mismatch` em `src/v2/legacy-adoption.mjs`.
