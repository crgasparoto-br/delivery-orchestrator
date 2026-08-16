# Higiene interna limitada

## Aplicabilidade

Aplicar apenas quando o diff contem codigo executavel elegivel ou quando um finding concreto exigir safe-fix. Retornar internamente `not-applicable` para documentacao, assets, snapshots, gerados e configuracao sem codigo elegivel.

## Escopo

Inspecionar arquivos tocados e consumidores diretos. Corrigir somente:

- duplicidade introduzida ou agravada;
- codigo morto diretamente relacionado;
- import ou dependencia sem uso;
- temporario deixado pela implementacao;
- complexidade acidental que dificulte provar o requisito.

## Limites

- Nao alterar comportamento intencionalmente.
- Nao refatorar modulo inteiro por oportunidade.
- Nao expandir caminhos sem causa verificavel.
- Aceitar `no-change`.
- Executar somente validacoes invalidadas pelo safe-fix.
