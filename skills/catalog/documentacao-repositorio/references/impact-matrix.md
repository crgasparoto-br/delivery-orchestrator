# Matriz de impacto documental

Usar esta matriz como guia de descoberta, não como lista automática de arquivos obrigatórios.

| Mudança | Fontes a verificar ou atualizar |
|---|---|
| Comportamento funcional | README funcional, ajuda ao usuário, regras de domínio, exemplos e critérios relacionados |
| API, webhook ou integração | OpenAPI/contrato, payloads, autenticação, erros, retries, versões e exemplos |
| Schema, migration ou dados | modelo de dados, migration guide, backfill, compatibilidade e rollback |
| Arquitetura ou fronteiras | ADR, visão de arquitetura, diagramas, dependências e responsabilidades |
| Setup, comando ou ferramenta | README, CONTRIBUTING, scripts oficiais, versões e troubleshooting |
| Ambiente ou configuração | `.env.example`, tabela de variáveis, defaults, escopo e segurança; nunca valores secretos |
| Operação, deploy ou rollout | runbook, observabilidade, alertas, rollback e procedimentos de recuperação |
| Interface ou design system | Storybook, exemplos, tokens, componentes, padrões de tela, acessibilidade e screenshots |
| Fluxo conversacional ou assíncrono | estados, transições, correlação, expiração, retry, idempotência e isolamento |
| Refatoração, renomeação ou remoção | caminhos, imports públicos, diagramas, exemplos, links e documentação obsoleta |
| Testes, lint ou CI | comandos documentados, gates obrigatórios, fixtures e instruções de contribuição |
| Convenção do projeto ou instrução para agentes | `AGENTS.md` mais específico, CONTRIBUTING, ADR, guia de arquitetura ou padrão canônico correspondente |
| Segurança ou permissões | modelo de autorização, papéis, limites, operação segura e resposta a falhas |

## Regras

- Preferir atualizar uma fonte canônica existente a criar documentação paralela.
- Verificar documentos próximos e documentos globais; uma mudança local pode invalidar ambos.
- Tratar exemplos e comandos como contratos verificáveis, não como texto decorativo.
- Registrar “sem impacto documental” apenas quando nenhuma linha aplicável da matriz exigir atualização.
- Não manter regra específica e estável de um repositório somente em skill, conversa, memória, issue ou descrição de PR.
