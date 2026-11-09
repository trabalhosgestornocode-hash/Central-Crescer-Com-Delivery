# Caramelle Café — relatório consolidado de homologação técnica e preparação para produção

> Branch `feat/caramelle-fichas-tecnicas` (base `origin/main` `9df9b60`), **somente local**: sem push, sem merge, sem deploy, sem migration
> e sem importação em produção. Complementa `relatorio-homologacao.md` (vistoria e auditoria das planilhas — a lista de "limitações" daquele
> documento está **superada** por este).
> Dados do cliente (receitas, preços, relatórios por ficha) ficam **fora do repositório** (repo público).

## 1. O que mudou desde a primeira entrega

As seis decisões aprovadas foram aplicadas como segue.

| Decisão | Como ficou |
|---|---|
| Preservar as variantes dos 29 ingredientes divergentes | Uma variante por arquivo (`NOME` e `NOME (DOCES)`), cada ficha com o custo da própria planilha; pendência `valores_divergentes` visível na ficha |
| ÁGUA e TEMPERO pendentes, sem inventar custo | Entram **sem custo**; as fichas que os usam ficam "Incompletas" e não exibem custo nem podem ser homologadas |
| Não atribuir canal aos preços das planilhas | Preço de venda não é importado (fica só em `referencia`); a empresa cadastra os preços por canal |
| Condições comerciais configuráveis pela interface | Configurações › Metas e operação › **Condições comerciais** (comissão, taxas, promoções, tributos, responsável/custo de entrega, outras deduções, observação, histórico) |
| Não alterar silenciosamente as comissões das Subways | A migration 158 **não escreve** em `canais_venda` de ninguém; provado em Postgres (Subway X mantém 27%). Pré-visualização das ausentes: `database/ops/157b_canais_venda_subway_PREVIEW.sql` |
| Priorizar pendências, edição e homologação | Ficha técnica, pendências e homologação **dentro de Produtos** (lista + modal existentes; sem aba nova) |

### Fase A — Fichas técnicas DENTRO de Produtos (não existe aba nem módulo "Fichas Técnicas")
> **Ajuste de escopo (09/11):** a aba "Fichas Técnicas" criada na primeira rodada foi **removida** (menu, rota e página). Tudo vive no módulo
> **Produtos / CMV**, reaproveitando a lista, o modal de produto, o editor de ficha, o histórico e o simulador já existentes.

* **Lista de Produtos:** produtos do catálogo da empresa (importados, `homologacao != nao_aplicavel`) aparecem **na mesma tabela**, mesmo sem preço/tabela
  comercial (a unidade pode estar sem tabela: o aviso de tabela continua, mas o catálogo é exibido). Filtros extras **só aparecem quando existe catálogo**:
  categoria (Doces/Salgados/Bebidas) e situação (prontas, incompletas, pendentes, homologadas), mais "Homologar N prontas" (administrador).
  Distingue produto final × preparação intermediária; custo por porção; selo de homologação. **Empresas sem catálogo (Subways) não recebem nenhuma
  linha, filtro, botão nem chamada extra** (teste de navegador dedicado).
* **Modal do produto (o mesmo das Subways):** ao abrir um produto de catálogo, além do que já existia (ficha editável, preços por canal e CMV) aparecem
  seções novas — *Homologação* (quem/quando/por quê, histórico), *Pendências* com causa e ação, *Formação do custo* (ingredientes, preparações
  intermediárias, embalagens, custo do lote, **rendimento**, **custo unitário** = base do CMV), **mão de obra separada do CMV** (própria + herdada das
  preparações), *código do PDV* (vínculo com o iFood), e *Preço de venda · CMV · margem de contribuição por canal* com as **condições comerciais da
  própria empresa** (sem condições → margem indisponível, nunca assumida; condições incompletas → "parcial" com o que ficou de fora) e botão **Simular preço**.
  Usuários autorizados editam ingredientes/quantidades (inclusive as **preparações**, na unidade delas), corrigem o rendimento e o PDV e homologam; quem
  não tem permissão vê tudo mas nada disso é editável.
* **Produto Subway:** modal e lista **idênticos** ao anterior — sem seções novas, sem busca de condições, mesmo custo/ficha (testes de backend e de navegador).
* Dados ausentes ficam "—"/"indisponível" com explicação; o simulador, sem preço atual cadastrado, **não inventa** "preço atual" (parte de uma sugestão
  explícita de CMV 30%).

**Invalidação da homologação** (regra de versionamento adotada):
* alterar a **composição** da receita (inserir/alterar/remover linha de ficha) ou o **rendimento** ou o **custo manual** → o banco (gatilhos da
  migration 158) invalida a ficha **e todas que a usam como preparação**, limpa responsável/data e registra no histórico com o motivo;
* variação do **custo** acima de **0,5%** em relação ao custo homologado (ex.: reajuste de insumo) → a ficha passa a valer como pendente com
  motivo `custo_alterado` (derivado no backend, sem escrita em cascata a cada reajuste); rehomologar renova o custo-base;
* produtos de cadastro manual/Subways (`nao_aplicavel`) **nunca** são tocados por nenhuma dessas regras.

### Fase B — Condições comerciais
`GET/PUT /cmv/condicoes-comerciais` (+ histórico). Gravar exige `configuracoes.gerenciar` (administrador). Comissão obrigatória (0 explícito
vale); demais campos vazios = **não configurado**, nunca zero; taxas/promoções precisam ser informadas (0 se não houver) para a margem
estimada do Dashboard. Validação no backend **e** na tela; auditoria antes/depois em `canais_venda_historico`.

### Fase C — Proteção de precificação generalizada
O produto "Churrasco 15cm" continua como **padrão** quando nenhum produto é escolhido (Subways: resultado inalterado — teste dedicado).
Com `produtoId` o cálculo usa o produto escolhido (restrito à organização, vendável e ativo; id de outra empresa → "não encontrado") e,
**só na falta das deduções apuradas do mês**, as condições configuradas pela própria empresa para o iFood — rotuladas "estimada" e nunca
misturando fontes. Na tela do simulador do Dashboard: seletor de produto, nome do produto dinâmico e aviso da origem das deduções.

### Fase D — Dashboard iFood: painel "CMV teórico (estimativa)"
Recolhido por padrão, carrega ao expandir, escopo da unidade do Dashboard (mesma regra `resolverUnidadeAlvo`). Mostra CMV teórico, CMV com
ficha homologada, receita vinculada, itens **sem correspondência** (com o motivo), produtos com ficha incompleta, margem bruta e **após
comissão** (só se a comissão do iFood estiver configurada), sinais de precificação desfavorável, atalho **Simular preço** (abre o modal do
simulador com custo e preço médio praticado) e o aviso fixo "estimativa… não é resultado financeiro conciliado". Estados **indisponível**
(com motivo) e **parcial** (com a razão) explícitos. Para vincular itens, o **código do PDV** do produto agora é editável (único por empresa).

## 2. Arquivos (59 alterados/novos; 5.050 linhas)

* **Banco:** `database/migrations/157_*` + `157_rollback.sql`; `158_condicoes_comerciais_e_invalidacao_homologacao.sql` + `158_rollback.sql`;
  `database/ops/157b_canais_venda_subway_PREVIEW.sql` (somente leitura + blocos comentados).
* **Backend:** `modules/catalogo-importacao/*`, `scripts/catalogo-importar-planilhas.mjs`, `modules/produtos/{custo,produtos.service,produtos.routes,produtos.controller}.js`,
  `modules/cmv/{cmv.condicoes,cmv.routes,cmv.controller}.js`, `modules/dashboard-executivo/{cmvTeorico.calc,cmvTeorico.service,dashboardExecutivo.deducoes,
  dashboardExecutivo.precos.service,dashboardExecutivo.service,dashboardExecutivo.controller,dashboardExecutivo.routes}.js`, `shared/clonarCatalogo.js`.
* **Front:** novos `fichasTecnicas`, `fichasModelo`, `condicoesComerciais`, `condicoesComerciaisModelo`, `cmvTeoricoIfood`, `cmvTeoricoModelo`, `simulacaoPreco`;
  alterados `simuladorModal`, `dashboardExecutivoSimulador`, `dashboardExecutivo`, `configuracoes`, `config` (menu; `COMISSAO` fixa removida), `router`, `api`, `actions`, `styles.css`.
* **Testes:** ver seção 4.

## 3. Migrations (numeração e dependências reconferidas em 09/11)

| Nº | Depende de | Faz | Reversão |
|---|---|---|---|
| **157** | schema base, 004, 021, 022 | rendimento/homologação em `produtos`; `fn_custo_produto` com rendimento; `ficha_mao_de_obra`, `catalogo_origem`, `catalogo_importacoes`; `fn_catalogo_importar` | `157_rollback.sql` (recusa se houver dados importados) |
| **158** | **157**, 002 (`produto_historico`), `canais_venda` | condições comerciais completas + histórico; gatilhos de invalidação da homologação | `158_rollback.sql` (recusa se houver condições/histórico) |

`origin/main` está em `9df9b60` com a última migration **156**; nenhuma outra branch/worktree local usa 157+. Ordem de aplicação **157 → 158**;
de reversão **158 → 157**. Ambas são aditivas e idempotentes (aplicadas 2× nos testes). Nenhuma lê ou altera dado de empresa existente.

## 4. Resultados dos testes (todos executados nesta sessão)

| Suíte | Resultado |
|---|---|
| Postgres 17 descartável (`backend/testes-seguros/catalogo-pg/run.sh`): 157+158, regressão das Subways, rendimento, idempotência, isolamento, atomicidade, permissões, RLS, invalidação em cascata, constraints, rollbacks | **50/50** verificações |
| Carga **real** (payload de 282 produtos) no PG descartável, 2 rodadas | 288 insumos / 282 produtos / 1.375 linhas; 2ª rodada **0 novos**; desvio de custo banco × plano ≤ 0,006% |
| Backend novos (importador 25, custo/rendimento/homologação efetiva 14, CMV teórico 13, condições 9, proteção generalizada 7, **permissões das rotas 6**, **isolamento + homologação + PDV + detalhe do produto 16**) | **90/90** |
| Front puros novos (simulador 10, fichas 7, condições 9, CMV teórico 6, **detalhe do produto/margem por canal 7**) | **39/39** |
| **Navegador real (Chrome/Playwright)**, app inteiro com API falsa: sem aba Fichas, **Subway inalterada (lista e modal)**, **Caramelle na lista e no mesmo modal** (formação de custo, MOD separada, margem por canal), pendências, homologar/reabrir/lote, rendimento/PDV/ficha, **permissões (consulta não edita nem homologa)**, Condições comerciais, modal do simulador, CMV teórico | **14/14** |
| Testes de navegador já existentes do app (perfil de exibição, renovação) | 15/15 |
| Front completo (sem browser) | **1.797/1.797** |
| Backend completo (`test/*.test.js`) × `main` limpo | ver 4.1 |

### 4.1 Falhas preexistentes do backend (investigadas e separadas)
Medido em `main` limpo (`9df9b60`): 6.297 testes, **20 falhas**, 1 cancelado. Na branch: ver tabela final abaixo. **Nenhuma falha é da branch**; as da branch são subconjunto das de `main`:

| Grupo | Causa (evidência) | Ação |
|---|---|---|
| Central de Comunicação (conversas, não lidas, foto de perfil, visão geral, destinatários) | asserções de roster/não lidas/foto divergem; falham **idênticas** em `main` limpo | tratar em PR próprio da Comunicação |
| Guardas de numeração de migration (088, 103, 147) | asseveram "nada acima de N"/lista fechada de migrations posteriores; já falham com 148–156 em `main` (a 157/158 só aumentam a lista) | atualizar as guardas num PR separado |
| `sessao-perfil` ("fetch failed") | tenta rede real contra `127.0.0.1:9` do ambiente fictício | falha de **ambiente** |
| `checklist-operacional-service` | estouro de 120 s (suíte pesada/trava) | investigar à parte |
| `performance-calc` ("distribuições recompõem mês…") | falha conhecida de `main` | à parte |
Intermitente conhecida (`dashboard-executivo-metas-dinamicas`) oscila entre as medições.

**Suíte completa do backend, comparada com `main` limpo (mesma máquina, mesmo ambiente fictício):**

| | Testes | Passam | Falham | Cancelados | Pulados |
|---|---:|---:|---:|---:|---:|
| `main` limpo (`9df9b60`) | 6.297 | 6.251 | 20 | 1 | 25 |
| Esta branch (final) | 6.387 | 6.341 | 20 | 1 | 25 |

**Falhas novas introduzidas pela branch: 0.** O conjunto de falhas da branch é **idêntico** ao de `main` (30 nomes em comum, comparados por nome; nenhum só da branch). A falha intermitente conhecida (`dashboard-executivo-metas-dinamicas`) oscila entre as medições: passou numa e falhou noutra, nos dois lados. Os 90 testes a mais são os novos desta entrega.

## 5. Pendências que dependem da Caramelle

1. Confirmar o **custo vigente** dos 29 insumos com preços diferentes entre os arquivos (hoje há uma variante por arquivo) — basta ajustar o preço
   em Insumos; as duas versões podem ficar com o mesmo valor.
2. Informar o custo de **ÁGUA** e **TEMPERO** (e do 3º item sem preço) — destrava 31 fichas diretas + 53 em cascata.
3. Corrigir as fichas com linhas sem quantidade (13), componentes inexistentes (7) e `#N/A` (12), **ou** confirmar que ficam de fora.
4. Informar as **condições comerciais** por canal (comissão, taxas, promoções, tributos, entrega) e os **preços de venda por canal**.
5. Informar o **código do PDV** (= código do item no iFood) de cada produto vendido, ou garantir nomes idênticos e únicos.
6. Um administrador da Caramelle **homologa** as fichas conferidas.

## 6. Prontidão para produção

**Tecnicamente pronta** (código, migrations, testes e relatório) para a ativação **dos módulos Produtos (com ficha técnica e homologação), Insumos e Simulador**.
**Não pronta / fora do escopo:** Estoque e Vendas (a baixa por venda ignora rendimento); comissões das Subways (decisão sua, via pré-visualização);
CMV teórico só terá números quando os pedidos tiverem o detalhe de itens e os produtos tiverem código do PDV.
Lacunas conhecidas: não há ferramenta para **mesclar** as variantes de insumo (basta igualar os preços); a proteção de precificação do
Dashboard **ainda não reconhece vendas por canal** além do par Balcão × iFood; os testes de navegador usam API falsa (não foi feito teste ponta a ponta
contra Supabase de verdade).

## 7. Plano de ativação (cada passo exige sua autorização)

0. **Pré-requisitos:** backup/ponto de restauração do Supabase; decidir o que fazer com as comissões das Subways (rodar só o `SELECT` do `157b`).
1. **Migrations 157 → 158** (SQL Editor). Conferir: `select to_regclass('catalogo_origem'), to_regclass('canais_venda_historico');` e que `fn_custo_produto` das Subways não mudou (amostra de 5 produtos antes/depois).
2. **Deploy** backend + front (atenção: front estático não auto-deploya no Render — ver nota de memória do projeto; usar o procedimento manual).
3. **Simular** a importação (`catalogo-importar-planilhas.mjs`, sem banco) e revisar o relatório com o cliente.
4. **Importar** (`--aplicar --confirmo-escrita --org <id Caramelle> --sobrescrever-fichas` **não**), com `CATALOGO_IMPORT_CONFIRMA_HOST` igual ao host do Supabase. Conferir contagens (288 insumos, 282 produtos) e rodar a 2ª vez (deve criar 0).
5. **Habilitar módulos** pelo Painel (SuperAdmin → empresa/unidade Caramelle): `products_cmv`, `ingredients` e, se desejado, `ifood_dashboard`. **Não** habilitar `inventory` nem `sales`. Papéis: `organization_admin` para quem homologa.
6. A Caramelle cadastra **condições comerciais**, preços, códigos do PDV; resolve pendências; **homologa**.
7. Validar na tela: Fichas (contagens), Simulador (aviso parcial some após configurar), Dashboard iFood (painel).

## 8. Plano de reversão

| O quê | Como |
|---|---|
| Módulos | remover linhas de `organizacao_modulos`/`unidade_modulos` da Caramelle (Painel) |
| Importação | todo registro importado é rastreável por `catalogo_origem.importacao_id`: apagar produtos/insumos dessa importação (ordem: fichas → produtos → insumos) |
| Condições comerciais | `canais_venda_historico` guarda o "antes"; `158_rollback.sql` se nada foi gravado, senão exportar e limpar |
| Migration 158 | `158_rollback.sql` (antes da 157) |
| Migration 157 | `157_rollback.sql` (recusa se houver dados importados; limpar primeiro) |
| Código | reverter o merge; o front aceita backend sem 157/158 (colunas novas opcionais), mas `PUT rendimento`/homologação/condições respondem erro claro |

## 9. Riscos

| Risco | Mitigação |
|---|---|
| `fn_custo_produto` é compartilhada com as Subways | testes de equivalência no Postgres (custo idêntico com rendimento 1), rollback testado |
| Gatilhos em `ficha_tecnica` (custo por linha) | só atuam em produtos `homologada`; importação em lote de 1.375 linhas medida sem problema |
| Subways sem comissão cadastrada passam a ver o simulador "parcial" | `157b` lista quem é afetado **antes**; nada é semeado automaticamente |
| Homologar com custo desatualizado | invalidação automática por composição/rendimento/custo (>0,5%) |
| Dois produtos com o mesmo código do PDV | recusado (409) dentro da empresa |
| Estoque/Vendas com rendimento | **não habilitar** até `fn_baixa_estoque_venda` considerar o rendimento |
| Número da migration | reconferir no dia (hoje 157/158 livres em `origin/main`) |

## 10. Finalização antes do PR (rodada 4)

### 10.1 Preparações intermediárias: adicionar à receita (no modal de Produtos)
Botão **"Adicionar preparação"** ao lado de "Adicionar insumo" (só produtos com catálogo controlado e quem pode editar). Regras no backend (`adicionarComponente` com `subproduto_id`):
só preparação **da mesma organização** (`vendavel=false`, ativa); quantidade na **unidade do rendimento** da preparação (outras unidades compatíveis são convertidas: 0,2 kg → 200 g;
incompatível/zero/negativa recusadas); custo = quantidade × custo unitário da preparação (lote ÷ rendimento) ÷ rendimento do produto, recalculado em cascata; **recusa ciclo**
(direto, indireto e auto-referência); preparação duplicada recusada; histórico (`ficha_preparacao`) registra a inclusão. **No banco (migration 158)** o gatilho `trg_ficha_integridade`
recusa vínculo entre organizações e dependência circular por **qualquer** caminho de escrita (API, importador, SQL), e o gatilho de composição **invalida a homologação** do produto e dos que o usam.

### 10.2 Homologação em Supabase — resultado e impedimento (reportado exatamente)
* Projetos visíveis na conta: `Crescer Com Delivery` (**produção — não tocado**), `teste-multiempresarial`, `Atlaz Funil Imobiliário`, `mabruk-acai`, `financeiro-amanda` (estes três são de outros produtos/clientes).
* **Não há ambiente comprovadamente isolado e autorizado.** O único candidato, `teste-multiempresarial`, tem 30 organizações, 39 unidades, ~28 mil linhas de auditoria e dados operacionais/financeiros aparentemente reais, e uma lista de
  migrations **parcial** (só as aplicadas pelo editor de migrations; sem as 157/158). Sem confirmação de que é descartável e de que posso escrever nele, **nada foi escrito e nenhum dado foi lido além de metadados** (nomes de tabelas e de migrations).
  Criar um *branch* de banco do Supabase geraria custo e uma cópia de dados — não está autorizado.
* **O que foi feito no lugar (verificável):** (a) `backend/testes-seguros/catalogo-pg/cadeia_completa.sh` aplica `schema.sql` + **todas** as migrations do repositório em ordem num Postgres 17 descartável local e confere 157/158: aplicam por cima da cadeia completa; RLS ligado nas 4 tabelas novas;
  `anon`/`authenticated` sem acesso às tabelas e sem *execute* em `fn_catalogo_importar`; gatilhos esperados em `ficha_tecnica`; `fn_custo_produto` com rendimento; políticas RLS de produtos/insumos/ficha_tecnica/canais_venda presentes.
  Os erros da cadeia são **preexistentes e não relacionados** (schemas `storage`/`realtime` que só existem no Supabase real, sementes de dados e a cadeia financeira 120–156 que depende de objetos do ambiente real). (b) 56 verificações em PG (`run.sh`).
* **Pendência para o GO de produção:** repetir `run.sh` + um smoke test de integração (import em organização de teste, abrir produto, simulador, dashboard) num **branch/projeto Supabase de teste que você autorize explicitamente** — o roteiro já está pronto em `backend/testes-seguros/catalogo-pg/`.

### 10.3 Conferência da importação (private: `Documentos\Crescer\caramelle-fichas-simulacao\relatorio.md`)
| Pergunta | Resultado |
|---|---|
| 284 registros × 282 produtos | **284 = 182 fichas + 102 preparações.** 282 = 182 + 100. As **2 preparações a menos** são duplicatas **idênticas** (mesma composição e rendimento) entre DOCES e SALGADOS, mescladas num só cadastro — o que não confere nenhuma receita diferente. Todo registro de origem aparece como `fonte` de exatamente um produto (284 fontes mapeadas). |
| Nenhuma receita perdida | **Confirmado:** 0 registros sem produto. |
| Linhas | 1.412 de origem = 1.402 processadas + 10 das preparações mescladas (idênticas). Das 1.402: **1.375 importadas**, 7 somadas (mesmo insumo repetido na ficha), **13 sem quantidade** e **7 componentes inexistentes no cadastro** (20 **não** importadas — cada uma deixa a ficha **bloqueada/pendente** e listada; nada é inventado). |
| Preparações intermediárias | 100 preservadas como `submontagem` (13 aninhadas), com rendimento e unidade; usadas pelas fichas por vínculo. |
| Insumos sem custo | 3 permanecem **sem custo** (pendentes) e bloqueiam as fichas que os usam. |
| Variantes de preço | 19 variantes **preservadas** (`NOME` e `NOME (ARQUIVO)`), cada uma com `valores_divergentes`; nunca unificadas. |
| Carga repetida | 3 rodadas consecutivas no PG com a trava de integridade ativa: 1ª cria 282/288/1.375; 2ª e 3ª criam **0** e preservam 281 fichas. Importar em outra organização não toca na primeira. |

### 10.4 Regressão (resultados finais desta rodada)
PG 56 verificações ✔ · backend novos 99/99 (importador 27, custo/rendimento/homologação efetiva 14, CMV teórico 13, condições 9, proteção generalizada 7, permissões 6, isolamento/homologação/PDV/detalhe/**preparações** 23) ·
front puros novos 39/39 · navegador real **16/16** + 15/15 existentes · front completo **1.797/1.797** · backend completo 6.396 testes, 20 falhas = **conjunto idêntico ao de `main`** (30 nomes em comum; 0 só da branch).

### 10.5 Recomendação — **GO condicionado / NO-GO para ativar em produção**
* **GO para abrir e revisar o PR / fazer merge após revisão humana:** a mudança é **aditiva**, as migrations não alteram dado existente, as Subways ficam idênticas (testes de unidade, PG e navegador), a regressão não introduz nenhuma falha nova e não há dado privado no diff.
  Antes do merge, lembrar que o merge pode disparar o deploy do backend; o código tolera banco sem 157/158 (colunas novas opcionais; ações novas respondem erro claro), mas só funciona por completo **depois** das migrations.
* **NO-GO para a ativação da Caramelle (migrations, importação, habilitar módulos) até:** (1) smoke de integração em ambiente Supabase de teste **autorizado** (10.2); (2) decisão sobre as comissões das Subways (`157b`); (3) decisões do cliente: custo vigente dos insumos com variantes, custo dos 3 insumos sem custo, 20 linhas não importadas, condições comerciais, PDV; (4) backup antes da 157/158.
