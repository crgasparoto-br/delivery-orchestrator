# Resolucao de recursos da Skill e artefatos remotos

## Objetivo

Evitar confundir recursos internos da Skill com arquivos do repositorio auditado e impedir que limitacoes do runtime sejam reportadas como defeitos da issue.

## Propriedade dos caminhos

- Interpretar `scripts/...`, `schemas/...`, `references/...` e `tests/...` citados por `SKILL.md` como relativos ao root instalado da Skill `auditar-issue`.
- Nunca procurar `check_delivery_preflight.py`, `validate_handoff_certificate.py`, `check_delivery_saturation.py`, `check_reaudit_readiness.py` ou `validate_learning_closure.py` dentro do repositorio auditado.
- Nunca exigir que o repositorio versione, copie ou venda scripts internos da Skill.
- Tratar `.audit/entregar-issue/...` como artefatos da entrega no repositorio; esses sao entradas para os validadores da Skill.

## Resolucao do root da Skill

1. Preferir o diretório instalado da Skill quando o runtime o expuser como filesystem.
2. Quando a Skill estiver exposta apenas como `skills://auditar-issue/...`, ler o recurso pelo mecanismo de Skills e materializar somente os scripts necessarios em workspace efemero, preservando o conteudo exato.
3. Executar scripts a partir desse root/materializacao; nao usar o `cwd` do repositorio para resolver recursos internos.

## Materializacao dos artefatos da entrega

Antes de materializar, ler o certificado. Em schema v2 `result-only-child`, distinguir o head publicado do `material_head_sha`: obter parent e changed paths do commit publicado por metadata remota e preservar esses valores para o preflight. Os arquivos `.audit/entregar-issue/*` podem estar no filho de resultados, enquanto attack matrix, saturation e inherited controls permanecem semanticamente vinculados ao material head.

1. Se houver checkout local do candidato, usar diretamente `.audit/entregar-issue/`.
2. Se houver apenas connector remoto, preferir uma acao que retorne arquivo/mounted path/download reutilizavel.
3. Se o connector retornar conteudo bruto completo, materializar o arquivo em workspace efemero sem normalizar, reformatar ou reserializar JSON antes da verificacao de SHA-256.
4. Nao reconstruir arquivo truncado, resumido, paginado de forma incompleta ou obtido por snippets.
5. Nao escrever nada no repositorio auditado para viabilizar o preflight.

## Classificacao de falhas

Usar `delivery-not-ready` somente quando houver evidencia de problema na entrega, por exemplo artefato realmente ausente no candidato, hash divergente, identidade stale ou validador executado retornando BLOCK.

Usar `audit-runtime-limitation` quando o pacote da Skill contem o validador, mas o runtime nao permite executa-lo, ou quando o connector nao permite obter os bytes exatos dos artefatos necessarios. Essa condicao:

- produz resultado humano `INCONCLUSIVA`;
- usa `Libera merge/release: NAO`;
- nao produz finding da issue para essa causa;
- nao entra em `blocker_bounded`;
- nao exige refreeze se a identidade nao mudou;
- nao recomenda commit, issue corretiva, workflow, vendorizacao de script ou mudanca no produto;
- registra no resultado estruturado `status=blocked` e a limitacao em `limitations`.

## Regra fail-closed correta

Fail-closed significa nao aprovar sem a evidencia obrigatoria. Nao significa atribuir ao candidato uma falha causada exclusivamente pela infraestrutura do auditor.

## Fallback connector-native por snapshot Git imutavel

Quando o checkout/arquivo montado nao estiver disponivel, **nao concluir imediatamente `audit-runtime-limitation`** se o connector expuser o snapshot Git exato e permitir consultar o objeto completo semanticamente.

Aplicar a seguinte ordem:

1. Tentar a materializacao por bytes e `check_delivery_preflight.py`; esse continua sendo o caminho preferencial.
2. Se somente a transferencia de bytes entre connector e runtime estiver indisponivel, obter do head publicado: commit, `tree_sha`, parent, changed paths e, para cada artefato obrigatorio, `git_blob_sha`, tipo `blob` e tamanho.
3. Ler o artefato pelo connector no **mesmo ref imutavel**. Saida visual truncada nao invalida o objeto se a resposta/resource subjacente continuar pesquisavel integralmente; usar busca no resource para verificar os campos sem reconstruir bytes.
4. Produzir em workspace efemero `connector-preflight-manifest.json` com as identidades Git e as observacoes semanticas rederivadas pelo auditor. Nao copiar conclusoes do produtor como observacao propria.
5. Executar `<AUDIT_SKILL_ROOT>/scripts/check_connector_preflight.py --certificate ... --connector-manifest ... --contract-version 2026-08-06.2`.
6. Se retornar `READY`, continuar a auditoria. Esse modo prova identidade por snapshot Git imutavel + verificacao semantica do objeto no mesmo ref; nao afirma que o SHA-256 do produtor foi recalculado.
7. Se retornar `BLOCK`, classificar a causa contra a entrega somente quando a divergencia estiver demonstrada.
8. Se retornar `LIMITATION`, somente entao usar `audit-runtime-limitation`/`INCONCLUSIVA`.

Requisitos do fallback:

- nao aceitar branch mutavel sem SHA fixo;
- nao aceitar snippets ou busca que nao cubram o objeto completo;
- nao aceitar apenas nome/tamanho sem `git_blob_sha` e `tree_sha`;
- nao aceitar manifest sem parent/changed paths no `result-only-child`;
- rederivar `head_sha`, saturacao, controles herdados e closure a partir do conteudo consultado;
- registrar que a integridade foi estabelecida por identidade de objeto Git, nao por SHA-256 recalculado localmente.
