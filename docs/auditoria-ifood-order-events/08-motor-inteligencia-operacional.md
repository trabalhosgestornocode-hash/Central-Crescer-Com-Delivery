# 08 — Motor de inteligência operacional

Objetivo: **Evento → Indicador → Detecção → Diagnóstico → Recomendação → Notificação → Acompanhamento**, reaproveitando o que existe e sem criar um dashboard desconectado.

## 1. Peças existentes e onde cada uma se encaixa

| Etapa | Peça existente | Arquivo | Estado | Lacuna |
|---|---|---|---|---|
| Evento | Events + Order Details | `ifoodEvents.*`, `ifoodOrder.*` | Em produção | 59,5% dos eventos ficam só no bruto (02) |
| Indicador | Checklist Operacional: medições por pedido e agregados por período | `checklistOperacional.calc.js`, `checklistOperacional.indicadores.js` (`montarDashboard`) | Em produção | Só tempos e contagens; sem valores, cancelamento por motivo, promoções, recorrência, logística decomposta |
| Indicador | Dashboard Executivo: faturamento, metas, rentabilidade | `dashboard-executivo/*` | Em produção | Fonte = lançamentos e Parser (D-1), **não** Events |
| Detecção — nível 1 | Análises determinísticas do Checklist (concentração por horário, dias críticos, etapa, contra a meta) | `checklistOperacional.analises.js:16-31` (`LIMIARES`) | Em produção | Roda sob demanda (tela/PDF); não persiste nem dispara |
| Detecção — nível 2 | Do mesmo arquivo: piora/melhora entre períodos (amostra mínima), **anomalia por mediana + MAD**, reincidência por horário em vários dias | idem (`anomFatorMad`, `reincMinDias`) | Em produção | Idem |
| Diagnóstico + Plano | Motor de Diagnóstico + Plano de Ação do Dashboard Executivo (ids estáveis; CRITICAL/WARNING/HEALTHY/DATA_PENDING; "só afirma o que os dados sustentam") | `dashboardExecutivo.diagnostico.js:1-45` | Em produção | Só sobre dados financeiros/metas do Dashboard; não recebe achados operacionais |
| Recomendação | Checklist separa **constatação / hipótese / recomendação** com evidências | `checklistOperacional.analises.js:1-10` | Em produção | Biblioteca de recomendações fixa no código |
| IA (nível 3) | Agente Crescer: somente leitura, tools controladas, "código calcula, Claude explica" | `docs/agente-crescer.md`; tool `consultar_checklist_operacional` | Em produção | Não gera relatório periódico; responde a perguntas |
| Notificação | Pipeline de comunicação (alerta → política → WhatsApp) | `comunicacao.*` | Em produção (1 tipo) | Ver 07 |
| Acompanhamento | — | — | **AUSENTE** | Não foi encontrada persistência de achados/ações com estado (aberto → em tratamento → resolvido/persistente). O Plano de Ação é recalculado a cada leitura |

Conclusão: **o motor já existe em pedaços.** Falta (a) alimentá-lo com mais fatos dos Events, (b) rodar a detecção em segundo plano e persistir os achados, (c) fechar o ciclo de acompanhamento.

## 2. Modelo em três níveis

### Nível 1 — Determinístico (regras e limites configurados)

Regra = `(indicador, recorte, comparador, limite, amostra mínima, severidade)`. Exemplos com dados atuais:

| Regra | Fato usado | Limite (configurável) | Severidade |
|---|---|---|---|
| Pedido sem despacho acima da meta de preparo | `agora − PLC`, sem DSP | `checklist_metas.preparo` | atenção / crítico (2× a meta) |
| Disputa aberta | HSD com `expires_at > agora` | — | crítico |
| Disputa expirada | HSS EXPIRED | ≥ 1/dia | atenção |
| Cancelamento atribuído à loja | CAN com `CANCEL_ORIGIN ∈ {RESTAURANT, RESTAURANT_VIA_OPERATION}` | ≥ N/dia | atenção |
| Integração parada | sem evento há X min em horário de operação, ou `FALHOU > 0`, ou `reauth_required` | — | crítico (só para a Crescer) |
| Taxa de cancelamento do dia | cancelados ÷ pedidos | > meta | atenção |

Propriedades obrigatórias: cada disparo registra **o fato, o limite, a amostra e os ids de evidência** (`displayId`, hora). Sem amostra mínima a regra **não roda e diz que não rodou** (é o padrão `naoAvaliadas` do Checklist).

### Nível 2 — Estatístico (tendência, desvio, recorrência)

Reaproveitar e estender os analisadores do Checklist:

- piora/melhora entre períodos com amostra mínima e variação mínima (existe);
- anomalia diária por mediana + MAD (existe para preparo; estender a cancelamento e espera do entregador);
- reincidência (mesmo horário, vários dias) (existe);
- percentis p50/p90 por etapa e loja; comparação entre lojas da mesma empresa (**novo**: o consolidado multiunidade não existe);
- sazonalidade por dia da semana (existe a contagem; falta a linha de base).

Regra de ouro: o nível 2 produz **constatações quantificadas e grau de confiança** (tamanho da amostra, dispersão), nunca causas.

### Nível 3 — IA (interpretação, resumo, diagnóstico assistido)

O Agente Crescer recebe **apenas** a saída dos níveis 1 e 2 (achados com evidências) e:

- redige o resumo diário/semanal em linguagem natural;
- agrupa achados relacionados ("atrasos às 19–20 h em 4 dos 7 dias + espera do entregador alta nesse horário");
- propõe hipóteses **marcadas como hipótese** e recomendações **da biblioteca aprovada**, citando os ids dos achados.

Travas:

1. Nenhum número na saída da IA que não esteja na entrada (verificação automática: todo número do texto precisa existir no payload de achados).
2. Nenhuma causa afirmada: só "dados mostram X; possível explicação Y (não comprovada)".
3. Cada recomendação cita `achadoId` + evidências; sem evidência, sem recomendação.
4. A IA nunca consulta o banco direto (princípio do `docs/agente-crescer.md`).
5. Confiança exibida: alta (regra determinística com amostra ≥ mínimo), média (estatística com amostra limítrofe), baixa (hipótese).

## 3. Exemplo ponta a ponta: atraso de preparo

| Passo | O que a Crescer faz | Dado | Já existe? |
|---|---|---|---|
| 1. Pedido envolvido | `displayId` #1234, loja X, recebido (PLC) às 19:42 | `ifood_pedidos` | Sim |
| 2. Intervalo excedido | Sem DSP após 31 min; meta de preparo 20 min → excedido em 11 min | PLC + `checklist_metas` | Sim (medição); disparo em tempo real: **não** |
| 3. Etapa | Com RTP às 19:55 e sem CLT: o atraso está na **espera do entregador**, não na cozinha. Sem RTP: "sem sinalização de pronto: etapa indeterminada" (**não inferir**) | RTP (coluna), AAO/CLT (bruto) | Parcial (extrair AAO/CLT) |
| 4. Frequência | 6 de 14 pedidos entre 19–21 h acima da meta, em 4 dos últimos 7 dias | analisador de reincidência | Sim |
| 5. Impacto estimado | Pedidos afetados, valor operacional desses pedidos, disputas DELAY e cancelamentos por atraso (411/416) no mesmo recorte. **Correlação, não causa** | colunas + CAN/HSD | Parcial |
| 6. Ação recomendada | Da biblioteca: "rever escala 19–21 h"; com logística iFood e espera alta: "verificar se o pedido é marcado como pronto no PDV a tempo" | biblioteca | Parcial (textos no Checklist) |
| 7. Persistiu após a intervenção? | Achado aberto em D; ação registrada pelo gerente em D+1; reavaliar a mesma regra na janela D+1…D+7: **resolvido / melhorou / persiste** | — | **AUSENTE** |

## 4. Acompanhamento (o que precisa ser criado)

Antes de criar estrutura nova, **verificar a reutilização de `comunicacao_alertas`**, que já tem a máquina de estados detectar → escalonar → resolver, deduplicação e severidade. Ela é orientada a **envio**, porém. Para acompanhamento analítico (abrir/fechar achados e medir a eficácia de ações) a recomendação é uma estrutura própria, mínima:

- **achado:** regra, loja, período, valor, limite, evidências, estado, `aberto_em`, `resolvido_em`;
- **ação:** achado, responsável, `registrada_em`, prazo, estado;
- **reavaliação:** achado, janela, resultado.

O Plano de Ação do Dashboard já usa ids estáveis de achado (`diagnosticoId`), e o desenho deve seguir esse padrão. É **P1**: exige migration e decisão de produto (quem registra a ação: gerente, consultor ou ambos).
