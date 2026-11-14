# Financeiro v2 — 13. Importações, Central de Conferências e Fechamento Mensal (Execução 06C)

Data: 12/11/2026. Branch local `feat/financeiro-v2-conferencias`, derivada de `e2895b7` (Execução 06B).

> Público: só dados sintéticos. Nada foi publicado; nenhuma rota do aplicativo foi criada ou alterada; produção não foi acessada; nenhum dado real de setembro foi gravado (nem no banco local). Os totais reais ficam no documento privado 02, fora do Git.

A Central torna **operacionais** os motores que já existiam — importação com prévia, propostas, correspondências, competências — sem criar outra arquitetura financeira. Ela responde, para cada competência: o que está correto, o que falta conferir, qual é a diferença, por que existe a pendência, qual documento é necessário, o que pode ser feito agora e o que impede o fechamento.

## 1. Fase A — diagnóstico e correções prévias

| Ponto | Achado | Tratamento |
|---|---|---|
| Git e testes | Branch derivada de `e2895b7`; 234/234 testes v2 em memória e PostgreSQL antes de começar | — |
| Paginação | A porta de persistência só filtrava por igualdade e devolvia **tudo** (sem LIMIT nem COUNT no banco) | Porta ganhou `paginar` (filtros `onde`/`desde`/`ate`/`em`, ordem, LIMIT/OFFSET e COUNT separado) e `agregar` (contagem e soma agrupadas). Implementado nos dois adaptadores com a mesma semântica; consulta mal formada é recusada (nunca vira "listar tudo"). |
| Formação de propostas | `persistir` lia **todas** as propostas da mesma operação a cada proposta gerada (custo quadrático com volume) | Busca restrita à mesma origem, resolvida no banco (`origemChave` em `extras`). |
| Correspondências | Não tinham competência: impossível filtrar por mês no banco | Competência gravada na criação (manual, automática e conta a pagar × saída) = a mais antiga dos registros envolvidos. |
| Fechamento | Homologar exigia só a metodologia: **nada** bloqueava a homologação | Guarda no núcleo (seção 8). |
| Conciliação | Decidir correspondência não verifica o estado da competência (pré-existente) | Documentado como limitação; não alterado nesta execução. |
| Migrações 0001–0008 | Aplicadas em ordem num banco-modelo novo, sem erro | Nova `0008_conferencias_indices.sql`: só índices (propostas por competência/estado/data, importações por período, correspondências por competência/situação, registros por importação). |
| Sessão e permissões | Adaptador de sessão e concessões reais do módulo; ações `financeiro_v2.*` próprias | Perfil de demonstração "Operador" com concessão explícita (seção 9). |
| Processos locais | Relatos de PostgreSQL órfão (54329) e demonstração antiga (5179) | Inspecionados por executável e pasta; **nenhum foi encerrado**. Ao retomar, os dois já não existiam (terminaram com a sessão anterior). A execução usou PostgreSQL isolado próprio (`fv2-pg-teste-06b`, porta 54331) e demonstração na porta 5189. |

Operações realmente suportadas pelo núcleo e usadas pela Central (nada inventado): receber arquivo, reavaliar, confirmar e rejeitar importação; gerar, aprovar, rejeitar e aplicar proposta; gerar candidatas (regras automáticas), criar candidata manual, confirmar, registrar divergência, marcar aguardando documento e rejeitar correspondência; registrar e explicar divergência entre relatórios SAIPOS; mudar estado da competência.

## 2. Estrutura da Central

Item **Importações e Conferências** do menu (antes "em construção"), com seis seções:

| Seção | Mostra |
|---|---|
| Resumo | Situação do fechamento, divergências que impedem a homologação, pendências a resolver (**contagem**), importações aguardando revisão, propostas pendentes, conciliações candidatas, "o que está correto", "o que falta conferir" por grupo, documentos com e sem arquivo importado |
| Pendências | Lista compacta agrupada (título, impacto quando conhecido, situação, responsável, motivo em uma frase, "Revisar") com filtros de grupo e situação |
| Documentos e importações | Documentos da competência, prévia do motor, leitores homologados, fluxo de importação local |
| Propostas para revisão | Propostas com efeito explicado antes da aprovação |
| Conciliações | Correspondências com os dois lados, critério, diferença e confiabilidade |
| Fechamento mensal | Etapas, metodologia, impedimentos, conferência por assunto, histórico de revisões |

Códigos, hashes e JSON ficam só em "Detalhes técnicos" (recolhível).

## 3. Consultas (somente leitura, ação `financeiro_v2.ver`)

| Operação | Entrada | Devolve | Onde é calculado |
|---|---|---|---|
| `consultarCentralDeConferencias` | competência | resumo da seção 2 | contagens por `agregar` no banco; pendências derivadas |
| `consultarDocumentosImportados` | competência?, fonte?, estado(s)?, página | documentos legíveis + totais por estado + matriz de leitores | **lista paginada no banco**; totais em agregação separada |
| `detalharImportacao` | id | prévia gravada pelo motor, resultado, registros por tipo, propostas geradas, limitações, ações permitidas, histórico | — |
| `consultarPropostasParaRevisao` | competência, estado(s)?, operação?, página | propostas + contagem por estado e por operação | **paginada no banco** |
| `detalharProposta` | id | o que será registrado, por quê, documento, efeito na DRE, nos títulos e no caixa, pendências, conflitos, autorização, histórico | — |
| `consultarCorrespondencias` | competência, situação(ões)?, relação?, página | os dois lados legíveis, critério, confiabilidade, diferença, ambiguidade | **paginada no banco** |
| `detalharCorrespondencia` | id | idem + evidências, se pode confirmar e por quê, histórico | — |
| `consultarPendencias` | competência, grupo?, situação?, página | contagem por grupo e situação + lista | derivada dos motores |
| `detalharPendencia` | competência, chave | painel "Revisar" | derivada |
| `consultarFechamento` | competência | situação real do fechamento | derivada + histórico |

Todas recusam campos desconhecidos; organização e unidade vêm só do contexto autenticado; página até 100 itens.

**A paginação nunca muda um indicador:** listas usam `paginar` (página + total exato) e totais usam `agregar`, independentes da página. Pendências e fechamento são leituras **derivadas** de vários motores (apuração, vendas, tesouraria) e por isso montadas a partir dos registros do escopo; no teste de volume (seção 11) a montagem levou 143 ms.

## 4. Documentos, prévias e fluxo de importação

Cada documento mostra nome legível do relatório, fonte, tipo, período, data de recebimento e de importação, responsável ("Você"/"Outro usuário autorizado" — nomes de pessoas não existem no módulo), registros ativos, totais de controle, situação (Recebido, Em validação, Pronto para importar, Importado, Importado com pendências, Rejeitado, Substituído), divergências, versão e substituições. Hash, identificador e caminho de arquivo **nunca** aparecem.

A prévia exibida é a **produzida e gravada pelo motor** na recepção (válidos, rejeitados, duplicados no arquivo, já existentes, conflitos, divergências, totalizadores e amostra): a tela não monta prévia própria.

**Leitores homologados** (preservados): Stone vendas XLSX, Unicred extrato PDF, SAIPOS faturamento diário PDF, SAIPOS formas de pagamento XLSX. Cada importação diz se o leitor foi homologado **naquele formato**; os demais aparecem como "leitor não homologado — conferência manual".

### Fluxo local (demonstração)

```
escolher arquivo SINTÉTICO → receber no cofre (gera a prévia) → revisar → confirmar importação
      → gerar propostas → revisar proposta → aprovar (não grava efeito) → aplicar (grava o efeito, uma vez)
      → (conciliações) procurar candidatas → investigar → confirmar com evidência
```

Importar registros, aprovar proposta, aplicar efeito e confirmar conciliação são operações **diferentes**, com permissões e confirmações próprias.

## 5. Propostas

Nome legível (Registrar venda, Registrar venda agregada do dia, Vincular pagamento Stone e formar recebível, Registrar obrigação com entregador, Registrar movimentação bancária), origem, competência, valor, natureza, categoria sugerida, situação, confiança, documento, pendências e justificativa. O detalhe explica, **antes de aprovar**: (1) o que será registrado, (2) por que foi sugerido, (3) o documento, (4) o efeito na DRE (com fração de centavo da taxa Stone quando houver), (5) em recebíveis/obrigações, (6) no caixa, (7) dados pendentes, (8) conflitos (duplicidades e receita do mesmo dia na outra granularidade), (9) a autorização exigida (`financeiro_v2.revisar`) e se a pessoa a tem, (10) histórico e detalhes técnicos. "Aplicar" só aparece depois de aprovar.

## 6. Conciliações

Relações suportadas pelo motor: venda SAIPOS × transação Stone, transação Stone × recebimento Stone, recebimento Stone × crédito Unicred, repasse iFood × crédito Unicred, entregas Foody × pagamento Unicred, conta a pagar × saída bancária e correspondência manual. "Recebível × repasse" e "transferência entre contas" não têm regra própria no motor: entram como correspondência manual (nada foi inventado).

Cada lado mostra fonte, data, valor, natureza e identificador exibível — **sem a descrição livre do extrato**, que pode conter nomes. Critério em português, confiabilidade (forte: identificador comum; fraca: só valor e data — "nunca prova"; manual), diferença e evidências. Confirmar usa a operação real do núcleo e só é possível quando os lados fecham e **nenhuma** outra candidata disputa os mesmos registros (ambígua é recusada).

## 7. Pendências agrupadas

Grupos: Vendas e ajustes · Recebimentos e repasses · Contas e pagamentos · Custos e rateios · Caixa e conciliação · Classificações financeiras · Pendências documentais.

- **Um fato, uma pendência, um grupo.** Quando dois motores apontam o mesmo registro (ex.: a apuração vê "saída sem classificação" e a tesouraria vê "movimento sem vínculo"), a Central mostra UMA pendência, registra quem a apontou e só lista um segundo motivo se ele disser algo diferente.
- A quantidade é **contagem**; não existe soma em reais das pendências.
- "Custos e rateios" fica vazio: não há motor de rateio no Financeiro v2 (dito na tela).
- O painel **Revisar** mostra o que aconteceu, origem, impacto, motivo, documentos existentes e necessários, opções permitidas, histórico de decisões e detalhes técnicos recolhidos; liga ao registro real quando existe tela para ele.
- Nenhuma pendência é resolvida por hipótese nem considerada aprovada sem documento ou decisão registrada.

## 8. Fechamento mensal

Estados: competência aberta → fechamento preliminar → fechamento com pendências documentadas → fechamento gerencial homologado.

A tela mostra metodologia em vigor, conferência por assunto (importações, vendas, conciliação bancária, recebíveis, obrigações, classificações, documentação faltante), responsável pela última decisão, histórico de revisões, pendências documentadas e **impedimentos de homologação**.

**Guarda no núcleo** (vale para qualquer cliente, não só a tela): a transição para homologado é **recusada** (`FV2_HOMOLOGACAO_BLOQUEADA`) quando existe divergência relevante sem justificativa:

- relatórios do mesmo período com totais diferentes e **sem explicação registrada**;
- saldo de conta informado que não confere com o calculado;
- receita agregada e por pedido no mesmo dia (contagem dupla).

Não há política de materialidade aprovada: **nenhuma tolerância** é presumida e nada é homologado automaticamente. Recebível válido ainda não pago **não** bloqueia. Pendências de classificação e documentação exigem fechamento "com pendências documentadas" (decisão humana), sem bloqueio automático. Nesta execução a demonstração **só visualiza** o fechamento.

## 9. Permissões e segurança das ações

| Ação na demonstração | Operação do núcleo | Permissão |
|---|---|---|
| Receber arquivo do catálogo | `receberArquivoParaImportacao` | importar |
| Confirmar / rejeitar importação | `confirmarImportacao` / `rejeitarImportacao` | importar |
| Gerar propostas | `gerarPropostas` | registrar |
| Aprovar / rejeitar / aplicar proposta | `aprovarProposta` / `rejeitarProposta` / `aplicarProposta` | revisar |
| Procurar candidatas / confirmar conciliação | `gerarCandidatasDeConciliacao` / `confirmarConciliacao` | conciliar |

- Perfis de sessão explícitos: Gestor (só leitura nas duas unidades), **Operador da demonstração** (importar, registrar, revisar, conciliar só na unidade 1; só leitura na 2), Usuário sem concessão, Sem sessão.
- Ações: só `POST` JSON (≤ 8 KB), da própria origem (`http://127.0.0.1:<porta>`), com **token CSRF** por perfil (HMAC de segredo aleatório do processo), **confirmação humana** (`confirmar: true`, caixa marcada na tela), campos conhecidos e escopo validado pelo adaptador de sessão.
- Idempotência, transação, auditoria e revalidação da prévia são as do núcleo: o mesmo arquivo devolve a mesma importação; confirmar compara a prévia revisada com a refeita a partir do cofre; aplicar de novo devolve o efeito anterior; conciliação já decidida é recusada.
- **Só arquivos sintéticos** do catálogo da demonstração podem ser importados (outubro/2026). Não existe envio de arquivo real; nenhum documento real é aplicado.
- O servidor não registra corpo de requisição em log; respostas de erro não trazem pilha.
- Nada disso existe no aplicativo publicado: o módulo continua sem rota (teste estático de isolamento).

## 10. Caso de setembro de 2026 (sintético)

A demonstração mostra, com dados sintéticos: diferença comercial entre relatórios (faturamento diário × formas de pagamento, aberta e bloqueando a homologação), repasse não conciliado (créditos registrados sem extrato), despesa sem classificação (saída bancária sem vínculo), obrigações sem comprovante e fechamento **com pendências documentadas** (extrato bancário de setembro ausente). A diferença real entre os relatórios SAIPOS de setembro continua **sem causa comprovada** e depende do relatório por pedido; nenhum dado real foi gravado.

## 11. Testes

| Conjunto | Resultado |
|---|---|
| Financeiro v2 em memória | 245/245 |
| Financeiro v2 em PostgreSQL local isolado (0001–0008) | 245/245 |
| Frontend (todos) | 1.949 testes: 1.923 passam, 26 pulados (pré-existentes), 0 falhas |
| Novos | `conferencias.test.js` (10), `postgres-conferencias-volume.test.js` (1), `frontend/test/financeiroV2Conferencias.test.js` (13) |
| Volume | 4 meses sintéticos (1.200 propostas): página de 20 em ~11–13 ms; nenhuma leitura de propostas trouxe mais que 20 linhas (espião no cliente SQL); totais idênticos em todas as páginas |
| Mutação | 4 mutantes (sem guarda de homologação, sem unificação por fato, recebível em aberto bloqueando, tolerância presumida de R$ 200) — todos pegos |

Os 35 itens pedidos estão cobertos: documentos (1), prévia (2), leitor homologado (3) e não homologado (4), arquivo repetido (5), importação idempotente (6), arquivo incompatível (7), proposta com efeito (8) e com dados insuficientes (9), aprovação autorizada (10) e negada (11), aplicação transacional (12), confirmação repetida (13), candidata (14), ambígua (15), conciliação com evidência (16), pendência documental (17), classificação desconhecida (18), agrupamento sem duplicidade (19), contagem (20), fechamento preliminar (21) e com pendências (22), homologação bloqueada (23), recebível não pago (24), histórico de revisão (25), isolamento por organização (26) e unidade (27), paginação e filtros no banco (28), segurança das ações (29), celular (30), teclado (31), troca de competência (32), resposta atrasada (33), logs sem dado privado (34) e integração com DRE e Vendas (35).

## 12. Limitações

- Nenhum arquivo real é importado pela demonstração; a importação real continua dependendo da integração com autenticação e cofre de produção (doc 10).
- Pendências e fechamento são derivados dos registros do escopo a cada consulta (rápido no volume testado; para anos de dados, o próximo passo é recortar a leitura por período no banco).
- Decidir correspondência não verifica o estado da competência (comportamento anterior, não alterado).
- Responsável aparece como "Você"/"outro usuário": o módulo não tem cadastro de nomes; atribuição de responsável a pendências ainda não existe.
- Homologar, fechar e explicar divergências não estão expostos na demonstração (só visualização do fechamento).
- Sem motor de rateio de custos; política de materialidade não especificada.
- Fontes sem amostra real: iFood, Foody, Stone recebimentos, Anota AI, OFX.

## 13. Próximas dependências (para a 06D)

Política de materialidade aprovada; relatório por pedido do SAIPOS (diferença de setembro); amostras reais de iFood e Stone recebimentos; tabela real de concessões e responsáveis; ações de fechamento (fechar, documentar pendências, homologar) com permissões próprias na interface; explicação de divergências com evidência pela tela; verificação de competência ao decidir conciliações.
