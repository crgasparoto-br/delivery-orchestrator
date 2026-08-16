# Perfis de execucao

## Light

Usar para documentacao ou assets isolados, sem persistencia, autorizacao, privacidade, multi-tenant, migration, runtime transitivo, parser, provider ou continuidade. Exigir contrato, verificacao documental/visual aplicavel, working tree, identidade, CI observavel e handoff. Nao executar higienizacao ou suite runtime sem impacto comportamental.

## Standard

Usar para funcionalidade comum, configuracao comportamental, testes ou mudanca em uma ou mais camadas. Exigir fechamento por requisito, testes pertinentes, regressao e controles negativos quando houver comportamento.

## Critical

Usar para autorizacao, privacidade, isolamento, concorrencia, migration/backfill, runtime policy, parser/decoder, provider, retry/fallback, cancelamento ou continuidade. Executar inventarios e controles especificos da familia.

## Classificacao de mudanca

- config/schema sem codigo elegivel: preservar gates comportamentais, marcar higienizacao `not-applicable`;
- teste/gerado apenas: nao executar higienizacao por padrao;
- assets visiveis: ativar interface quando houver efeito percebido;
- finding novo nos mesmos caminhos: reabrir implementacao pelo `work_item_fingerprint`.

O perfil define profundidade, nao veracidade. Pode subir quando surgir sinal. Reducao exige justificativa estruturada e nao pode remover gate aplicavel.
