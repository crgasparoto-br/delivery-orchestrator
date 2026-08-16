# Gate de consistencia temporal

## Aplicabilidade

Ativar quando resposta, agregado, saldo, projecao, historico, elegibilidade, destino operacional ou regra de negocio depender de periodo solicitado, data corrente, `as-of`, vigencia, vencimento, competencia, `occurredOn`, `plannedOn`, `dueOn`, `weekStartDate`, `workoutDate`, agenda, semana, janela futura/passada ou timezone.

Ativar tambem quando datas nao forem usadas em calculo, mas decidirem **onde/quando uma mutacao pode escrever**, por exemplo selecionar semana futura, destino ainda nao executado, vigencia de contrato ou janela permitida. Data sintaticamente valida nao comprova coerencia temporal do destino.

## Contrato temporal explicito

Antes de aprovar, mapear para cada metrica ou mutacao:

- periodo/horizonte apresentado ou selecionado;
- cutoff real usado por cada consulta, agregado ou comando;
- semantica de eventos realizados, planejados e futuros;
- relacao entre campos temporais concorrentes (`weekStartDate` x `workoutDate`, `plannedOn` x `dueOn` etc.);
- timezone e inclusividade das bordas;
- comportamento para periodo passado, atual e futuro;
- quando aplicavel, regra que torna um destino realmente futuro/nao executado, nao apenas `planned`.

Qualquer divergencia entre horizonte rotulado/selecionado e cutoff executado deve ser deliberada, documentada e testada. Nao aceitar `now` implicito dentro de resposta historica nem aceitar uma data ISO valida como prova de que o destino pertence ao periodo exigido.

## Controles minimos

### `TEMP-ASOF-001` — contaminacao posterior

Criar fixture deliberadamente divergente com evento dentro do periodo solicitado e evento posterior. Consultar um periodo historico. O evento posterior nao pode alterar metrica rotulada como pertencente ao periodo historico, salvo contrato explicito em contrario.

### `TEMP-CURRENT-001` — borda do periodo corrente

Usar eventos imediatamente antes, dentro e depois do cutoff corrente. Verificar inclusividade, timezone e ausencia de dupla contagem.

### `TEMP-FUTURE-001` — projecao futura

Separar realizados de planejados/futuros com valores distintos. Confirmar que apenas a classe temporal prevista contribui para cada metrica.

### `TEMP-SOURCE-001` — fontes temporais concorrentes

Quando houver mais de um campo temporal plausivel (`occurredOn` vs `effectiveOn`, `plannedOn` vs `dueOn`, etc.), atribuir periodos diferentes e provar que a fonte canonica governa o resultado.

### `TEMP-PERIOD-001` — coerencia entre periodo e data de destino

Quando o comando receber periodo/semana e uma data concreta, fornecer combinacoes deliberadamente contraditorias. Exemplo: `weekStartDate` de uma semana e `workoutDate` de outra. Esperado: rejeicao antes de qualquer efeito.

### `TEMP-DEST-001` — destino futuro versus passado

Quando o contrato exigir alvo futuro, executar pelo menos: data passada ainda `planned`, borda atual e data futura valida. O estado `planned` sozinho nao deve transformar um destino passado em futuro.

## Casos irmaos

Para cada defeito temporal encontrado, executar ao menos passado, atual e futuro ou justificar por que uma classe e impossivel. Um teste que usa apenas o periodo corrente nao comprova calculo historico, projecao ou destino futuro.

## Portao

Registrar controles em `requirement-attack-matrix.json`/`negative_control_evidence` com IDs estaveis, evidencia bruta e SHA congelado. Ausencia de controle aplicavel impede `INTERNALLY_APPROVED`.
