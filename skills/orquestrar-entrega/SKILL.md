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
2. Iniciar exatamente uma execucao do workflow com repositorio, issue e limite de ciclos:
   - usar `workflow_dispatch` quando o conector expuser uma acao de dispatch;
   - se `workflow_dispatch` nao estiver disponivel, mas houver escrita de issues no repositorio privado de controle, criar exatamente uma issue de controle com titulo `delivery-request: owner/repo#N` e corpo JSON puro contendo somente `target_repository`, `issue_number` e `max_cycles`;
   - nunca criar a issue de controle no repositorio alvo; cria-la no repositorio `delivery-orchestrator` que contem o workflow;
   - depois de criar a issue de controle, localizar o run `Independent delivery loop` disparado pelo evento `issues`, usando o titulo da issue/run e o horario de criacao para correlacao;
   - nao criar uma segunda solicitacao se um run correlacionado ja existir.
3. Tratar o workflow como dono do loop. Nao executar `entregar-issue` ou `auditar-issue` manualmente em paralelo enquanto o run estiver ativo.
4. Interpretar o estado final:
   - `COMPLETE`: informar a entrega e a auditoria independente aprovadas; nunca fazer merge automaticamente.
   - `BLOCKED_REQUIREMENT`: apresentar a decisao material que bloqueou a implementacao.
   - `BLOCKED_EXTERNAL`: apresentar a dependencia externa/runtime que impediu conclusao.
   - `NO_PROGRESS`: apresentar fingerprint/causa recorrente e exigir intervencao de causa raiz, nao nova repeticao cega.
   - `FAILED`: apresentar a falha do controlador/contrato. Se a falha ocorrer antes de existir estado persistido, incluir a validacao rejeitada do request de controle.
5. Reutilizar artefatos do run para diagnostico; nao substituir o estado persistido por narrativa de conversa.
6. Se o fallback por issue de controle tiver sido usado e um estado terminal tiver sido capturado, a issue de controle pode ser fechada como concluida. Nunca fechar ou fazer merge da issue/PR alvo automaticamente.

### Contrato da issue de controle

Usar corpo JSON sem Markdown ou campos adicionais:

```json
{
  "target_repository": "owner/repo",
  "issue_number": 123,
  "max_cycles": 6
}
```

O workflow valida ator, repositorio permitido, formato da issue e limite de ciclos antes de iniciar o loop. Nao tentar contornar uma rejeicao dessas validacoes alterando o payload para incluir comandos, refs, tokens ou parametros nao suportados.

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
