# Enforcement de evidencias v5

## Regra central

Nao aceitar booleano, checklist, resumo, descricao de PR ou arquivo arbitrario como prova de completude. A decisao final deve ser derivada de artefatos existentes, hasheados, vinculados ao SHA congelado e semanticamente consistentes entre si.

## Artefatos obrigatorios

Exigir no `loop-state.json` os artefatos abaixo, todos com `path`, SHA-256, `head_sha` e status `present`:

- `execution-context`;
- `specification-snapshot`;
- `requirement-closure`;
- `risk-profile`;
- `documentation-impact`;
- `gate-report`;
- `source-manifest`;
- `requirements-rederivation`;
- `coverage-matrix`;
- `applicability-ledger`;
- `controller-audit-report`;
- `cycle-history`;
- `remote-gate` quando existir PR;
- `input-parser-attack-matrix` quando a familia `input-parser` estiver aplicavel.

## Fontes e requisitos

`source-manifest` deve listar issue, comentarios, anexos, subissues, instrucoes locais e fontes canonicas consultadas, com identificador, tipo, localizador e hash. Todo requisito deve apontar para um identificador existente nesse manifesto. O manifesto deve registrar descoberta reproduzivel, caminhos encontrados, caminhos declarados, omissoes justificadas e consultas de termos antigos/novos; `complete: true` isolado nao e evidencia.

`requirements-rederivation` deve ser produzido na fase de auditoria, sem copiar conclusoes do implementador, e conter exatamente o inventario final. Divergencia entre a rederivacao e o estado impede aprovacao.

Cada requisito `Implementado` deve possuir simultaneamente:

- evidencia positiva discriminante;
- pelo menos um controle negativo capaz de rejeitar implementacao plausivel mas incorreta;
- `negative_control_evidence` com correspondencia exata de IDs, procedimento reproduzivel, resultado esperado e observado, SHA, arquivo de evidencia e SHA-256;
- evidencia de regressao ou compatibilidade aplicavel.

String, nome de teste, checklist ou referencia a CI nao bastam. Ler `adversarial-evidence.md` e validar o conteudo da evidencia, nao apenas sua presenca.

## Aplicabilidade

Classificar todo arquivo alterado em uma ou mais familias de risco. Registrar no `applicability-ledger` as familias aplicaveis, base objetiva, gates obrigatorios e subskills obrigatorias.

No minimo, a familia `documentation` e sempre aplicavel. Interface, persistencia, autorizacao, fluxo assincrono, integracao, runtime transitivo, migration e seguranca devem ser ativados quando os caminhos ou contratos tocados indicarem esses riscos. Parsers, decoders, desserializadores, lexers e tokenizers exigem avaliacao explicita de `input-parser`; a familia deve produzir inventario integral de campos consumidos, matriz `accepted_modes x consumed_fields x field_scope_placements`, casos brutos incluindo `limite + 1` e documento valido com padding externo acima do limite, e evidencias aprovadas dos controles `IP-RAW-001`, `IP-MODE-001`, `IP-SCOPE-001`, `IP-INACTIVE-001` e `IP-EFFECT-001`. Em formatos hierarquicos, exigir tambem `scope-membership`, `inactive-content` e `cross-scope-context` em todas as variantes aceitas, inclusive modo sem declaracao ou cabecalho.

Familia aplicavel sem gate obrigatorio, ou sem resultado hasheado de subskill exigida, impede aprovacao.

## Gates de desempenho com escopo

Quando o requisito de desempenho for tenant-scoped, por particao, por usuario, por status ou por qualquer outro filtro de isolamento:

- medir a cardinalidade do mesmo escopo consultado; total global, linhas de outros tenants ou categorias excluidas nao podem compor o denominador de aprovacao;
- inserir ruido deliberado fora do escopo e provar que esse ruido nao altera o resultado do gate;
- registrar tamanho da pagina, candidatos do escopo alvo, linhas observadas no plano e limite proporcional permitido;
- exigir controle negativo que reproduza leitura integral ou quase integral do escopo alvo e falhe mesmo quando o banco inteiro for muito maior;
- preferir o plano da consulta real ou uma consulta estruturalmente identica, incluindo filtro, ordenacao, desempate e limite;
- rejeitar verificadores que comparem linhas lidas no tenant alvo com contagem global do banco.

## Gates atestados

Executar gates com `scripts/run_attested_gate.py`. A atestacao deve conter comando, cwd, SHA observado, inicio, termino, exit code e hashes de stdout e stderr. O `gate-report` deve referenciar os hashes das atestacoes.

Nao aceitar um log contendo apenas `passed`, exit code preenchido manualmente ou comando declarado sem atestacao correspondente.

## Auditoria controller

Exigir `controller-audit-report` conforme `auditar-issue/schemas/controller-audit-result.schema.json`, versao 3. Validar antes de avaliar o ciclo.

Mesmo em `controller-adversarial`, exigir:

- inicio posterior ao freeze;
- termino registrado;
- somente leitura;
- rederivacao comprovada;
- pacote neutro hasheado;
- identidade auditada igual a identidade congelada;
- nenhuma modificacao durante a auditoria;
- hashes coincidentes de manifesto, rederivacao e matriz de cobertura.

## Fechamento de achados

Nao fechar finding bloqueante apenas alterando `status`. Exigir SHA de deteccao, novo SHA remediado, hash do diff corretivo, teste de regressao, arquivo de evidencia de fechamento e ciclo de reverificacao.

## Historico e recorrencia

Manter `cycle-history` append-only. Derivar `occurrence_count` do historico de fingerprints; nunca aceitar contagem informada sem correspondencia no ledger.

Qualquer finding torna `learning_review` obrigatorio, inclusive no modo `standard`.

## Artefatos de escape v5

Quando existir qualquer `audit_escape`, exigir tambem:

- `audit-escape-ledger.json` append-only;
- `adversarial-controls.json` append-only;
- pacote completo da Skill alterada e resultado dos testes da Skill;
- evidencia de que o controle novo foi executado no SHA remediado.

O manifesto do pacote neutro deve declarar `implementation_conclusions_included=false` e `implementation_narrative_included=false`.
