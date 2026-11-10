# Automação Foody → Parser e Açaí no Grau — diagnóstico, correção e implantação

**Data:** 10/11/2026 · **Branch:** `feat/parser-consome-foody-automatico` · **Situação:** implementado e testado localmente; leitura real comprovada; **nada publicado**.

## 1. Diagnóstico com evidência (produção, somente leitura)

| Componente | Desenvolvido | Executando? | Fonte | Última execução | Recebidos / persistidos | Aparece no frontend? | Impedimento |
|---|---|---|---|---|---|---|---|
| Agendador Foody (worker embutido) | Sim (147–150) | **Sim**, 105 execuções agendadas desde 05/11, 0 erros | API Foody 1.2, só GET | 10/11 13:26Z (ciclo D-1..D-3) | 1.154 pedidos em `foody_pedidos` (31/10–09/11); 124/163/133 recebidos em 09, 08 e 07/11, todos inalterados na repetição (idempotente) | Não no Parser | — |
| Fechamentos logísticos | Sim | Sim | `foody_pedidos` | 10/11 04:32Z | 28 versões; Subway e Açaí por dia | Só nos blocos com flag | 5 dias PRELIMINAR por `TRIAGEM_PENDENTE` (2–6 pedidos/dia) |
| Distribuição Subway → Açaí | Sim (148) | Sim | Conexão compartilhada | — | 258 pedidos do Açaí na unidade Açaí | Não | — |
| **Parser Food Delivery** | Sim | Sim, mas **só lê planilhas** | `parser_fd_pedidos` ⨝ `parser_fd_importacoes` | Subway: importação manual 10/11 18:01Z | Subway: 79 importações; **Açaí: 0** | Subway sim; **Açaí vazio** | **Causa raiz:** `analisarPeriodo` nunca lia `foody_pedidos`. A ponte existente (`parserFoodDelivery.foody.js`) só adiciona um bloco informativo e declara "nunca altera pedidos" |
| Açaí — iFood | Integração existe para outras lojas | **Não para o Açaí** | — | — | 0 conexões, 0 vínculos de loja, 0 pedidos, 0 eventos | — | **Loja iFood do Açaí não conectada** (autenticação humana) |
| Açaí — SAIPOS / Anota AI | Só importação de arquivo | — | Planilhas | — | `vendas`/`importacoes_vendas`: 0; `fin_vendas_canal`: 3 | — | Não há cliente de API no projeto; nenhuma credencial ou documentação de API autorizada |
| Resumo Diário Operacional | Sim | Sim (informado pelo proprietário) | — | — | — | — | **Intocado** por esta mudança |

Webhook Foody: não existe no projeto e não foi validado na documentação oficial; a coleta é por polling a cada 6 h, cobrindo D-1 a D-3 (reprocesso) e reconciliação de 35 dias.

## 2. Correção

`backend/src/modules/parser-food-delivery/parserFoodDelivery.foodyPedidos.js` (novo) + `analisarPeriodo` em `parserFoodDelivery.service.js`:

- **Somente leitura.** Não cria importação sintética nem copia pedidos. Lê `parser_fd_importacoes`, `foody_conexao_destinos` e `foody_pedidos`.
- **Uma fonte por dia.** Dia coberto pelo período de qualquer planilha concluída usa **só a planilha**. A Foody preenche os demais dias. Não há duplicidade.
- **Operação própria.** Unidade destino ATIVA de uma conexão compartilhada (Açaí) concilia os próprios pedidos; as demais unidades continuam Subway.
- **Campos ausentes = null.** Chegada para entrega, distância e origem não vêm da API e nunca viram zero.
- **Isolamento.** Filtro por organização e unidade em todas as consultas, conferido linha a linha (`FONTE_FOODY_TENANT_DIVERGENTE`).
- **Falha não derruba o Parser.** O retorno `fonteFoodyPedidos.erro` informa a falha, e a planilha segue funcionando.
- **Flag fail-closed:** `FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED=true` + `FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES` (uuid, vírgula). Desligada, a resposta fica idêntica.
- **Frontend:** a distribuição usa os rótulos da operação própria e a fonte aparece como "Foody Delivery — sincronização automática".

## 3. Matriz campo a campo (API Foody × Parser)

| Campo do Parser | Fonte | Via API? | Transformação | Destino | Status |
|---|---|---|---|---|---|
| Nº do pedido | `id` | Sim | texto | `numeroPedido` | OK |
| Data e hora | `date` | Sim | parede -03:00 → `...Z` (convenção do Parser) | `dataHora` | OK |
| Situação | `status` | Sim | `closed/cancelled/delivered/ready` → vocabulário do relatório | `situacao` | OK |
| Entregador | `courier.courierName` | Sim | **hash** na sincronização → rótulo "Entregador Foody xxxxxx" | `entregador` | Parcial: o nome não é armazenado |
| Taxa do entregador | `courierFee` | Sim | número; só conta com entregador | `taxaEntregador` | OK |
| Valor total | `orderTotal` | Sim | número | `valorTotalPedido` | OK |
| Forma de pagamento | `paymentMethod` | Sim | catálogo | `formaPagamento` | OK |
| Detalhes / operação | `orderDetails` | Sim | catálogo de operação + triagem | `operacao` | OK (triagem → revisão) |
| Aceito, pronto, despacho, coleta, entrega, finalizado, cancelado, prazo | campos de data (5 não documentados) | Sim | parede | timeline | OK |
| Razão / justificativa de cancelamento | `cancellationReason/Text` | Sim | código → texto (2 códigos vistos) | cancelamento | OK com catálogo |
| Chegada para entrega | — | **Não** | null | `dataChegadaEntrega` | Lacuna: o motor usa a regra de coleta, com a mesma decisão |
| Distância (raio/rota) | — | **Não** | null | distância | Lacuna: continua só pela planilha |
| Origem/canal | — | **Não** | `foody_api` | `origem` | Lacuna: só proveniência |

## 4. Prova com dados reais (leitura em produção, flag ligada só no processo local)

| Unidade | Período | Fonte | Pedidos | Elegíveis | Entregues | Cancelados (recebem) | Taxas válidas | Entregadores |
|---|---|---|---|---|---|---|---|---|
| Açaí no Grau | 31/10–10/11 | Foody (10 dias, 0 com planilha) | 258 | 240 | 239 | 1 (1) | **R$ 2.161,00** | 7 |
| Subway | 01–10/11 | Planilha nos 9 dias; Foody 0 | 1.014 | 517 | 514 | 3 (3) | R$ 4.793,00 | 8 |

Reconciliação independente: a soma das taxas válidas dos 10 fechamentos logísticos do Açaí (144+149+249+192+212+173+211+271+333+227) é **R$ 2.161,00**, igual ao Parser. A Subway prova que não houve duplicidade, porque todos os dias com planilha ficaram fora da Foody.

## 5. Testes

- `test/parser-foody-pedidos.test.js` (novo): flag/allowlist, uma fonte por dia, tenant divergente, erros de leitura, operação ambígua, operação própria, campos null e estrutural (só leitura, sem import de `modules/foody`).
- Regressão Foody + Parser + Dashboard logística: **466/468 aprovados, 1 pulado e 1 falha pré-existente**. A falha está em `foody-central-arquitetura` › "migration 147 — estático": a lista fixa não inclui as migrations 156–158 de outras frentes e não tem relação com esta mudança.
- Fora do escopo desta prova: execução publicada, dashboard no navegador logado e sincronizações consecutivas observadas **após** a publicação.

## 6. Implantação (exige autorização)

1. Push da branch, PR e merge na `main` (auto-deploy do backend).
2. No Render, `crescercomdelivery`: `FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED=true` e `FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES=<uuid do Açaí no Grau Saci>`. Começar só pelo Açaí; a Subway entra depois, se quiser dispensar a planilha diária.
3. Validar logado no Parser do Açaí, período "Este mês", e conferir com o fechamento logístico.
4. **Reversão:** remover a flag (efeito imediato após o restart). Não há migration nem dado gravado.

Nenhuma migration é necessária.

## 7. Pendências reais (não declaradas como concluídas)

| Item | Tipo | O que falta |
|---|---|---|
| iFood do Açaí | Autenticação humana | Conectar a loja iFood do Açaí na tela de integrações (OAuth/credencial do proprietário). Sem isso, nenhum dado iFood chega |
| SAIPOS / Anota AI do Açaí | Fonte externa | Não há API autorizada no projeto; segue a importação de arquivo. Para automatizar, é preciso documentação oficial e credencial de cada fornecedor |
| Dia corrente (D0) | Decisão técnica | O agendador cobre D-1..D-3 a cada 6 h. "Hoje" só aparece no dia seguinte. Incluir D0 muda a coleta e exige aprovação |
| Triagem pendente | Decisão humana | Pedidos em `TRIAGEM_PENDENTE` (2–6/dia) deixam os fechamentos PRELIMINAR; no Parser aparecem como "Operação indefinida" |
| Nome do entregador | Decisão de privacidade | A sincronização guarda só o hash; o pagamento por entregador pelo Parser exige decidir se o nome pode ser armazenado |
| Central de Sincronização (Fase 5) | Não iniciada | A tela de integrações Foody já mostra conexão e execuções; o painel unificado por fonte/unidade com os estados pedidos fica para a próxima etapa |
| Fechamento de setembro do Açaí (R$ 83.183,38) | Referência | Não usado na sincronização; dados homologados intocados |
