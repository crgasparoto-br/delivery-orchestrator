# Implementacao interna

## Principio

Executar implementacao como uma etapa interna do mesmo controlador. Consumir snapshot, fechamento, risco, caminhos, work items e write ownership sem reatomizar a issue.

## Preparar

1. Mapear cada requisito somente para as camadas necessarias.
2. Ler referencias especializadas apenas quando os sinais de risco existirem.
3. Registrar `input_fingerprint`, `implementation_scope`, `work_item_fingerprint` e `write_owner`.
4. Nao usar arquivos produzidos nesta rodada como novo input para reabrir a propria rodada.

## Implementar

- Alterar o menor conjunto coeso de arquivos.
- Preservar arquitetura e contratos publicos, salvo mudanca explicitamente requerida.
- Implementar comportamento ponta a ponta, nao apenas o caminho feliz.
- Atualizar testes e documentacao no mesmo recorte.
- Evitar TODO permanente, mock definitivo, seed incompleto ou fallback que esconda obrigacao.
- Para persistencia, autorizacao, entrada nao confiavel, provider, retry, concorrencia ou proveniencia, aplicar as referencias especializadas.

## Controles criticos preservados

- Validar identificadores estruturados recebidos do cliente antes do primeiro adapter ou comando SQL; nao depender do cast do banco como validacao publica.
- Tratar erro inesperado de persistencia como 5xx fail-closed: resposta publica generica, `correlationId` preservado e detalhes brutos somente em log interno redigido.
- Para entrada nao confiavel, preservar a representacao bruta ate concluir validacoes de bytes, vazio, encoding, limite, hash e identidade; nao normalizar antecipadamente.
- Inventariar modos, branches e todos os campos consumidos. Construir a matriz modo x invariante x familia de campo e aplicar `accepted_modes x consumed_fields x field_scope_placements`; um campo representativo nao comprova os demais. Cobrir limite + 1, padding externo e fronteira publica com os controles `IP-RAW-001`, `IP-MODE-001`, `IP-SCOPE-001`, `IP-INACTIVE-001` e `IP-EFFECT-001`.
- Para estados com proveniencia (`confirmedBy`, `confirmedAt`, snapshot, origem ou justificativa), tratar reenvio semanticamente identico como no-op. Executar `PROV-NOOP-001`: ator A confirma, ator B reenvia o mesmo estado ao alterar outro campo e um caso irmao em que B muda realmente a decisao. Preservar a proveniencia de A no no-op e transferi-la somente na mudanca efetiva. Validar persistencia apos releitura e tambem harness de schema reduzido/legado quando houver migration, trigger ou constraint.
- Garantir que uma tentativa do executor produza no maximo uma chamada outbound ao provider. Helpers transitivos nao podem executar probe, diagnostico ou recuperacao oculta.
- Para alerta, incidente, pendencia ou notificacao persistente que possa ser reaberta por mudanca material de estado, nao limitar a decisao de abertura ao instante de criacao da entidade/janela. Executar `ALERT-REOPEN-001`: partir de estado + alerta ja persistidos, provocar uma escalada material de severidade/faixa e separadamente um vencimento sem resolucao, exigir exatamente um novo/reaberto evento por transicao e zero duplicatas em retries. Quando um novo horizonte temporal for criado por extensao/renovacao, seu vencimento deve possuir identidade propria e poder gerar nova reabertura sem reutilizar silenciosamente o evento do horizonte anterior.
- Quando retry, idempotencia, duplo envio, mobile ou teclado forem requisitos, executar o fluxo em navegador real; busca textual no source nao substitui a prova.

## Validar durante a edicao

Executar somente checks focados:

- teste unitario ou integracao diretamente relacionado;
- lint, type-check ou build parcial aplicavel;
- migration, schema ou contrato publico afetado;
- links, exemplos e comandos documentais alterados;
- navegador real apenas quando a prova exigir interacao, retry, idempotencia, teclado, responsividade ou continuidade.

Nao executar a suite completa a cada ajuste.

## Fechamento por requisito

Antes de encerrar a implementacao, registrar para cada requisito:

- comportamento implementado;
- arquivos e entrypoints;
- evidencia positiva;
- controle negativo discriminante;
- regressao;
- limitacao ou pendencia real.

Executar uma leitura final do diff e procurar erros irmaos da mesma causa. Nao devolver a rodada com apenas o primeiro erro barato descoberto.
