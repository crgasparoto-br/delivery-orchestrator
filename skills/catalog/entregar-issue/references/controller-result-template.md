# Modelo de resultado

## Checkpoint

```text
Ciclo: <n>/10
Estado: <estado>
Issue: <owner/repo#numero>
SHA congelado: <sha>
Auditoria: <nivel efetivo e parecer>
Escapes independentes: <quantidade e estado>
Achados bloqueantes abertos: <quantidade>
Recomendacoes opcionais: <quantidade>
Regressoes abertas: <quantidade>
Skills alteradas: <nomes ou nenhuma>
Decisao: <decisao>
Proxima etapa automatica: <acao>
```

## Resultado final

```text
# Resultado do Entregar Issue

Status: <aprovado-operacionalmente-sem-ressalvas | aprovado-internamente-pendente-auditoria-independente | limite-atingido-com-pendencias | bloqueado-por-impedimento-real>
Issue: <owner/repo#numero>
Ciclos executados: <n>/10
PR/branch: <identidade>
SHA/base/merge preview: <identidade final>
Nivel efetivo: <controller-adversarial | isolated-within-run | independent>
Portao de release: <liberado somente para independent | pendente>

## Implementacao
- Requisitos atendidos:
- Arquivos e camadas alterados:
- Gates e evidencias:
- Baseline e regressao:

## Auditoria final
- Parecer:
- Achados bloqueantes:
- Recomendacoes opcionais:
- Limitacoes materiais:
- Pacote neutro sem conclusoes do implementador: <sim/nao>

## Audit escapes
- Escape:
- Causa raiz:
- Skill corrigida:
- Controle adversarial reutilizavel:
- Evidencia de execucao:

## Pendencias
- <auditoria independente obrigatoria quando o nivel nao for independent>
```

Nunca chamar aprovacao interna de conclusao operacional. Nunca autorizar merge, fechamento ou release sem validade `independent`.

## Evidencias v5 a declarar

- hash do `controller-audit-report` schema 3;
- quantidade de fontes no `source-manifest`;
- divergencias entre snapshot e rederivacao;
- familias de risco e controles adversariais aplicaveis;
- subskills obrigatorias executadas;
- quantidade de controles negativos e regressivos;
- gates atestados e hashes;
- findings fechados com SHA corretivo;
- audit escapes, melhorias de Skills e controles reutilizaveis.
