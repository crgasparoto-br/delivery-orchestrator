# Padrão de especificação de issue

## Índice

1. Modelo adaptável
2. Critérios de aceite
3. Considerações de testes
4. Checklist de qualidade
5. Avaliação de prontidão

## 1. Modelo adaptável

Usar apenas as seções relevantes para a issue.

```markdown
## Objetivo
[Resultado que deve ser alcançado e valor esperado.]

## Contexto
[Comportamento atual, problema observado e informações necessárias para compreender a mudança.]

## Escopo
- [Entrega incluída.]
- [Entrega incluída.]

## Fora de escopo
- [Comportamento explicitamente não incluído.]

## Requisitos funcionais
1. [Comportamento observável e verificável.]
2. [Regra de negócio ou interação necessária.]

## Requisitos não funcionais
- [Compatibilidade, desempenho, segurança, acessibilidade ou restrição relevante.]

## Premissas
- [Interpretação usada por estar sustentada pelo contexto, mas não explicitada originalmente.]

## Cenários e casos extremos
- **Cenário:** [condição].
  - **Resultado esperado:** [comportamento].

## Tratamento de erros e fallback
- [Falha possível e resposta esperada.]

## Critérios de aceite
- [ ] [Condição específica e verificável.]
- [ ] [Condição específica e verificável.]

## Considerações de testes
- [Teste unitário, integração, contrato, interface ou regressão necessário.]

## Impacto na documentação
- [Fonte canônica dentro do repositório a atualizar, motivo e validação esperada, ou justificativa objetiva de ausência de impacto.]
- [Nova convenção estável que deve ser registrada em AGENTS.md, CONTRIBUTING, ADR, contrato ou guia apropriado, quando aplicável.]

## Riscos e dependências
- [Dependência, migração, impacto ou risco conhecido.]

## Perguntas em aberto
- [Decisão que não pode ser inferida com segurança.]
```

## 2. Critérios de aceite

Escrever critérios que possam ser confirmados por teste, inspeção ou comportamento observável.

Preferir:

- "Ao salvar um lançamento recorrente alterado, o sistema deve solicitar se a mudança vale apenas para a ocorrência atual ou para toda a série."

Evitar:

- "A edição deve funcionar corretamente."

Cada critério deve definir, quando aplicável:

- condição inicial;
- ação;
- resultado esperado;
- persistência ou efeitos colaterais;
- comportamento em erro.

Não transformar detalhes internos de implementação em critérios de aceite, salvo quando forem requisitos explícitos.

## 3. Considerações de testes

Cobrir somente categorias relevantes:

- fluxo principal;
- permissões e perfis;
- dados ausentes, inválidos ou incompletos;
- limites e casos extremos;
- erros de integração;
- persistência e idempotência;
- para fluxos em várias etapas, os cenários definidos por `fluxos-conversacionais`;
- compatibilidade com comportamento existente;
- regressões em telas, relatórios ou contratos relacionados;
- acessibilidade e responsividade quando fizerem parte da mudança.

## 4. Checklist de qualidade

Antes de finalizar, confirmar:

- [ ] O objetivo é explícito e descreve o resultado esperado.
- [ ] O escopo é delimitado.
- [ ] O fora de escopo está definido quando evita interpretação indevida.
- [ ] Os requisitos são concretos e não duplicados.
- [ ] Os fluxos principais estão cobertos.
- [ ] Casos extremos e falhas relevantes estão descritos.
- [ ] Quando houver continuidade entre etapas, `fluxos-conversacionais` foi aplicada e o contrato resultante está refletido nos requisitos e critérios.
- [ ] Fallbacks estão definidos quando necessários.
- [ ] Os critérios de aceite são verificáveis.
- [ ] As expectativas de teste são proporcionais ao risco.
- [ ] O impacto documental foi mapeado no registro compartilhado, aponta a fonte canônica no repositório e possui critério verificável quando aplicável.
- [ ] A issue não usa comentário, descrição de PR ou memória externa como substituto da documentação versionada necessária.
- [ ] Premissas, dependências e perguntas em aberto estão separadas dos requisitos.
- [ ] Não foram inventados fatos sobre o repositório ou o negócio.
- [ ] A revisão preserva a intenção original.
- [ ] Dois implementadores provavelmente tomariam as mesmas decisões centrais.

## 5. Avaliação de prontidão

Classificar a issue de forma objetiva:

### Pronta

Objetivo, escopo, requisitos e critérios de aceite permitem implementação sem decisões relevantes adicionais.

### Pronta com premissas

A implementação pode começar, mas depende de premissas explicitadas e de baixo risco.

### Parcialmente pronta

A maior parte está definida, porém restam decisões que podem alterar comportamento, arquitetura ou aceitação.

### Bloqueada

Faltam informações essenciais e não é seguro escolher uma interpretação sem decisão do responsável pelo produto.

## Privacidade, autorização e fronteira pública

Quando a issue disser que não deve revelar existência, identidade, elegibilidade, vínculo ou dados pessoais, exigir critérios observáveis também no backend:

- payload público mínimo e explicitamente permitido;
- erro público indistinguível entre casos que não podem ser revelados;
- ausência de PII e detalhes internos antes da autorização;
- teste direto na procedure ou endpoint público, não apenas na interface;
- isolamento por usuário e tenant;
- entitlement ou recurso exato exigido pela rota de destino;
- distinção entre negação confirmada e falha temporária, com retry quando recuperável.

Uma frase como “mostrar mensagem amigável” não é suficiente para provar segurança do contrato.

