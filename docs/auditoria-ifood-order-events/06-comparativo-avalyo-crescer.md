# 06 — Comparativo funcional: relatório semanal Avalyo.AI × Crescer

> Referência: a lista das 12 seções do relatório semanal da Avalyo fornecida na missão. **Não** tivemos acesso ao relatório, a amostras nem à documentação da Avalyo. Por isso este documento **não** afirma quais APIs ela usa: compara apenas **o que a Crescer consegue produzir** para cada seção e com qual fonte oficial.
>
> Classes:
> - **PRONTO** — produzimos hoje;
> - **PARCIAL** — produzimos parte, ou o dado existe e falta calcular/exibir;
> - **DEPENDÊNCIA** — exige outro módulo oficial do iFood ou uma regra interna;
> - **INDISPONÍVEL** — sem fonte conhecida.
>
> Esforço: P (≤ 3 dias), M (1–2 semanas), G (> 2 semanas).

| # | Seção da Avalyo | Já produzimos | Parcial / dado existente | Analytics | Review | Financial | Regras internas | Não obtível hoje | Fonte oficial necessária | Classe | Esforço |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Análise de desempenho | Checklist: tempos, metas, atrasos, comparação entre períodos e análises determinísticas (`checklistOperacional.analises.js`); Dashboard Executivo: faturamento e metas a partir de lançamentos/Parser | Consolidado semanal multiunidade; a junção dos dois mundos (tempos de Events + faturamento de Dashboard) não existe | KPIs D-1 agregados (opcional) | — | Resultado real | Definir o "desempenho" (quais KPIs, pesos) | — | Order/Events (já temos) | **PARCIAL** | M |
| 2 | Resumo de pedidos e faturamento | Contagem de pedidos (Checklist) | GMV operacional, ticket médio e subtotal estão em colunas, mas sem tela | Opcional (para histórico pré-Events) | — | **Sim**, para faturamento líquido/repasse | Rotular "operacional" × "financeiro" | — | Order Details (já temos) + Financial | **PARCIAL** | P (operacional) / M (com Financial) |
| 3 | Avaliações positivas e negativas | — | — | — | **Sim** | — | — | Sem a Review API | Review (`/review/v2.0/...`, [DOC] Review › Introdução) | **DEPENDÊNCIA** | M (+ app/escopo e homologação Review) |
| 4 | Faturamento por dia | Dashboard iFood (lançamento manual/Parser, D-1) | Por dia a partir de `total_order_amount` (operacional, tempo real) | — | — | Para o valor contábil | Escolher a régua do dia (PLC × conclusão) | — | Order (já temos) | **PARCIAL** | P |
| 5 | Cancelamentos por motivo, origem e estágio | Contagem de cancelados (Checklist); o Agente lista cancelamentos do **Parser** (CSV) | Motivo, origem, estágio e ocorrência financeira estão **no bruto** do CAN (98 eventos) | — | — | Valor estornado/cobrado | Agrupar códigos; nunca traduzir o motivo oficial | — | Events (já temos) | **PARCIAL → PRONTO com extração** | P |
| 6 | Tempos de preparo e entrega | **PRONTO** (Checklist: preparo PLC→DSP, entrega DSP→CON, vida, metas, atrasos, horários) | Decompor "cozinha × espera do entregador" com RTP/AAO/CLT (bruto) | — | — | — | Régua pronta; decidir a decomposição | Tempo físico de cozinha (PRS é marcação do PDV) | Events (já temos) | **PRONTO** (+ decomposição PARCIAL) | P |
| 7 | Promoções e incentivos | Card "Serviços e Promoções" do Dashboard iFood (lançamento manual) | Por pedido: patrocinador (loja/iFood/rede/externo), alvo e campanha — 100% consistente [BD] | — | — | Valor efetivamente repassado | Regras anti-dupla contagem (05 §5) | ROI/causalidade de campanha | Order Details (já temos) | **PARCIAL** | P–M |
| 8 | Clientes novos e recorrentes | — | `ordersCountOnMerchant` (100% presente) e `customer.id` | KPIs agregados (talvez) | — | — | Definir novo × recorrente (dois conceitos, ver 05 §1) e LGPD | Base de clientes fora do iFood | Order Details (já temos) | **PARCIAL** | P |
| 9 | Chamados e disputas | Disputas persistidas (`ifood_disputas`, 170) | Sem tela; 66 sem HSD; desfecho disponível | — | — | Reembolso efetivo | Classificar desfecho | **Chamados de suporte** (fora do Handshake): sem API identificada | Order › Plataforma de negociação (já temos) | **PARCIAL** (disputas) / **INDISPONÍVEL** (chamados) | P |
| 10 | Critérios do Super Restaurante | — | Proxies: taxa de cancelamento atribuída à loja, tempos, disputas | — | Nota (Review) | — | Os critérios oficiais mudam e não temos a regra vigente | Status oficial do selo | **Nenhuma fonte identificada** (NÃO VERIFICADO) | **INDISPONÍVEL** (proxies: PARCIAL) | — |
| 11 | NPS, avaliações e comentários | — | — | — | **Sim** (nota, comentários) | — | NPS próprio exigiria pesquisa nossa | NPS oficial do iFood | Review | **DEPENDÊNCIA** | M |
| 12 | Recomendações de melhorias | Checklist: análises com "constatação / hipótese / recomendação" e evidências; Diagnóstico + Plano de Ação do Dashboard Executivo; Agente Crescer (somente leitura, tools controladas) | Unificar o motor: Events → Diagnóstico | — | Enriquece | Enriquece | Biblioteca de recomendações aprovadas | — | — | **PARCIAL** (motor existe; fontes separadas) | M |

## Resumo

| Classe | Seções |
|---|---|
| PRONTO | 6 (tempos) |
| PARCIAL, viável **sem nova API** | 1, 2 (operacional), 4, 5, 7, 8, 9 (disputas), 12 |
| DEPENDÊNCIA | 3 e 11 (Review), 2 e 7 para o valor financeiro (Financial) |
| INDISPONÍVEL | 10 (selo oficial), 9 (chamados fora do Handshake) |

**Viáveis com a infraestrutura atual: 9 das 12 seções** (1, 2, 4, 5, 6, 7, 8, 9-disputas, 12), sendo 1 já pronta. As seções 3 e 11 exigem a Review API. A 10 não tem fonte conhecida.

## Cuidados de conceito (para não repetir erros comuns em relatórios desse tipo)

1. **Operacional × financeiro:** `orderAmount` é o que o cliente pagou, não o que a loja recebe. Um relatório que soma `orderAmount` e chama isso de "faturamento" diverge do extrato. Sempre rotular "faturamento operacional (iFood, bruto)" e, quando houver Financial, mostrar os dois lado a lado.
2. **Campanhas:** somar `sponsorshipValues` (nunca `value` + patrocinadores); custo da loja = MERCHANT (+ CHAIN cobrado); pedidos promocionais = pedidos distintos (05 §5).
3. **Novos × recorrentes:** "novo na loja" (iFood, 5 anos) ≠ "primeiro pedido que vimos". Não somar nem comparar os dois. `segmentation` é confidencial [DOC] e não deve aparecer em relatório.
4. **Conclusão ≠ entrega:** o CON pode ser timeout [DOC].
5. **Dia do pedido:** o Checklist usa o dia do PLC; o Dashboard iFood usa a data do lançamento/CSV. Num relatório que junta os dois, declarar a régua.
6. **Cancelamento pós-conclusão:** pode ocorrer até 15 dias depois ([DOC] Analytics). Um relatório semanal "fechado" pode mudar; registrar a data de corte.
