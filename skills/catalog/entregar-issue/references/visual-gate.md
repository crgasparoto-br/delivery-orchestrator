# Gate visual e de acessibilidade

## Contrato por rota

Quando `visual=true`, o contrato deve listar rotas, validadores permanentes e documentacao canonica. `workflow_paths` deve conter somente workflows existentes aplicaveis e pode ficar vazio; nunca criar workflow para satisfazer o gate visual.

Cada superficie deve declarar `route`, nome e selector. Arrays vazios de controles, superficies dinamicas, tabelas ou dialogs exigem justificativa objetiva.

Controles interativos devem declarar `control_role` ou `required_keys`:

- `button`: Enter e Espaco;
- `link`: Enter;
- `checkbox`, `switch` e `radio`: Espaco;
- `tab`, `option`, `menuitem`, `treeitem` e `combobox`: teclas exigidas pelo papel e pelo padrao adotado;
- papel nao predefinido: declarar explicitamente `required_keys`.

Nao exigir a mesma combinacao de teclas para todos os controles.

## Evidencia minima

Por rota:

- pelo menos tres viewports;
- conteudo extremo ou zoom;
- fluxo somente por teclado;
- arvore de acessibilidade capturada;
- controles testados conforme o papel;
- superficies dinamicas com inventario de escritores e mutacoes;
- tabelas/listas com roles e `aria-rowcount` coerente;
- dialogs com label, descricao quando necessaria, foco inicial, Escape e restauracao de foco.

As metricas devem satisfazer `schemas/visual-metrics.schema.json` e o contrato da rota.

## Superficies dinamicas

Aplicar somente na rota declarada. Quando `single_writer_required=true`, exigir exatamente um escritor. Comparar anuncios observados ao maximo esperado por acao.

## Tabelas

- `native-dom`: omitir `aria-rowcount`;
- `explicit-total`: valor igual ao total semantico declarado, incluindo cabecalhos quando o contrato assim definir.

## Validadores permanentes

Todo validador listado deve existir e aparecer literalmente na documentacao canonica. Quando `workflow_paths` listar um workflow existente, o validador deve estar ligado a ele. Quando a lista estiver vazia, executar o validador localmente com atestacao; nao criar workflow.
