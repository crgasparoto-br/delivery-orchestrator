# Contrato de evidencias para o Entregar Issue v5

## Dossie entregue ao controlador

No modo `issue-loop-single-invocation`, o handoff deve conter caminhos e SHA-256 de:

- `execution-context.json`;
- `specification-snapshot.json`;
- `requirement-closure.json`;
- `risk-profile.json`;
- `documentation-impact.json`;
- `gate-report.json`;
- `applicability-ledger.json`;
- `cycle-history.json`;
- `remote-gate.json` quando existir PR.

O controlador e a auditoria acrescentarao `source-manifest`, `requirements-rederivation`, `coverage-matrix` e `controller-audit-report`.

## Aplicabilidade por risco

Classificar todos os arquivos alterados. Cada entrada de `changed_files` deve conter caminho e familias. Cada familia deve registrar:

- aplicabilidade;
- base objetiva;
- gates obrigatorios;
- subskills obrigatorias.

A familia `documentation` e sempre aplicavel. Nao marcar familia como nao aplicavel apenas porque o gate correspondente nao foi executado.

## Gates

Executar cada gate final por:

```bash
python <entregar-issue>/scripts/run_attested_gate.py \
  --name <gate> --head-sha <sha> --cwd <repo> \
  --out-dir <audit-dir>/gates/<gate> --command '<comando>'
```

Registrar no `gate-report.json` o hash da atestacao. Um arquivo de log sem atestacao nao satisfaz gate.

## Handoff

O `controller-handoff.json` deve transportar o manifesto de artefatos, inventario de requisitos, familias de risco, arquivos alterados, resultados de subskills e gates atestados. Nao reduzir esses dados a um booleano `complete=true`.
