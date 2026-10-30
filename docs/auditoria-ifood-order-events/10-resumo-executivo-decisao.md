# 10 — Resumo executivo e matriz de decisão

## 1. Situação real da integração (29/10/2026)

- O **Events está ligado em produção desde 10/10/2026** e recebe continuamente: **51.331 eventos** e **4.549 pedidos** de **3 unidades** (5 merchants). Fila saudável: 0 falhas, 0 pendentes, 0 quarentena, 0 desconhecidos.
- **100% dos pedidos têm Order Details**, buscados com mediana de 2,6 s após o PLC.
- A Crescer é **observadora**: não confirma, não despacha, não cancela, não responde disputas (0 ações). Quem opera é o PDV/Gestor. O código para agir existe e está testado, mas não tem rota.
- **Nenhum dado recebido é descartado**: eventos e Details ficam integrais no banco. Hoje só **6 de 29** tipos de evento observados alimentam alguma tela (o Checklist Operacional). O resto está guardado e sem uso.

## 2. Respostas aos critérios de conclusão

| Pergunta | Resposta | Denominador / escopo |
|---|---|---|
| Quantos tipos de eventos oficiais se aplicam? | **23** | 25 da referência rápida oficial [DOC] − SPS/SPE (só GROCERY). Mais **11** códigos fora dela que chegam de fato (total operacional: 34) |
| Quantos nosso código reconhece? | **25/25** oficiais; **48** no catálogo; **29/29** observados | `ifoodEvents.parser.js:40-81` |
| Quantos realmente recebemos? | **29 códigos distintos** (51.331 eventos) | Produção, 10/10–30/10, 3 unidades |
| Quantos são persistidos? | **29/29** no bruto integral; **9** estruturados (PLC, CFM, RTP, DSP, CON, CAN, CARF, HSD, HSS) | `ifood_eventos`, `ifood_pedidos`, `ifood_disputas` |
| Quantos são utilizados? | **6** (PLC, CFM, RTP, DSP, CON, CAN), pelo Checklist | `checklistOperacional.repository.js:12-16` |
| Quais campos de Order Details estão disponíveis? | Todos os grupos documentados chegam, exceto `extraInfo`, `additionalInfo`, `delivery.observations`, `schedule`, `dineIn`, `ean`/`scalePrices` (não retornados no cenário atual). Matriz completa em [03](03-dicionario-dados-pedidos.md) | 4.543 payloads |
| Quais dados perdemos? | **Nenhum campo é descartado.** Perdas estruturais: Details não atualizado após `ORDER_PATCHED` (14 pedidos); horário do CON quando há cancelamento posterior (6); logística, motivos de cancelamento, recorrência, campanhas e itens só em JSON | [04 §2](04-auditoria-banco-persistencia.md) |
| Quais indicadores já podemos calcular? | **Prontos:** pedidos por dia/hora/semana, preparo/entrega/vida, atrasos vs meta, comparação entre períodos. **Dado pronto:** GMV operacional, ticket, taxa de cancelamento, valor cancelado, promoções por patrocinador, iFood × própria. **Dado bruto:** produtos/adicionais, novos × recorrentes, motivos/origem/estágio de cancelamento, espera do entregador, atraso vs previsão, disputas | [05](05-catalogo-indicadores.md) |
| Quais dependem de fontes externas? | Avaliações/nota/comentários/NPS (**Review**); repasse/taxas/estornos efetivos (**Financial**); histórico anterior à ativação (Analytics ou Parser); Super Restaurante e chamados (**sem fonte conhecida**) | — |
| Funcionalidades semelhantes à Avalyo viáveis? | **9 de 12** seções sem nova API (1 já pronta: tempos); 2 dependem da Review; 1 sem fonte (selo Super Restaurante) | [06](06-comparativo-avalyo-crescer.md) |
| Alertas de WhatsApp implementáveis já? | Disputa aberta, integração parada (grupo interno), atrasos agregados vs meta, cancelamentos agrupados, resumo diário e semanal | [07](07-plano-automacao-whatsapp.md) |
| O que exige nova autorização/homologação? | Review, Financial (em andamento), Analytics, webhook, WhatsApp oficial e, possivelmente, agir sobre pedidos pela Central | [09](09-arquitetura-roadmap.md) |
| Arquitetura de melhor aproveitamento? | `ifood_eventos` como event store → **projetor assíncrono** para uma camada derivada sem PII → Checklist (indicadores) → detector (níveis 1/2) com achados persistidos → comunicação (WhatsApp) e Agente (IA), **sem tocar no poller nem no ACK** | [09 §2](09-arquitetura-roadmap.md) |

## 3. Capacidade atual (já captamos e já analisamos)

**Captamos:** a linha do tempo completa do pedido (PLC, CFM, PRS, RTP, ADR, GTO, AAO, CLT, DSP, AAD, DDCS, CON e CAN); itens e complementos com código do PDV; valores com fechamento 100% consistente; patrocínio de descontos (loja R$ 29,3 mil, iFood R$ 26,8 mil no período); pagamento; logística (iFood 1.842 / própria 2.667); recorrência (`ordersCountOnMerchant`); cancelamentos com motivo, origem e estágio; disputas com tipo e desfecho; ajustes de tempo pelo iFood (CPT).

**Analisamos hoje:** tempos operacionais, metas, atrasos, comparações e análises determinísticas e estatísticas (Checklist), consultáveis pelo Agente Crescer.

## 4. Lacunas

- 59,5% dos eventos e a maior parte do Details sem uso.
- Sem acompanhamento de achados e ações.
- Sem alerta operacional (o WhatsApp só conhece a pendência D-1).
- Sem consolidado multiunidade.
- Sem retenção nem anonimização (LGPD).
- Grants excessivos herdados.
- Disputas sem tela, 33% expiradas.
- Sem Review.
- Financial ainda não homologado.

## 5. Oportunidades imediatas (sem novas APIs)

1. Relatório diário e semanal por loja (operacional) com o motor do Checklist.
2. Alerta de **disputa aberta**: 56 de 170 disputas expiraram sem resposta.
3. Alerta interno de **integração parada**.
4. Cancelamentos por motivo, origem e estágio, e promoções por patrocinador, no Checklist.
5. Novos × recorrentes (definição explícita).

## 6. Expansões (integrações adicionais)

- Review (avaliações/NPS).
- Financial (valor líquido; homologação em andamento).
- Analytics (histórico e KPIs D-1, opcional).
- WhatsApp Business Platform (escala do canal).

## 7. Riscos

| Risco | Tipo | Severidade | Mitigação |
|---|---|---|---|
| Dados pessoais de clientes e entregadores sem retenção (S-2) | LGPD | **Alta** (cresce com cada loja) | E0: retenção + anonimização antes de escalar |
| Grants `anon/authenticated` com TRUNCATE nas tabelas iFood (S-1) | Segurança | Média (sem vetor PostgREST) | Migration de REVOKE |
| Banimento do número (Baileys) com mais alertas | Operação | Alta | Agrupamento, orçamento por categoria, SIMULACAO, avaliação da API oficial |
| Confundir faturamento operacional com financeiro | Dados | Média | Rótulos e as regras de 05/06 |
| Mexer no poller/ACK ao evoluir | Homologação | Alta | Projetor fora do ciclo; poller intocado |
| Agir sobre pedidos em paralelo ao PDV | Operação/homologação | Alta | Manter observador (E11 só por decisão explícita) |
| 118 eventos sem carimbo de ACK, causa desconhecida | Observabilidade | Baixa | Ler os logs do Render de 29/10 07:40Z (o acesso desta sessão foi negado) |

## 8. Matriz de decisão (somente decisões materiais)

| # | Decisão | Opções | Recomendação | Bloqueia |
|---|---|---|---|---|
| D1 | Prazo de retenção do bruto (eventos + Details) e anonimização de PII | 30 / 90 / 180 dias; anonimizar ao concluir | **90 dias de bruto; anonimizar cliente, entregador e códigos 24 h após a conclusão; agregados sem prazo** | E0, E3, expansão de lojas |
| D2 | Aplicar o REVOKE de `anon/authenticated` nas tabelas iFood | sim / não | **Sim** (migration aditiva só de REVOKE, com o mesmo pré-voo das anteriores) | E0 |
| D3 | Escopo do primeiro piloto de alertas WhatsApp | (a) só grupo interno; (b) gerentes de 1–3 lojas com opt-in | **(a) por 1 semana em SIMULACAO, depois (b)** com disputa aberta + resumo diário | E2 |
| D4 | Orçamento de mensagens por loja/dia no Baileys | manter 3/contato/dia; ampliar | **Manter e agrupar** até haver decisão sobre a API oficial | E2 |
| D5 | Definição oficial de "cliente novo" e "recorrente" | iFood (`ordersCountOnMerchant`) ou observado por nós | **Usar o do iFood como oficial**; o observado só como complemento rotulado | E1 |
| D6 | Seguir com a camada derivada (projetor) | agora (E3) / depois do piloto E1 | **Depois de E1/E2**: provar valor com consultas diretas e então estruturar | E3 |
| D7 | Review API | iniciar app/homologação / adiar | **Iniciar em paralelo** (2 das 12 seções da Avalyo dependem dela) | E6 |

## Verificações executadas

| Verificação | Resultado |
|---|---|
| Worktree de documentação a partir de `origin/main` `a035750` | Criado: `crescer-auditoria-order-events`, branch `docs/auditoria-ifood-order-events`, **sem commit** |
| Graphify (navegação inicial) | `graphify query` para Events/Order, ações, Checklist, WhatsApp e Agente |
| Leitura de código (módulo iFood, worker-ifood, checklist-operacional, comunicacao, agente, diagnóstico) | Feita (citações nos documentos) |
| Migrations 101, 102, 103, 127 e 128 | Lidas |
| Suítes locais iFood Order/Events/Handshake/Checklist (27 arquivos, sem as `-pg`), env fictício, sem rede/`.env` | **554/555 ok** no lote; 1 arquivo (`checklist-operacional-service.test.js`) **cancelado por timeout de 120 s** sob carga e **40/40 ok** quando rodado sozinho (155 s); 1 suíte de integração pulada por desenho (alvo não confirmado como teste). Log local (fora do repositório): `C:\Users\ponte\AppData\Local\Temp\claude\C--Users-ponte-OneDrive-Desktop-crescer-com-delivery\e0130e83-9181-4ca7-bdb4-cc6910539a07\scratchpad\testes-order-events.log` |
| Junção temporária de `node_modules` no worktree | Criada para os testes e **removida** (`rmdir`) em seguida; o original continua intacto |
| Banco de produção | 16 consultas `SELECT` agregadas (lista no [apêndice de 04](04-auditoria-banco-persistencia.md#apêndice--consultas-executadas)); nenhum dado pessoal transcrito |
| Documentação oficial iFood | Order › Eventos de pedido; Order › Detalhes de pedido; Events › Introdução; Review › Introdução; Analytics › Introdução (Chrome, só leitura; aba fechada) |
| Logs do Render | **NÃO VERIFICADO**: `cannot access workspace … forbidden` |
| Variáveis de ambiente (flags) | **NÃO VERIFICADO**: sem acesso; estado inferido pelos dados |
| Testes `-pg` (Postgres real) | **NÃO EXECUTADOS**: exigem banco descartável |
| Relatório da Avalyo | **NÃO DISPONÍVEL**: comparação feita pela lista de seções da missão |
