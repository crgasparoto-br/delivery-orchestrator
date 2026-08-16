---
name: orquestrar-entrega
description: Orquestrar uma entrega de issue de software em loop implementacao, auditoria independente e remediacao ate aprovacao, usando o projeto delivery-orchestrator como control plane. Usar quando o usuario pedir para entregar uma issue por completo sem repetir prompts manuais, continuar implementando e auditando ate concluir, executar entregar-issue e auditar-issue com independencia real, ou operar/diagnosticar o delivery-orchestrator. Nao usar para uma auditoria isolada nem para uma implementacao que explicitamente nao exige auditoria independente.
---

# Orquestrar Entrega

Usar o `delivery-orchestrator` como unico controlador do ciclo. Nao simular independencia trocando de Skill no mesmo contexto.

## Entrada

Resolver:

- repositorio `owner/repo`;
- numero da issue;
- limite de ciclos, usando 6 quando o usuario nao definir outro limite;
- repositorio/instalacao do `delivery-orchestrator` configurado para o workspace.

Nao pedir novamente informacao ja presente na conversa, issue ou repositorio.

## Fluxo

1. Verificar se o control plane `delivery-orchestrator` esta instalado e se o workflow `Independent delivery loop` existe.
2. Iniciar uma unica execucao do workflow com repositorio, issue e limite de ciclos.
3. Tratar o workflow como dono do loop. Nao executar `entregar-issue` ou `auditar-issue` manualmente em paralelo enquanto o run estiver ativo.
4. Interpretar o estado final:
   - `COMPLETE`: informar a entrega e a auditoria independente aprovadas; nunca fazer merge automaticamente.
   - `BLOCKED_REQUIREMENT`: apresentar a decisao material que bloqueou a implementacao.
   - `BLOCKED_EXTERNAL`: apresentar a dependencia externa/runtime que impediu conclusao.
   - `NO_PROGRESS`: apresentar fingerprint/causa recorrente e exigir intervencao de causa raiz, nao nova repeticao cega.
   - `FAILED`: apresentar a falha do controlador/contrato.
5. Reutilizar artefatos do run para diagnostico; nao substituir o estado persistido por narrativa de conversa.

## Independencia obrigatoria

Exigir simultaneamente:

- thread/contexto novo por papel e por ciclo;
- `CODEX_HOME` separado para implementador e auditor;
- implementador com credencial GitHub de escrita;
- auditor com credencial GitHub somente leitura e clone do candidato verificado como Git-clean no mesmo SHA apos a auditoria;
- auditor em clone novo no `handoff_head_sha` certificado;
- chave privada do auditor nunca acessivel ao implementador;
- `audit_context_id != implementation_context_id`;
- aprovacao final somente quando `auditar-issue` devolver validade independente e release gate satisfeito.

Trocar de skill na conversa atual nao satisfaz independencia.

## Guardas de loop

Parar sem consumir novas auditorias quando:

- a mesma identidade rejeitada reaparecer com o mesmo fingerprint de findings sem progresso;
- o numero maximo de ciclos for atingido;
- houver limitacao externa inconclusiva;
- o implementador nao produzir handoff certificado;
- o auditor nao puder manter o remoto somente leitura ou alterar o clone do candidato;
- houver violacao de separacao de contexto/credencial.

## Resultado

Ser conciso. Informar estado terminal, repositorio/issue, numero de ciclos, material/handoff SHA quando disponiveis e proxima acao somente se o estado nao for `COMPLETE`.
