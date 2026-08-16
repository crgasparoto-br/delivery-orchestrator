# Auditoria visual e de experiência

## Evidência obrigatória

Registrar para cada cenário relevante:

- rota ou fluxo de navegação;
- commit ou estado auditado;
- usuário/perfil e dados usados;
- viewport em pixels;
- screenshot ou gravação quando disponível;
- passos para reproduzir;
- resultado observado.

Sem execução visual, classificar a auditoria como `Não verificável`. Leitura de JSX, CSS ou componentes não substitui a renderização.

## Matriz de auditoria

### Arquitetura da informação

- a tarefa principal é identificável em poucos segundos;
- informações aparecem na ordem da decisão ou execução;
- agrupamentos refletem significado, não estrutura técnica;
- conteúdo primário não compete com detalhes secundários;
- a ação principal está evidente e contextualizada;
- ações destrutivas não competem com ações frequentes.

### Hierarquia visual

- existe um título principal claro;
- peso, tamanho, contraste e espaçamento indicam níveis coerentes;
- cards, bordas e fundos possuem função real;
- não há excesso de elementos com igual destaque;
- dados importantes são comparáveis e escaneáveis;
- textos explicativos não substituem boa estrutura.

### Dimensionamento e composição

- campos correspondem ao tamanho esperado do conteúdo;
- botões, inputs, cards, tabelas e modais não parecem esticados ou comprimidos;
- conteúdo não fica excessivamente largo;
- espaços vazios e densidade são funcionais;
- modais cabem na altura disponível;
- tabelas e listas mantêm leitura e ações acessíveis.

### Consistência

- componentes e tokens seguem o projeto;
- mesma ação usa mesmo texto, ícone e padrão;
- padrões de filtros, formulários, modais e feedback são coerentes;
- não há biblioteca visual paralela sem necessidade;
- telas correlatas não contradizem a nova solução.

### Responsividade

- desktop amplo e de baixa altura funcionam;
- mobile preserva prioridade e ação principal;
- não existe overflow horizontal acidental;
- menus, popovers, tooltips e modais permanecem dentro da viewport;
- conteúdo longo não sobrepõe ou corta controles;
- tabela possui estratégia mobile deliberada.

### Interação e feedback

- loading não desloca ou quebra o layout indevidamente;
- estado vazio explica a situação e oferece próxima ação quando aplicável;
- erros são próximos da causa e acionáveis;
- sucesso e salvamento são perceptíveis sem interromper desnecessariamente;
- controles desabilitados possuem justificativa quando não óbvia;
- confirmação é proporcional ao risco.

### Acessibilidade

- ordem de foco segue a ordem visual e lógica;
- foco é visível;
- todos os controles possuem nome acessível;
- labels persistem e erros são associados aos campos;
- contraste é suficiente;
- informação não depende apenas de cor;
- teclado permite concluir o fluxo principal;
- zoom e conteúdo ampliado não causam perda material.

### Conteúdo

- labels e ações usam linguagem do domínio;
- textos estão em português do Brasil quando aplicável;
- nomenclatura é consistente;
- datas, números, moedas e unidades estão formatados;
- mensagens evitam termos técnicos internos;
- truncamento possui alternativa de acesso ao conteúdo completo.

## Cenários adversariais mínimos

- nome, título ou descrição longos;
- número e moeda com mais dígitos;
- lista vazia e lista extensa;
- erro de campo e erro global;
- loading lento;
- usuário sem permissão;
- viewport 1366×768;
- viewport mobile próxima de 390 px;
- navegação somente por teclado;
- zoom do navegador quando viável;
- modal com conteúdo máximo esperado.

## Severidade

### Bloqueador

- impede concluir a tarefa principal;
- conteúdo ou ação essencial fica inacessível;
- modal, navegação ou fluxo fica preso;
- falha grave de acessibilidade impede operação;
- interface expõe ação ou dado indevido por permissão.

### Alto

- hierarquia leva a erro relevante;
- layout quebra em viewport suportada;
- ação principal fica difícil de localizar ou usar;
- informação essencial é truncada, ambígua ou organizada incorretamente;
- padrão inconsistente aumenta risco operacional;
- contraste, foco ou teclado inviabilizam parte importante do fluxo.

### Médio

- dimensionamento, densidade ou agrupamento prejudica eficiência;
- estado vazio, loading ou erro é incompleto;
- responsividade exige esforço evitável;
- inconsistência visual relevante sem bloquear a tarefa.

### Baixo

- detalhe cosmético ou microcopy com impacto pequeno;
- alinhamento ou espaçamento pontual sem efeito material;
- melhoria de consistência não crítica.

## Parecer

- **Aprovada**: nenhum achado material; baixos opcionais não comprometem o padrão.
- **Reprovada**: qualquer bloqueador/alto ou conjunto de médios que degrade materialmente a tela.
- **Não verificável**: evidência visual essencial indisponível.

Descrever correções como resultados observáveis, não como instruções vagas como “deixar mais bonito”.
