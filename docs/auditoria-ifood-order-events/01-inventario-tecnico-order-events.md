# 01 — Inventário técnico Order/Events

> Base: `origin/main` `a035750` e produção (consultas agregadas de 30/10/2026 ~01:30 UTC). Ver [README](README.md).

## 1. Estado real em produção (fatos verificados)

| Fato | Evidência | Situação |
|---|---|---|
| O Events está **ligado e recebendo** em produção | [BD] `ifood_eventos`: 51.331 eventos de 10/10 a 30/10/2026; último `received_at` = 30/10 01:28:59Z | VERIFICADO |
| Unidades recebendo pedidos | [BD] 3 unidades: `00000000…` (3.269 pedidos desde 10/10, 2 merchants), `6a417349…` (721 desde 18/10, 2 merchants), `4fd38803…` (553 desde 21/10, 1 merchant) | VERIFICADO |
| Order Details ligado | [BD] 4.543 de 4.543 pedidos com `details_status = OK` (100%) | VERIFICADO |
| A Crescer **não age** sobre pedidos (confirm/ready/dispatch/cancel/disputa) | [BD] `confirm_requested_at` preenchido em 0 pedidos; `ifood_pedido_acoes` = 0 linhas; `ifood_disputas.decision` = 0. Política escrita em `docs/ifood-events-operacao-saci.md:13` ("A Central não confirma, não despacha e não cancela pedidos") | VERIFICADO |
| Quem confirma e despacha é outro sistema (PDV/Gestor) | [BD] o metadata de PRS, RTP e DSP traz `appName/CLIENT_ID/ORIGIN/ownerName` (3.250 PRS, 2.416 RTP e 2.448 DSP); [DOC] "quando gerado por integração de PDV/parceiro, o metadata traz appName/CLIENT_ID/ownerName/ORIGIN" | VERIFICADO |
| Fila de processamento saudável | [BD] 0 eventos `RECEBIDO/FALHOU`, 0 `MERCHANT_DESCONHECIDO`, 0 `DESCONHECIDO`, 0 reentregas | VERIFICADO |
| Eventos sem carimbo de ACK | [BD] 118 eventos (0,23%) sem `acknowledged_at`, **todos** recebidos no mesmo minuto (29/10 07:40Z) e sem nenhuma reentrega | Causa **NÃO VERIFICADA** (ver §6) |
| Modo de execução (embarcado ou worker) e valor das flags | O Render MCP desta sessão recebe `forbidden` no workspace; as variáveis não são legíveis | **NÃO VERIFICADO** — inferido pelos dados: o modo é embarcado ou worker, e `IFOOD_ORDER_DETAILS_ENABLED=true` |

> Atenção: a memória de 10/10/2026 registrava "Events DESLIGADO em produção". Isso **mudou** a partir de 10/10: os dados mostram recepção contínua desde então.

## 2. Componentes

Legenda de estado: **IMPL** = implementado e em uso em produção; **IMPL-INATIVO** = implementado e testado, mas sem uso em produção; **PARCIAL**; **AUSENTE**.

| Componente | Localização | Estado | Fluxo | Persistência | Testes | Limitações |
|---|---|---|---|---|---|---|
| OAuth / token por conexão | `ifoodToken.service.js`, `ifoodAuthProvider.js`, `ifoodAuth.service.js` | IMPL | `comAccessTokenValido({conexaoId, appType:"order"})` → token distribuído (credencial `order` da conexão) ou centralizado | `ifood_credenciais`, `ifood_oauth_sessoes`, `ifood_loja_credenciais` (118) | `ifood-app-order-producao`, `ifood-token-*` | Refresh token por conexão; uma credencial com `reauth_required` é pulada sem derrubar as demais (`ifoodEvents.poller.js:21-26`) |
| Merchant API (vínculo) | `ifoodMerchant.service.js`, `ifoodMerchantVinculo.*` | IMPL (vínculo manual e autoatendimento) | Liga merchantId → conexão → organização/unidade | `ifood_conexoes`, `ifood_merchant_vinculos` (116), `ifood_conexao_lojas` (117) | `ifood-merchant-*` | Merchant **não homologado** como módulo operacional (memória `ifood-homologacao-financial-merchant`) |
| Polling de eventos | `ifoodEvents.client.js:24-46` (`buscarEventos`) | IMPL | `GET /events/v1.0/events:polling`, header `x-polling-merchants` (≤100) | — | `ifood-events-parser-client`, `ifood-events-poller` | **Sem** filtro de tipos: consome tudo (`ifoodEvents.client.js:9-11`) |
| Loop e lease do poller | `ifoodEvents.poller.js` (`criarPoller`, `criarLoopDoPoller`), RPC `ifood_lease_adquirir` | IMPL | Ciclo serial ≥30 s (`ifood.constants.js:238-239`); lease no relógio do banco | `ifood_poller_lease` | `ifood-events-fencing-ack`, `ifood-worker-lifecycle` | 1 poller por vez; 429 pausa o ciclo inteiro |
| Escopo/piloto | `ifoodOrderPiloto.js`, `ifoodEvents.poller.js:35-39,244-263` | IMPL | `IFOOD_ORDER_PILOT_UNITS` + unidades com autoatendimento ativado | — | `ifood-events-piloto-escopo`, `ifood-order-piloto` | Fail-closed: lista vazia = nada é consultado |
| Normalização e catálogo | `ifoodEvents.parser.js:40-81,106-129` | IMPL | Evento cru → `{eventId, code, fullCode, orderId, merchantId, createdAt, metadata, payload, payloadHash}` | — | `ifood-events-parser-client` | 48 códigos no catálogo; código fora dele = `DESCONHECIDO` (guardado) |
| Persistência e dedupe | `ifoodEvents.repository.js:143-152` (`inserirEventos`, upsert `onConflict: event_id`) | IMPL | Lote → `ifood_eventos` (UNIQUE `event_id`) | `ifood_eventos` (101) | `ifood-events-service`, `ifood-events-isolamento` | Payload bruto **integral** sem retenção (ver 04) |
| Processamento de estado | `ifoodEvents.service.js:44-65` (`decidirTransicao`), `:127-185` (`aplicarEfeito`) | IMPL | Só ORDER_STATUS altera `status_oficial`; compare-and-set | `ifood_pedidos` | `ifood-events-service` | Demais grupos = `IGNORADO` (só `primeiro/ultimo_evento_em`) — `:153-156` |
| ACK | `ifoodEvents.service.js:329-340` (`enviarAcks`), `ifoodEvents.client.js:50-60` | IMPL | ACK de **todos** os persistidos após persistir (`:283-284`); fencing de lease antes do ACK | `ifood_eventos.acknowledged_at` | `ifood-events-fencing-ack` | Se gravar o carimbo falha, o evento fica sem `acknowledged_at` mesmo com 202 do iFood (`:335-337`) |
| Reprocessamento | `ifoodEvents.service.js:292-320` | IMPL | `RECEBIDO/FALHOU` com `retry_count < 5` | `ifood_eventos.retry_count` | `ifood-events-service` | — |
| Order Details | `ifoodOrder.client.js:25-28`, `ifoodOrder.service.js:38-101,109-137`, `ifoodOrder.parser.js:69-149` | IMPL | Pedido `PENDENTE` → `GET /orders/{id}` → payload bruto + colunas extraídas | `ifood_pedidos.details_*` e colunas da 102 | `ifood-order-details-confirm` | Busca **uma vez**: com `details_status = OK` nunca rebusca (`ifoodOrder.service.js:39`), nem após `ORDER_PATCHED` |
| Confirm | `ifoodOrder.service.js:152-242`, `ifoodOrder.client.js:35-41` | IMPL-INATIVO | POST `/confirm`; o estado só muda pelo evento CFM | `action_state`, `ifood_pedido_acoes` | `ifood-order-details-confirm` | Sem rota HTTP exposta; 0 uso em produção [BD] |
| Ready / Dispatch / Cancel | `ifoodOrderActions.service.js`, `ifoodOrder.client.js:57-109` | IMPL-INATIVO | POST sem retry automático; aguarda o evento oficial | colunas da 103, `ifood_pedido_acoes` | `ifood-order-actions`, `ifood-order-action-coexistence` | Só chamado por `backend/scripts/ifood-order-action-e2e-centralized.mjs` (homologação); **sem rota** em `ifood.routes.js` |
| Handshake (disputas) | `ifoodHandshake.service.js`, `ifoodHandshake.parser.js`, `ifoodHandshake.client.js` | Recebimento IMPL; resposta IMPL-INATIVO | HSD → `ifood_disputas`; HSS → settlement e encerramento | `ifood_disputas` (103) | `ifood-handshake` | 40 disputas presas em `RESPONDIDA` (ALTERNATIVE_REPLIED não é final no código, `ifoodHandshake.service.js:109-111`); 66 sem HSD [BD] |
| Webhook | — | AUSENTE | — | — | — | [DOC] Events › Introdução recomenda webhook para produção; usamos polling |
| Aviso Realtime para as telas | `ifoodPedidosAviso.js` | IMPL | Agenda um aviso por unidade alterada; nunca condiciona o ACK | — | `ifood-pedidos-aviso-realtime` | — |
| Leitura para a tela "Pedidos iFood" | `ifoodPedidosLeitura.service.js`, `ifood.routes.js:75` | IMPL | Lista positiva de colunas sem PII (`ifoodOrder.repository.js:74-75`), até 50 | — | `ifood-pedidos-leitura` | Sem filtro de período nem agregação |
| Status da integração | `ifood.repository.js:450-454`, `ifoodEventsEstado.js`, `ifood.routes.js:78` | IMPL | Último evento, último ACK, falhas | — | — | Estado por instância (memória) |
| Logs seguros | `ifood.logsafe.js` | IMPL | `mascararId`, sem token | — | — | Logs ficam no Render (não acessíveis nesta auditoria) |
| Worker embarcado / dedicado | `backend/src/worker-ifood/embedded.js:26-27` (`IFOOD_EVENTS_EMBEDDED_ENABLED`), `config.js:17` (`IFOOD_EVENTS_WORKER_ENABLED`), `runtime.js:45-46` (`IFOOD_ORDER_DETAILS_ENABLED`) | IMPL | — | — | `ifood-events-embedded`, `ifood-worker-lifecycle` | Valores reais das flags **NÃO VERIFICADOS** |
| Mapeamento merchant → unidade | `ifoodEvents.repository.js:41-84` | IMPL | Só conexões `ativa` com merchant e credencial `order`; exclui `financeiro_homologacao` | `ifood_conexoes` (124/125) | `ifood-events-isolamento` | O tenant **nunca** vem do payload |

## 3. Fluxo ponta a ponta

```
iFood Events (polling 30 s)
  └─ poller: lease → reprocessa pendentes → conexões elegíveis (piloto) → por grupo:
       buscarEventos → processarLote:
          normalizar → dedupe no lote → ordenar por createdAt → resolver tenant pela conexão
          → INSERT ifood_eventos (UNIQUE event_id)            ← payload bruto integral
          → aplicarEfeito (só os novos):
               ORDER_STATUS → ifood_pedidos.status_oficial + carimbos (PLC/CFM/RTP/DSP/CAN)
               CARF         → cancel_failed_event_at
               HSD/HSS      → ifood_disputas
               demais       → IGNORADO (só primeiro/ultimo_evento_em)
          → aviso Realtime
       → renova lease → ACK (todos os persistidos)
  └─ fim do ciclo: processarDetalhesPendentes (≤10 por ciclo) → GET /orders/{id}
          → ifood_pedidos: colunas extraídas + details_payload bruto
Consumidores:
  Checklist Operacional (backend/src/modules/checklist-operacional) ← ifood_pedidos (lista positiva)
  Tela "Pedidos iFood" / status da integração                       ← ifood_pedidos / ifood_eventos
  Agente Crescer (tool consultar_checklist_operacional)             ← Checklist
```

## 4. Módulos que consomem esta integração (verificado por busca de `ifood_pedidos`/`ifood_eventos`/`ifood_disputas` em `backend/src`)

| Módulo | O que lê | Arquivo |
|---|---|---|
| Checklist Operacional (tempos, painel TV, dashboard, análises, exportação) | `ifood_pedidos`: estado, tipo, `order_timing`, carimbos PLC/CFM/RTP/DSP/CAN, `is_test` e `details_payload->merchant->>name` | `checklistOperacional.repository.js:12-16,26-35,73` |
| Tela Pedidos iFood | `ifood_pedidos` (13 colunas sem PII) | `ifoodOrder.repository.js:74-81` |
| Status da integração | `ifood_eventos` (último evento, último ACK, FALHOU) e `ifood_pedidos` (último) | `ifood.repository.js:450-454` |
| Agente Crescer | Indireto, pela tool `consultar_checklist_operacional` | `backend/src/modules/agente/tools/checklistOperacional.tool.js` |

**Não consomem** (verificado): Dashboard iFood/Executivo (lançamentos manuais + Parser Food Delivery), Diagnóstico/Plano de Ação, Produtos/CMV, Insumos, Metas (exceto as metas do Checklist, tabela `checklist_metas`), Bonificação e Comunicação/WhatsApp. **`ifood_disputas` não tem nenhum leitor de tela.**

## 5. Testes existentes (cobertura)

27 arquivos em `backend/test` cobrem Events/Order/Handshake/Checklist (`ifood-events-*` 7, `ifood-order-*` 6, `ifood-handshake`, `ifood-pedidos-*` 2, `ifood-worker-lifecycle`, `checklist-operacional*`/`checklist-metas*` 11). O resultado da execução local nesta auditoria está em [10 §Verificações](10-resumo-executivo-decisao.md#verificações-executadas). Os testes `-pg` (Postgres real) não foram executados: exigem um banco descartável.

## 6. Achados do inventário

1. **I-1 Observador, não operador.** Em produção a Crescer é observadora: recebe e persiste, e não age. Confirm, ready, dispatch, cancel e resposta a disputa existem e estão testados, mas não têm rota nem uso. Isso **preserva a homologação** e elimina o risco de conflito com o PDV.
2. **I-2 ACK sem carimbo (118 eventos).** O lote inteiro de 29/10 07:40Z ficou sem `acknowledged_at` e sem reentrega. Hipóteses: (a) o ACK foi aceito pelo iFood (202) e só a gravação local falhou (`ifoodEvents.service.js:335-337` registra `events.marcar_ack_falhou`); (b) o lease foi perdido antes do ACK e os eventos expiraram na retenção de 8 h sem reentrega dentro do nosso polling. **NÃO VERIFICADO**: os logs do Render não estão acessíveis. O efeito é só observabilidade: os eventos foram persistidos e processados.
3. **I-3 Order Details não acompanha `ORDER_PATCHED`.** 14 pedidos têm OPA [BD], mas o `details_payload` continua o da 1ª busca (`ifoodOrder.service.js:39`). O delta fica só no `payload` do evento OPA (`metadata.changes/total/payments`).
4. **I-4 Disputas sem leitor.** 170 disputas registradas, 0 telas.
5. **I-5 Sem webhook.** É uma decisão de arquitetura, não um defeito: o polling atende, mas o iFood recomenda webhook para produção.
