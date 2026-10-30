# 07 — Plano de automação WhatsApp

> Nenhuma mensagem foi enviada. Fontes: `backend/src/modules/comunicacao/`, `backend/src/worker-comunicacao/`, `gateway-whatsapp/`; [BD] contagens agregadas de `comunicacao_*` (sem telefone nem nome).

## 1. Gateway atual (o que existe)

| Aspecto | Situação | Evidência |
|---|---|---|
| Provedor | **Baileys 6.7.24** (cliente não oficial do WhatsApp Web / companion), serviço próprio `gateway-whatsapp` no Render, com autoDeploy desligado | `gateway-whatsapp/package.json:17`; memória `render-frontend-only-sem-autodeploy` |
| Arquitetura | Backend → fila (`comunicacao_mensagens`) → claim atômico → **Policy Engine** (função pura, fail-closed) → reserva de capacidade → `WhatsAppService` (único chamador do provider) → Gateway (HMAC) | `comunicacao.alertas.service.js:1-30`; `comunicacao.policy.js:1-20`; teste arquitetural `comunicacao-arquitetura-provider.test.js` |
| Worker | Embutido no backend (`worker-comunicacao/loop.js`), tick configurável (`COMUNICACAO_WORKER_INTERVAL_MS`); passo **isolado** para o relatório do grupo | `worker-comunicacao/config.js:88`; `loop.js:106-113` |
| Modo global | `NORMAL` em produção (kill switch: `DISABLED` bloqueia qualquer envio real) | [BD] `comunicacao_configuracoes.modo`; `comunicacao.constants.js:6-23` |
| Tipos de alerta | **Só um**: `dashboard_ifood_d1` (pendência de lançamento D-1 do Dashboard iFood) + mensagem manual + teste | `comunicacao.constants.js:213-216`; [BD] 1.174 / 13 / 1 mensagens |
| Relatório em grupo | Relatório diário do Dashboard iFood para o grupo interno "Crescer Com Delivery - Central" (seg–sáb, 16:30), modos DESLIGADO/SIMULACAO/ATIVO, idempotente por dia | `relatorioDashboardGrupo.js:1-30`; [BD] 19 envios `SENT` em 30 dias |
| Destinatários | Contato explicitamente configurado na habilitação da organização (nunca "o primeiro encontrado"); teto de **5 ativos por organização** | `comunicacao.alertas.service.js:13-16`; `comunicacao.constants.js:210` |
| Consentimento e allowlist | Fail-closed: exige telefone verificado, `opt_out = false` **e** `consentimento = true` explícito para proativo, vínculo com organização/unidade, empresa habilitada, tipo permitido, categoria habilitada no destinatário, envio automático ligado. A allowlist do piloto foi encerrada (migration 104) | `comunicacao.policy.js:26-40`; `comunicacao.constants.js:139-183` |
| Horário | Janelas por organização (padrão seg–sex 08–18, sáb 08–13, dom sem envio), timezone IANA validado, jitter determinístico (≤ 30 min) | [BD] `janelas`; `comunicacao.config.js:53` |
| Limites | 5 proativas/min (global), 3/min por organização, **3 por contato/dia**, 20 por organização/dia | `comunicacao.config.js:35-45`; [BD] `limites` |
| Cooldown | atenção 8 h / crítico 4 h | [BD] `cooldowns_horas` |
| Dedupe | Alerta por chave (detectar/escalonar/resolver); grupo: `UNIQUE(chave_idempotencia)`; incerteza = `DELIVERY_UNKNOWN`, **nunca reenvio automático** | `comunicacao.grupoInterno.js:5-8` |
| Retry | Classificação de erro (`comunicacao.entrega.js`) + backoff; reenvio só com allowlist (`retryResendAllowlist.js`) | — |
| Logs e histórico | `comunicacao_mensagens` (status com enviado/entregue/lido/falhou), `comunicacao_tentativas`, `comunicacao_envios_grupo`, auditoria | [BD] 30 dias: DELIVERED 667, READ 100, SENT 113, CANCELLED 294 |
| Inbound | Inbox com retenção (`comunicacao.inbox.retencao.js`); o companion já travou no sync offline e foi resolvido por re-pareamento | memória `whatsapp-companion-offline-stall` |
| Organizações habilitadas | 39 linhas em `comunicacao_habilitacoes` | [BD] |

### Restrições do provedor (decisivas para o plano)

- **Não é a WhatsApp Business API oficial.** Não há templates aprovados, janela de 24 h, nem garantia contratual. Volume alto, mensagens repetitivas ou denúncias podem **banir o número**. Os limites conservadores atuais (3 por contato/dia) existem por isso.
- Depende de **uma sessão de companion** (QR). Se ela cair, todo o canal cai (já aconteceu em 22–25/09).
- Custos: sem custo por mensagem; o custo está no **risco operacional** e na manutenção do gateway.
- Conclusão: o canal suporta **resumos e poucos alertas críticos agrupados**. **Não** suporta um fluxo de alerta por pedido para dezenas de lojas.

## 2. Viabilidade das automações

Público: **G** = gerente/dono da unidade (destinatário configurado); **C** = grupo interno da Crescer (consultores). Disponibilidade: **AGORA** = os dados e a infraestrutura existem e falta a regra/template; **APÓS-AJUSTE** = exige mudança interna (P1); **DEP** = exige API nova.

### 2.1 Alertas imediatos

| Automação | Gatilho (determinístico) | Dados necessários | Público | Disponibilidade | Risco |
|---|---|---|---|---|---|
| Pedido aguardando confirmação | `status_oficial = PLACED` e `agora − PLC > N min` (N < 8) | colunas PLC/estado | G | AGORA | **Baixo valor hoje**: o PDV confirma em ~0 s. Só serve como alarme de PDV parado. Risco de ruído baixo |
| Atraso de preparo | `agora − PLC > meta_preparo` sem DSP (e sem CAN) | colunas + `checklist_metas` | G | AGORA | **Volume**: precisa de agrupamento (1 mensagem por janela por loja). Com logística iFood, o "preparo" inclui a espera do entregador: o texto deve dizer "sem despacho", não "cozinha atrasada" |
| Pedido pronto aguardando coleta | RTP presente, sem CLT/DSP após X min | RTP (coluna) + CLT (bruto) | G | APÓS-AJUSTE (extrair CLT/AAO) | Só logística iFood e só com RTP (53%) |
| Entregador aguardando na loja | AAO sem CLT após X min | bruto | G | APÓS-AJUSTE | Tempo real: o polling de 30 s + tick do worker atrasam o aviso em até ~1 min. Aceitável |
| Cancelamento | Evento CAN | `cancel_event_at` + motivo/origem/estágio (bruto) | G (+C se recorrente) | AGORA (contagem) / APÓS-AJUSTE (com motivo) | Baixo volume (~5/dia nas 3 lojas). Não expor dados do cliente |
| **Disputa aberta** | HSD com `expires_at` futuro | `ifood_disputas` | G | **AGORA** | **Prazo de minutos** (exemplo [DOC]: 5 min). Um WhatsApp pode chegar tarde, e responder exige agir no PDV/Gestor. 33% das disputas **expiraram** [BD]: é o alerta de maior valor imediato. Sem o HSD (66 casos) não há prazo para avisar |
| Devolução | DRGO/DRDO | bruto | G | APÓS-AJUSTE | 0 eventos até hoje |
| Repetição de problemas na unidade | N atrasos/cancelamentos no dia acima do limiar | agregados | G + C | AGORA (regras do Checklist `LIMIARES`) | Definir limiares por loja |
| Falha prolongada de sincronização | `ultimo evento recebido` > X min em horário de operação, ou `FALHOU > 0`, ou credencial `reauth_required` | `ifood_eventos`, estado do poller, credenciais | **C** (nunca o cliente) | AGORA | Distinguir "loja fechada/sem pedidos" de "integração parada" (o monitor da multiconexão já tem a exceção de horário morto) |

### 2.2 Acompanhamento periódico

| Automação | Gatilho | Dados | Público | Disponibilidade | Risco |
|---|---|---|---|---|---|
| Resumo diário | Horário fixo pós-fechamento, por loja | pedidos, cancelamentos, tempos vs meta, top 3 atrasos (`displayId`) | G | AGORA (reaproveita `montarDashboard`) | Respeitar a janela de envio (as janelas atuais terminam às 18 h; o resumo do dia precisa de uma janela própria ou do dia seguinte de manhã) |
| Resultado semanal | Segunda pela manhã | idem + comparação com a semana anterior + análises do Checklist | G + C | AGORA | Texto ≤ 3.800 caracteres (limite já tratado no relatório do grupo) |
| Comparativo mensal | Dia 1 | tendência, metas, cancelamentos, promoções | G + C | AGORA (operacional); Financial para o valor líquido | Não misturar operacional e financeiro |
| Metas operacionais | Desvio contra `checklist_metas` | Checklist | G | AGORA | Metas definitivas pendentes de decisão |
| Evolução de cancelamentos | Semanal | CAN bruto | G | APÓS-AJUSTE | — |
| Evolução dos tempos | Semanal | Checklist | G | AGORA | — |
| Produtos mais vendidos | Semanal | `items` | G | APÓS-AJUSTE (extração) | — |
| Desempenho das promoções | Semanal | `benefits`/`discount_sponsors` | G | AGORA (resumo por patrocinador) | Regras anti-dupla contagem (05 §5) |
| Principais problemas + recomendações | Semanal | análises do Checklist (constatação/hipótese/recomendação) | G + C | AGORA (determinístico) | A IA só redige sobre a evidência (08) |

### O que dá para implementar **imediatamente** (sem nova API e sem novo provedor)

1. Resumo diário e resultado semanal por loja (dados do Checklist + colunas de valor).
2. Alerta de **disputa aberta** (com a ressalva do prazo).
3. Alerta de **falha prolongada de sincronização** para o grupo interno C.
4. Alerta agrupado de **atrasos acima da meta / cancelamentos** (no máximo 1 por janela por loja).

Todos exigem: um novo `TIPO_ALERTA` e uma nova `CATEGORIA` (hoje só existe `dashboard_ifood_d1`), template, habilitação por organização, opt-in do destinatário na categoria e teste em modo SIMULACAO. A estrutura de categoria por destinatário (migration 104) já existe.

## 3. Controles propostos

| Controle | Como (reaproveitando o que existe) |
|---|---|
| Consentimento e destinatários autorizados | Manter a política atual: `consentimento === true` explícito para proativo e destinatário configurado na habilitação. **Categoria por tipo** (`comunicacao_destinatario_categorias`): cada alerta novo é uma categoria que o destinatário precisa ter ligada |
| Preferências por unidade | Hoje a habilitação é por **organização**. Para lojas de uma mesma empresa com responsáveis diferentes é preciso habilitação por unidade ou destinatário vinculado à unidade (o `vinculoValido` da política já considera a unidade) |
| Horários de silêncio | Janelas da organização (existentes) + janela própria para "resumo do dia" + **horário de pico** (não interromper o almoço/jantar com resumos; alertas críticos sim) |
| Severidade | Reaproveitar `SEVERIDADE` (atenção/crítico). Crítico: disputa aberta, integração parada em horário de operação, ≥ N cancelamentos/hora. Atenção: atraso agregado, meta estourada no dia |
| Frequência máxima | Limites atuais (3 por contato/dia, 20 por organização/dia) **contam todos os tipos juntos**. Proposta: orçamento por categoria (ex.: alertas operacionais ≤ 2/dia/loja + 1 resumo), sem ampliar o total sem análise de risco de banimento |
| Agrupamento | Digest: alertas da mesma loja em janela de 15–30 min viram 1 mensagem ("3 pedidos sem despacho acima de 25 min: #1234, #1240, #1251") |
| Evitar duplicadas | Chave de idempotência por (tipo, loja, janela) como na 109; detectar/escalonar/resolver como `comunicacao_alertas` (um alerta resolvido antes do envio é cancelado: já é o comportamento de `PENDING_RESOLVED`) |
| Histórico de envios | Já existe (`comunicacao_mensagens` + tentativas + auditoria) |
| Escalonamento | Crítico sem resolução em X min → grupo interno C (não um segundo contato do cliente sem consentimento) |
| Proteção de dados | A mensagem leva **apenas** `displayId`, horários, durações e contagens. **Nunca** nome, telefone ou endereço do cliente, nem dados do entregador. O texto do motivo de cancelamento é do iFood, sem o texto livre do cliente (`message` do HSD pode conter relato pessoal: não reproduzir) |

## 4. Arquitetura recomendada para os alertas

Reaproveitar o pipeline existente **sem** criar outro canal:

```
Detector operacional (novo passo do worker de Events OU do worker de comunicação, a cada ciclo)
  └─ lê ifood_pedidos / ifood_disputas / estado do poller (só leitura, por tenant)
  └─ cria/escalona/resolve comunicacao_alertas (novo tipo_alerta + categoria)   ← mesma tabela e mesma máquina de estados
      └─ agendarEnviosPendentes → Policy Engine → WhatsAppService → Gateway        ← inalterados
```

- O detector **não** envia: só cria alertas. A política continua sendo a única autoridade de envio.
- O relatório periódico segue o padrão de `relatorioDashboardGrupo.js` (passo isolado, modo DESLIGADO/SIMULACAO/ATIVO, chave por dia), parametrizado por loja e destinatário.
- **Decisão material pendente:** a dependência de um provedor não oficial. Para escalar alertas para muitos clientes, avaliar a **WhatsApp Business Platform (Cloud API)**, com templates aprovados e custo por conversa. É P3 (ver 09).
