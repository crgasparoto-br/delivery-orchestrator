# Contrato de auditoria

## Niveis de garantia

- `independent`: contexto externo realmente separado daquele que implementou, corrigiu ou coordenou o SHA.
- `isolated-within-run`: contexto limpo criado na mesma invocacao, com identidade de contexto diferente, pacote neutro, somente leitura e rederivacao demonstrada.
- `controller-adversarial`: passagem somente leitura no mesmo controlador, com fases separadas e contrato rederivado.
- `absent`: auditoria ainda nao executada.

Usar `controller-adversarial` como padrao. Somente `independent` pode ser descrita como auditoria independente.

## Reclassificacao obrigatoria

Reclassificar `isolated-within-run` para `controller-adversarial` quando faltar qualquer item:

- `audit_context_id` diferente de `implementation_context_id`;
- auditoria iniciada depois do freeze;
- `read_only=true`;
- `requirements_rederived=true`;
- hash de pacote neutro;
- ausencia de modificacao durante auditoria.

Nao promover automaticamente `controller-adversarial` para nivel superior.

## Pareceres

- `Aprovado`
- `Aprovado com ressalvas`
- `Reprovado`
- `not-run`

Apenas `Aprovado` permite aprovacao operacional. Recomendacoes opcionais nao transformam um parecer em `Aprovado com ressalvas`.

## Identidade discriminante

Registrar e comparar em `frozen_identity`, `audit.identity` e `current_identity`:

- repositorio e issue;
- PR e branch;
- head SHA;
- base SHA;
- merge preview;
- SHA-256 do snapshot da issue;
- SHA-256 do diff auditado;
- SHA-256 das Skills governantes.

Nao aceitar booleano `current=true` como prova de identidade.

## Evidencias de gate

Cada gate obrigatorio deve registrar:

- nome e comando;
- status;
- exit code;
- horario de execucao;
- caminho da evidencia;
- SHA-256 da evidencia.

O avaliador deve confirmar existencia e hash do arquivo. Gate sem evidencia valida e gate nao aprovado.

## Achados e recomendacoes

Todo achado deve ter `id`, `fingerprint`, severidade, requisito relacionado, impacto, evidencia, causa, status e `disposition`:

- `blocking`: impede aprovacao;
- `recommendation`: melhoria opcional fora da obrigacao atual.

Achado baixo ainda pode ser `blocking` quando representar defeito real. Recomendacao nao pode ser usada para ampliar silenciosamente o contrato.

## Mudancas posteriores

Mudanca em codigo, documentacao, configuracao, dependencia, Skill, head, base, merge preview, snapshot ou diff invalida o parecer. Refazer freeze, evidencias e auditoria.

## Assinatura

Quando houver chave Ed25519 previamente confiada e auditoria `independent`, exigir assinatura valida se o contrato externo a marcar como obrigatoria. Nao criar chave durante a auditoria para simular confianca previa.

## Requisitos adicionais do estado v5

Para qualquer validade diferente de `absent`, exigir inicio e termino, somente leitura, rederivacao, pacote neutro hasheado, identidade coincidente e ausencia de modificacoes. Essas condicoes tambem se aplicam a `controller-adversarial`; nao sao exclusivas dos niveis isolado e independente.

O parecer deve vir de `controller-audit-report.json` schema 3, validado e registrado no manifesto de artefatos. `audit.verdict` e apenas uma copia consistente desse relatorio.

A auditoria deve produzir `source-manifest`, `requirements-rederivation` e `coverage-matrix`. Requisito implementado sem evidencia positiva, controle negativo e regressao nao pode ser aprovado.

## Portao final independente

- `controller-adversarial` e `isolated-within-run` podem concluir somente `internally-approved`.
- Apenas `independent` pode produzir aprovacao operacional final, liberar merge, fechamento ou release.
- Parecer interno `Aprovado` descreve somente ausencia de achados na passagem interna; nao equivale a validacao independente.

## Audit escape

Registrar `audit_escape` quando uma auditoria `independent` encontrar finding bloqueante no mesmo SHA anteriormente aprovado internamente. O primeiro escape obriga, antes de nova aprovacao:

1. causa raiz formal;
2. melhoria de ao menos uma Skill governante;
3. teste que falharia antes da melhoria;
4. controle adversarial reutilizavel ativo;
5. registro append-only em `audit-escape-ledger.json` e `adversarial-controls.json`.

O pacote independente deve declarar que nao inclui conclusoes nem narrativa da implementacao.
