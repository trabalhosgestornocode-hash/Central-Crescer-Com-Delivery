# Foody × Dashboard Executivo — logística própria (bloco informativo, flag desligada)

Status: **implementado só em código local, atrás de flag desligada. Não altera nenhum indicador oficial.**
Flags: `FOODY_CENTRAL_DASHBOARD_ENABLED=true` **e** unidade em `FOODY_CENTRAL_DASHBOARD_UNIDADES` (uuid, vírgula).

## 1. Diagnóstico — como o Dashboard Executivo calcula hoje

| Item | Origem | Observação |
|---|---|---|
| Faturamento | lançamento diário/mensal (`valor_vendas_ifood`, acumulado) | fonte oficial: `cards.faturamento` |
| Taxas e comissões, Serviços e promoções | lançamentos (extrato iFood) | percentuais sobre o faturamento |
| **Taxas de entregadores** | lançamento (`taxas_entregadores`) | **dedução do iFood**; só **Marketplace** (no Full Service é "não aplicável") |
| Ajustes contra a loja | lançamentos | só o ajuste contra compõe deduções |
| Total de deduções | `COMPONENTES_TOTAL_DEDUCOES` (calc.js) | por modelo logístico |
| Rentabilidade / metas / limites | `metas_indicadores`, `metasComProtecaoPrecificacao` | fonte única em `calc.js` |
| Proteção de preços | `rentabilidade.js` | conceito exclusivo do Simulador |

**O Dashboard Executivo não lê Foody nem Parser.** Hoje não existe custo de entregador *próprio* nele: "Taxas de entregadores" é o que o iFood cobra, não o que a loja paga aos próprios entregadores.

## 2. Quatro grandezas que nunca podem ser confundidas

| Grandeza | Significado | Disponível? |
|---|---|---|
| **Custo logístico atribuído** | taxa válida dos pedidos entregues por entregadores **próprios** (fechamento Foody definitivo) | sim → `custoAtribuido` |
| **Taxa prevista** | taxas dos pedidos **sem entregador identificado** — previsão, não custo | sim → `taxaPrevista` |
| **Taxa cobrada do cliente** | `taxa_entrega` paga pelo cliente | existe em `foody_pedidos`, **não** no fechamento → `null` com motivo (pendência de produto) |
| **Pagamento efetivamente conciliado** | taxa válida + lançamentos conferidos com o Excel | só o Parser concilia → `null` |

Evidência real (Subway, fechamento consolidado de 31/10): a taxa total dos pedidos é maior que o custo atribuído, porque parte dos pedidos não tem entregador próprio identificado; essa diferença aparece em `taxaPrevista`. Usar a taxa total como custo superestimaria (valores reais ficam fora do repositório público).

## 3. Onde apresentar sem duplicar

- Bloco **separado** `logisticaProprio` na resposta mensal (chave opcional, como `composicaoCanais`). Não toca cards, deduções, rentabilidade, metas, limites, projeção, diagnóstico nem proteção de preços (testes de arquitetura garantem que `calc/metas/rentabilidade/precos/diagnostico` não referenciam o bloco).
- Declara `somadoAoResultadoOficial: false` e avisa que não é "Taxas de entregadores" do iFood nem pagamento conciliado.
- Sem duplicação com Parser: o Dashboard não lê o Parser; o Parser só ganha um bloco adicional e dá prioridade ao Excel por dia.
- Sem duplicação com lançamentos manuais: o bloco nunca escreve e nunca é somado a lançamentos.

## 4. Full Service × Marketplace — proposta

- **Marketplace:** mostrar o bloco ao lado de "Taxas de entregadores" (iFood), sempre com rótulo distinto ("Entregadores próprios · Foody").
- **Full Service:** quem entrega é o iFood, então o bloco só faz sentido se a unidade tiver entregadores próprios (existir fechamento Foody definitivo). Sem fechamento: `custoAtribuido = null`, a UI não renderiza.
- **Regra de negócio pendente (não implementada, não inventada):** se o custo próprio deve entrar na **rentabilidade oficial** (e com que meta/limite). Hoje o bloco é só informativo; qualquer meta/limite nova é decisão de negócio.

## 5. Comportamento

- Flag desligada (padrão): nada é consultado; chave ausente; resposta byte a byte igual.
- Só dias **definitivos** (`CONSOLIDADO/CORRIGIDO` + valores sincronizados) entram nos valores; pendente/incompleto aparecem em `dias` e marcam `parcial: true`.
- Última versão por dia; versões antigas são histórico.
- Linha de outra organização/unidade → `erro: FONTE_FOODY_TENANT_DIVERGENTE`, sem valores. Falha de leitura → `erro: FONTE_FOODY_INDISPONIVEL`; o Dashboard nunca cai.

## 6. Pendências específicas (precisam de decisão, não de código)

1. Definir se/como o custo logístico próprio entra na rentabilidade oficial (meta, limite, status).
2. Expor `taxa_entrega` (cobrada do cliente) no fechamento — exige mudança de contrato do fechamento Foody.
3. Tela do bloco no frontend (esta entrega é só backend + testes).

## 7. Habilitação (quando decidido)

1. Merge + deploy do PR (flag segue desligada).
2. Definir `FOODY_CENTRAL_DASHBOARD_UNIDADES` com **uma** unidade e `FOODY_CENTRAL_DASHBOARD_ENABLED=true`.
3. Conferir o bloco numa leitura real; desligar a flag reverte tudo.
