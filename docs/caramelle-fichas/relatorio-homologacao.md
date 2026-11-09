# Fichas técnicas exclusivas da Caramelle Café — relatório de homologação técnica

> Branch `feat/caramelle-fichas-tecnicas` (base `9df9b60`). **Nada foi aplicado em produção.** Este documento traz só números agregados
> e metodologia: os relatórios detalhados (receitas, preços, inconsistências por ficha) contêm dados do cliente e ficam **fora do
> repositório** (`Documentos\Crescer\caramelle-fichas-simulacao\`).

## A. Diagnóstico técnico

**O catálogo já era por organização.** `insumos`, `produtos`, `canais_venda` têm `organizacao_id`; `ficha_tecnica` herda via `produto_id`;
todo serviço filtra por `req.tenant.organizacaoId`. O "Modelo A" (franquias) funciona por **clonagem** (`shared/clonarCatalogo.js`): cada
empresa recebe cópia própria, sem vínculo com a origem. Portanto o "Modelo B" (empresa independente) **não exigiu um segundo sistema**:
é a mesma estrutura, populada por carga própria em vez de clonagem.

**Acesso aos módulos** é dado, não código: `organizacao_modulos` (empresa) ∩ `unidade_modulos` (unidade), checado por `requireModulo`
(`products_cmv`, `ingredients`, `ifood_dashboard`) + `requirePermissao` por papel. **Não há nada que impeça uma empresa independente de usar
os módulos** — falta apenas a linha de habilitação, que é uma escrita em produção (fora do escopo autorizado; ver seção F).

**O que de fato impedia o uso correto por uma empresa que não é franquia Subway:**

| # | Lacuna encontrada | Efeito para a Caramelle | Tratamento |
|---|---|---|---|
| 1 | `fn_custo_produto` e `custo.js` assumiam 1 ficha = 1 unidade vendida (sem rendimento) | uma receita de 8 porções custaria o lote inteiro por unidade | coluna `produtos.rendimento` + função/JS atualizados (migration 157) |
| 2 | Sem mão de obra separada do CMV | risco de misturar MOD com CMV de ingredientes | tabela `ficha_mao_de_obra`, fora de `fn_custo_produto` |
| 3 | Sem homologação nem rastreabilidade de carga | CMV "oficial" sem conferência | `produtos.homologacao`, `catalogo_origem`, `catalogo_importacoes` |
| 4 | Simulador do front com `COMISSAO` fixa (iFood 27%, Uber 15%) | **percentuais Subway herdados em silêncio** | comissão vem de `canais_venda` da empresa; sem ela, cálculo **parcial** |
| 5 | Dashboard (proteção de precificação) usa produto de referência fixo "Churrasco 15cm" | indicador inexistente para quem não tem esse produto | **não alterado** (módulo sensível das Subways); ver "Limitações" |
| 6 | Baixa de estoque por venda (`fn_baixa_estoque_venda`) explode a ficha sem rendimento | baixa errada se Estoque/Vendas forem ligados | **não alterado**; não habilitar Estoque/Vendas para a Caramelle até alinhar |

Compatibilidade com as Subways: todas as colunas novas têm padrão neutro (`rendimento = 1`, `homologacao = 'nao_aplicavel'`). Com
rendimento 1 a nova `fn_custo_produto` devolve **exatamente** o valor da anterior (provado em Postgres, seção D).

## B. Auditoria das planilhas

Fonte: os 3 arquivos originais (`FICHAS TÉCNICAS - SALGADOS/DOCES/BEBIDAS.xlsx`, modelo "Planilha de Ficha Técnica 3.2"). Os CSVs
preliminares **não foram usados** (não estavam no ambiente e não substituem os originais). Os números preliminares do enunciado foram
**reproduzidos a partir dos originais**:

| Indicador | Resultado | Preliminar |
|---|---:|---:|
| Registros de receita (fichas + preparações) | **284** (182 fichas + 102 preparações) | 284 |
| Nomes distintos | **270** | 270 |
| Custo zerado/inválido | **12** (8 fichas + 4 preparações, todos `#N/A`/0) | 12 |
| Linhas de componente | **1.460** (1.410 de material/embalagem + 50 de mão de obra) | 1.430 |

A diferença de 30 linhas nos componentes é de **método de contagem** (o preliminar não contou as seções de embalagem/MOD das abas de
preparação): o importador lê as três seções (ingredientes/bases, embalagem, mão de obra) tanto nas fichas (`P1–P300`) quanto nas
preparações (`B1–B80`).

Por arquivo: SALGADOS 66 fichas + 23 preparações · DOCES 82 + 75 · BEBIDAS 34 + 4. Mestres: 472 linhas de ingredientes (247 insumos
distintos após unificação) e 36 de embalagens (22 distintas).

**Classificação** (regra aplicada): *insumo* = mestre `Ingredientes`/`Embalagem`; *preparação intermediária* = abas `B*` (produto não
vendável, `tipo=submontagem`); *produto final* = abas `P*`. Foram achadas **13 preparações aninhadas** (base dentro de base) — o modelo
`ficha_tecnica.subproduto_id` já suporta isso.

**Achados que exigem decisão do cliente** (nenhum foi "resolvido" por suposição):

* **29 ingredientes com valor diferente entre os arquivos.** Unificar em silêncio faria receitas de DOCES custarem até ~33% menos.
  Decisão aplicada: **uma variante por arquivo** (`INSUMO X` e `INSUMO X (DOCES)`), cada ficha mantendo o custo da sua própria
  planilha; a empresa consolida depois escolhendo o custo vigente.
* **Rótulos de unidade pouco confiáveis** (`L` com 1000 = ml; `KG` com 1800 = g). 44 inferências feitas por regra explícita + 2 casos
  ambíguos + 2 sem unidade — **todas viram pendência**, nunca silenciosas.
* **`ÁGUA`, `TEMPERO` e 1 item sem custo** bloqueiam 31 fichas diretamente e outras 53 em cascata (uso de preparação incompleta).
* 13 linhas sem quantidade, 7 componentes inexistentes no cadastro (nomes digitados diferente), 12 linhas com `#N/A`, 7 ingredientes
  repetidos na mesma ficha (somados), 6 preparações sem unidade de rendimento.
* **Nomes repetidos preservados** (nenhuma informação eliminada): 3 grupos de fichas e 3 de preparações com mesmo nome e receita
  diferente; 2 preparações idênticas entre arquivos foram mescladas.
* Nenhuma ficha usa desperdício percentual (se aparecer, o importador marca pendência — não é modelado).
* **Preço de venda** das planilhas **não é importado**: a planilha não diz de qual canal ele é. Fica em `referencia` para consulta.

**Prova de fidelidade da leitura:** para as **186 receitas comparáveis**, o custo recalculado pelo importador bate com o custo da
planilha (tolerância R$ 0,01 por unidade de rendimento): **186 conferem, 0 divergem**. As 96 restantes não são comparáveis por terem
ficha incompleta (as mesmas pendências acima). A mão de obra (inclusive a herdada de preparações) entra nessa conciliação, mas **nunca**
no CMV de ingredientes/embalagens.

## C. Implementação

**Migration 157** (`database/migrations/157_catalogo_empresa_rendimento_importacao.sql` + `157_rollback.sql`): aditiva e idempotente.
Colunas em `produtos` (`rendimento`, `unidade_rendimento`, `homologacao`, `homologado_em/por`), `fn_custo_produto` com rendimento
(trava de profundidade 12), tabelas `ficha_mao_de_obra`, `catalogo_importacoes`, `catalogo_origem` (RLS ligado, sem política: só
`service_role`) e `fn_catalogo_importar` (uma transação, lock por organização, toda escrita filtrada por `p_org`, executável só por
`service_role`). O número 157 deve ser reconferido na hora de publicar (outras branches locais também usam a faixa 15x).

**Importador** (`backend/src/modules/catalogo-importacao/`): `fichasPlanilha.parser.js` (layout do modelo + verificação de rótulos),
`catalogo.planejar.js` (puro: normalização, unidades com pendência, variantes, preparações aninhadas, ciclos, conciliação de custo),
`catalogo.importar.service.js` (aplica via RPC; cliente injetado), `catalogo.relatorio.js`.
CLI `backend/scripts/catalogo-importar-planilhas.mjs`: **simulação por padrão** (não abre conexão nem lê `.env`). A escrita exige juntas
`--aplicar --confirmo-escrita --org <uuid>` **e** `CATALOGO_IMPORT_CONFIRMA_HOST=<host do SUPABASE_URL>`.
Política de reprocessamento: insumo/produto existente **não é alterado** (a empresa pode ter editado); preço divergente só é reportado;
ficha só é reescrita se estiver vazia ou com `--sobrescrever-fichas`.

**Custo** (`produtos/custo.js`): `rendimentoDe`, custo unitário = lote ÷ rendimento (espelha o SQL), `resumoProduto` ganha
`homologacao`, `cmv_homologado_pct` e `motivo_sem_cmv_homologado`; `custoMaoDeObraUnitario` à parte. `clonarCatalogo` copia rendimento
quando existe e **não** herda homologação.

**API nova/alterada:** `GET /cmv/condicoes-comerciais` (`cmv.ver`), `PUT /produtos/:id` aceita `rendimento`/`unidade_rendimento`
(recalcula cache em cascata, auditado), `PATCH /produtos/:id/homologacao` (`configuracoes.gerenciar` — só administrador; exige ficha
íntegra), `GET /produtos/catalogo/pendencias`, `GET /dashboard-executivo/cmv-teorico` (`dashboard_executivo.ver`, escopo organização +
unidade da sessão, período ≤ 92 dias).

**Simulador** (`frontend/src/simulacaoPreco.js` + `simuladorModal.js`): comissão da empresa; componentes ausentes listados como
**não considerados**; sem comissão do canal ⇒ aviso **"Cálculo parcial"**; condições opcionais (taxas, promoções, tributos, entrega);
preço necessário para a margem desejada; comparação preço atual × simulado; descrições nos termos financeiros. `COMISSAO` fixa removida.

**CMV teórico iFood** (`dashboard-executivo/cmvTeorico.*`): usa `ifood_pedidos.items` (pedidos concluídos, não-teste). Vínculo item↔produto
**por evidência**: `externalCode` = `codigo_pdv`, ou nome idêntico e único; nome ambíguo ⇒ sem correspondência. Lista itens sem vínculo,
mede cobertura da receita, separa CMV técnico de CMV homologado, mostra margem após comissão só se a comissão estiver configurada,
sinaliza precificação desfavorável (CMV acima do limite informado ou margem negativa). Sem dados ⇒ **indisponível com motivo**.

## D. Testes (evidência de execução)

| Suíte | Comando | Resultado |
|---|---|---|
| Migration 157 em Postgres 17 descartável | `CAT_PG_DESCARTAVEL=1 bash backend/testes-seguros/catalogo-pg/run.sh` | **32/32** verificações + rollback |
| Importador (parser, planejador, travas) | `node --experimental-vm-modules --test test/catalogo-importacao.test.js` | **25/25** |
| Custo com rendimento/homologação | `… test/custo-rendimento.test.js` | **10/10** |
| CMV teórico | `… test/cmv-teorico.test.js` | **13/13** |
| Condições comerciais | `… test/cmv-condicoes.test.js` | **2/2** |
| Simulador (front, puro) | `node --test frontend/test/simulacaoPreco.test.js` | **10/10** |
| Carga **real** (payload de 282 produtos) no PG descartável, 2 rodadas | script ad hoc | 288 insumos, 282 produtos, 1.375 linhas; 2ª rodada: **0 novos**, 281 fichas preservadas; desvio de custo banco × plano ≤ **0,006%** |

O teste em Postgres cobre: regressão das Subways (custo idêntico antes/depois, linha inativa ignorada, defaults neutros), rendimento
(÷8), preparação por peso (700 g de base que rende 1.554 g), idempotência, ausência de duplicatas, isolamento entre organizações
(mesma chave/fonte em outra empresa não toca a Caramelle), atomicidade (payload inválido não deixa órfão), `anon`/`authenticated` sem
execução, RLS ligado e rollback (recusa com dados; restaura o custo das Subways).

**Regressão nos módulos compartilhados** (suíte completa do backend, `test/*.test.js`, env fictício, comparada com um worktree limpo de `main` `9df9b60`):

| | Testes | Passam | Falham | Cancelados | Pulados |
|---|---:|---:|---:|---:|---:|
| `main` limpo | 6.297 | 6.251 | 20 | 1 | 25 |
| Esta branch | 6.352 | 6.307 | 19 | 1 | 25 |

As falhas da branch são **subconjunto exato** das de `main` (29 nomes em comum, todos de Comunicação/Central, numeração da migration 088 e
`checklist-operacional-service`, que estouram o limite de tempo também em `main`). Uma falha intermitente conhecida de `main`
(`dashboard-executivo-metas-dinamicas`) passou na branch. **Falhas novas introduzidas: 0.** Front (sem testes de navegador):
**1.768/1.768**. Os testes `*.browser.test.js` e o carregamento real do modal do simulador no navegador **não foram executados** nesta
sessão (só `node --check` de sintaxe + o cálculo puro testado).

## E. Validação da Caramelle

* **Disponível quando habilitada:** Insumos, Produtos (com ficha técnica no modal), CMV (Dashboard iFood), Simulador — são os módulos existentes
  (`ingredients`, `products_cmv`, `ifood_dashboard`); a Caramelle os usa com **catálogo próprio e isolado**.
* **Importado em ambiente de teste:** sim, só em Postgres descartável local. **Nada em produção.**
* **Pendente de homologação pelo cliente:** as 282 fichas nascem `pendente`; 176 estão íntegras e podem ser homologadas por um
  administrador, 106 dependem de correções (seção B). CMV "homologado" só existe depois disso.
* **Falta definir/configurar:** comissão e demais condições comerciais da Caramelle por canal (`canais_venda` — hoje não existe tela de
  cadastro; ver "Limitações"), preços de venda por canal, vínculo dos itens do iFood (`codigo_pdv`), custo de `ÁGUA`/`TEMPERO`.

## F. Produção — o que será necessário (nada disso foi feito)

Ordem sugerida (cada passo exige sua aprovação):

1. **Backup/ponto de restauração** do Supabase.
2. **Aplicar a migration 157** (aditiva, segura para as Subways). Reversão: `157_rollback.sql` (recusa se já houver dados importados).
3. **Pré-visualizar** `database/ops/157b_canais_venda_subway_PREVIEW.sql`; se houver Subways sem comissão cadastrada, semear **só** elas
   (decisão sua) — caso contrário o Simulador delas mostrará "cálculo parcial" até cadastrar.
4. **Deploy** do backend e do front (o front ainda aceita backend sem a 157; o contrário não vale para `PUT rendimento`/homologação).
5. **Importar** a Caramelle: simulação → revisão do relatório → `--aplicar` com `--org <id>` e host confirmado. Reversão: apagar por
   `catalogo_origem` da `importacao_id` (mesmo `fonte`), pois toda linha importada é rastreável.
6. **Habilitar módulos** (`organizacao_modulos` + `unidade_modulos`) e papéis para os usuários autorizados da Caramelle.
7. Conferir e **homologar** as fichas pelo administrador da Caramelle.

Riscos: (i) 157 mexe em `fn_custo_produto` — mitigado por teste de equivalência e rollback; (ii) comissões das Subways (passo 3);
(iii) preços divergentes entre planilhas exigem decisão do cliente antes de homologar; (iv) não ligar Estoque/Vendas para a Caramelle.

## Decisões que dependem de você (com a opção tecnicamente mais segura)

| # | Decisão | Opções | Recomendação |
|---|---|---|---|
| D1 | Qual é o custo **vigente** dos 29 ingredientes com valores diferentes entre os 3 arquivos | (a) manter uma variante por arquivo e consolidar na UI; (b) o cliente informa a lista vigente; (c) usar o do arquivo mais novo | **(a) agora** (já implementado, nenhum CMV é subestimado), depois **(b)** |
| D2 | `ÁGUA` e `TEMPERO` (e 1 item) sem custo | (a) cliente informa custo (mesmo simbólico, ex. tarifa de água); (b) manter "sem custo" e a ficha pendente | **(a)** — destrava 31 fichas diretas + 53 em cascata |
| D3 | Preço de venda das planilhas (de qual canal?) | (a) cliente informa o canal e importamos em `produto_precos`; (b) cadastrar manualmente | **(a)**, após confirmar o canal |
| D4 | Condições comerciais da Caramelle (comissão por canal, tributos, taxas, entrega) | cliente envia a tabela; cadastrar em `canais_venda` | cadastrar **somente** o que o cliente validar; sem tela hoje (SQL ou nova tela) |
| D5 | Subways sem comissão cadastrada: semear? | usar `157b_canais_venda_subway_PREVIEW.sql` (lista antes) | rodar **só a pré-visualização** primeiro |
| D6 | Numeração da migration (157) | renumerar na publicação se houver colisão com outras branches | conferir no dia |
| D7 | Próxima etapa de interface | campos de rendimento/homologação em Produtos, tela de pendências, painel do CMV teórico no Dashboard iFood | priorizar **pendências + homologação** (sem elas o CMV homologado não existe) |

## Limitações conhecidas (honestas)

* Não existe tela para cadastrar `canais_venda` (comissão por canal) — hoje é dado de banco. Sem ela, o simulador da Caramelle opera
  em modo parcial até alguém inserir as linhas (SQL ou futura tela de Configurações).
* O Dashboard iFood **não** ganhou aba/tela do CMV teórico nesta entrega: o endpoint e o cálculo estão prontos e testados; a
  visualização no front é a próxima etapa.
* A "proteção de precificação" do Dashboard continua baseada no produto de referência fixo; para a Caramelle ela segue indisponível.
* `ifood_pedidos.items` só existe para pedidos cujos detalhes foram buscados; sem isso o indicador fica "indisponível" (motivo explícito).
* A tela atual de Produtos/Insumos já exibe fichas e custos, mas **não** tem campos para rendimento e homologação (a API tem); sem
  eles na UI, a edição fica por API até a próxima etapa.
