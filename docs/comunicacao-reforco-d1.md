# Comunicação — Reforço de prazo final D-1 (Checkpoint H.4-A.8)

## Política (aprovada)

1 aviso normal + **no máximo 1 reforço de prazo final** por alerta. Sem `critico_1`/`critico_final`, sem
múltiplos reforços noturnos. O reforço usa a MESMA infraestrutura do aviso normal:

```
scheduler (agendarReforcosPendentes) → fila (comunicacao_mensagens) → claim → JIT → policy
  → reservar_envio (rate-limit) → gateway → provider
```

| Regra | Valor |
|---|---|
| Tipo | somente `dashboard_ifood_d1` |
| Prazo | `dataReferencia === diaAnterior(hoje local)` — backlog antigo **não** recebe reforço |
| Janela | **20:00–22:00** no timezone da organização, com jitter determinístico (até 30 min) |
| Hard cutoff | **22:30** local (`expira_em`); nunca reagendado para o dia seguinte |
| Dias | segunda a sábado; **domingo não** |
| Espaçamento próprio | **≥ 2 h** desde o envio REAL da mensagem inicial (`enviado_em`), no mesmo dia local |
| Cooldown normal (8h atenção / 4h crítico) | **não** controla o reforço — a reserva recebe `cooldownHoras: null` |
| Rate-limit diário/por minuto | **intactos** (`max_por_contato_por_dia = 3`, etc.) |
| Idempotência | `wa:alerta:{alertaId}:reforco:v1` (a inicial é `wa:alerta:{alertaId}:v1`) |
| Propósito | `comunicacao_mensagens.metadados.proposito = "reforco"`; ausente = inicial |

Código: `backend/src/modules/comunicacao/comunicacao.reforco.js` (regras puras),
`comunicacao.alertas.service.js` (`agendarReforcosPendentes`, gate do JIT `motivoDeCancelamentoDoReforco`),
`comunicacao.fila.repo.js`, `comunicacao.template.js` (`formatarMensagemReforcoDia`).
Banco: migration `092_comunicacao_reforco_alerta.sql` (RPC `comunicacao_agendar_reforco_alerta` + guarda no trigger).

## JIT específico do reforço

A janela comercial normal (08–18) **não** se aplica ao reforço. Antes de enviar, o JIT revalida:
pendência ainda existe (comum a toda mensagem) · `dashboard_ifood_d1` · D-1 ainda é hoje · hoje não é domingo ·
agora ∈ [20:00, 22:00) e antes do cutoff 22:30 · 1ª mensagem enviada hoje · ≥ 2 h desde `enviado_em` ·
consentimento/verificado/opt-out/habilitação/piloto (policy) · rate-limit (reserva). Qualquer falha ⇒ cancelamento
terminal (`CANCELADO_REFORCO_FORA_DE_CONDICAO`), **provider = 0**. Um adiamento transitório nunca empurra o reforço
além do `expira_em`: ele expira em vez de virar cobrança de outro dia.

Pendência resolvida: reforço `SCHEDULED` → cliente lança o Dashboard iFood → worker reivindica → JIT detecta →
`CANCELADO_PENDENCIA_RESOLVIDA`, alerta `RESOLVED`, provider = 0.

## `comunicacao_alertas.status`

A mensagem **inicial** continua sendo a dona de `comunicacao_alertas.status`. O trigger da 088
(`comunicacao_mensagens_sincroniza_alerta`) ganhou UMA guarda: mensagem com `proposito='reforco'` não propaga status.
O reforço tem fonte de verdade própria (a linha em `comunicacao_mensagens`: status, `enviado_em`, …). Logo:
reforço SENT não regride alerta READ; reforço FAILED não vira alerta FAILED; reforço EXPIRADA não reabre o alerta em
DETECTED. `RESOLVED` continua sendo gravado pelo JS (`resolverAlerta`) e nunca é sobrescrito.

## Limitações conhecidas (aceitas para o PILOTO)

1. **Multi-unidade e cota diária.** O destinatário é por organização e a cota é `max_por_contato_por_dia = 3`.
   Organizações com várias unidades pendentes podem consumir a cota diária com os avisos normais antes de um
   reforço. Aceito no piloto; **não** é solução definitiva de escala.
2. **Sem calendário de feriados.** Só se exclui domingo. Feriados nacionais/locais não são considerados.
3. **Horário noturno.** O reforço é a única exceção à janela comercial, restrita ao D-1 que vence hoje.

## Issue futura (não implementar agora)

Avaliar **agregação de pendências por organização/destinatário** (uma mensagem por destinatário listando as unidades
pendentes, em vez de uma por unidade/alerta), para não esgotar `max_por_contato_por_dia` em redes multi-unidade.
