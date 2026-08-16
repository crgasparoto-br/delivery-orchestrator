# Snapshot canônico de especificação

## Objetivo

Impedir que a implementação defina a própria lista de requisitos. Congelar antes da primeira edição todas as fontes que podem criar, restringir, ampliar ou retirar obrigações.

## Fontes obrigatórias

Incluir, quando existirem:

- corpo vigente da issue;
- comentários com decisões, esclarecimentos ou critérios adicionais;
- subissues e dependências que delimitam a entrega;
- decisões explícitas do usuário;
- anexos e planilhas citados;
- documentos canônicos do repositório que atribuem escopo à issue.

Arquivos binários não podem ser a única representação de uma obrigação. Preservar o binário no snapshot e gerar uma extração textual rastreável com `spreadsheet-extract` ou `attachment-extract`. A extração deve identificar arquivo, aba, intervalo ou seção de origem sem reinterpretar o conteúdo.

## Construção

Exportar cada fonte para UTF-8 sem resumir e executar:

```bash
python <skill>/scripts/build_specification_snapshot.py \
  --repository <owner/repo> --issue <numero> \
  --primary-source-id SRC-ISSUE \
  --source issue-body:SRC-ISSUE:<issue.md> \
  --source issue-comment:SRC-COMMENT-1:<comment-1.md> \
  --source spreadsheet-extract:SRC-SHEET-1:<sheet-extract.md> \
  --binary-source attachment:SRC-XLSX:<workbook.xlsx>:SRC-SHEET-1 \
  --out <audit-dir>/specification-snapshot.json
```

Cada fonte recebe hash, locator, tipo e arquivo congelado. Alteração de qualquer fonte invalida o inventário, o pacote, as passagens e o handoff.

## Decisões de escopo

Uma obrigação só pode ser `deferred` ou `not-applicable` quando o snapshot contém uma decisão canônica anterior ou contemporânea à implementação. A decisão deve vir do corpo da issue, comentário, subissue ou decisão explícita do usuário.

Para `deferred`, exigir:

- issue de destino;
- fonte e hash da decisão;
- locator verificável;
- confirmação de que a issue pai permanecerá aberta;
- handoff marcado como parcial.

Descrição da PR, documentação criada pela própria implementação, comentário do implementador ou justificativa livre não retiram requisito do escopo.

## Redução silenciosa

Recomputar no diff final expressões de postergação ou redução, como `fora do escopo`, `próxima evolução`, `não implementa`, `interface pendente`, `apenas backend` e `seed mínimo`. Cada ocorrência deve ser ligada a decisão canônica ou explicada como texto que não reduz obrigação. O conjunto registrado deve coincidir exatamente com o diff congelado.
