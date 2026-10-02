# iFood Order + Events — Fase 1: piloto controlado (runbook)

> **Status:** plano aprovado para preparação. **Nada aqui foi executado.** Cada passo operacional (secrets,
> flag, OAuth, conexão de loja) exige autorização explícita no checkpoint correspondente.

## 1. Decisão oficial: heartbeat / presença (iFood, 2026-10-02)

Resposta do suporte iFood para a nossa aplicação **Order**:

- `excludeHeartbeat=true` **não é suportado/recomendado** para Order (é de integradoras logísticas).
- O polling da nossa aplicação **mantém a presença** do merchant: enquanto fizermos polling, a loja pode ficar
  online — **mesmo com o Gestor de Pedidos fechado**. Basta um device ativo; a presença é por aplicação/device.

**Decisão registrada:** `excludeHeartbeat=true` **NÃO será usado**. Sem feature flag, sem parâmetro condicional,
sem código preparado "para o futuro". O polling segue como está (`ifoodEvents.client.js#buscarEventos`).

ACK (já confirmado pela documentação oficial — FAQ "A API suporta mais de um client/device ao mesmo tempo?" e
guia "Polling de eventos" → "Múltiplos devices ou aplicativos"): o controle de entrega/ACK é **por device**
(um por aplicativo, baseado nas credenciais). O nosso ACK **não** tira eventos do Gestor de Pedidos nem de outro
integrador. As instâncias do nosso Web Service usam a mesma credencial = mesmo device — por isso o lease
(um poller por vez) é obrigatório.

## 2. Risco operacional que este plano controla

Na Fase 1 a Central **só lê** eventos e pedidos. Cenário a evitar:

```
Gestor de Pedidos fecha / cai  →  Central continua o polling  →  loja continua ONLINE
→  pedidos novos entram        →  ninguém confirma (a Central ainda não opera pedidos)
→  cancelamento por falta de confirmação e penalização do merchant
```

Mitigação: ativar só com o Gestor aberto e alguém acompanhando, por janela curta, com kill switch pronto.

## 3. Regras do piloto

- **Uma única loja**, conectada só por OAuth Order dessa unidade.
- **Horário comercial**, janela **curta e previamente definida** (início e fim anotados).
- **Responsável operacional** na loja durante toda a janela, com o **Gestor de Pedidos aberto e funcionando**.
- **Observação/leitura apenas:** nenhuma ação Confirm / Ready / Dispatch / Cancel / resposta a disputa —
  automática ou manual — sem autorização específica. Hoje (`613dd4a`) **nenhuma rota do Web Service dispara
  ações**: `confirmarPedido`, ready/dispatch/cancel (`ifoodOrderActions.service.js`) e `responderDisputa` só são
  chamados por scripts de teste; o Handshake recebido por evento só grava a disputa (sem HTTP). Expor qualquer
  ação exige código novo + autorização. `IFOOD_ORDER_DETAILS_ENABLED` fica desligada no início, salvo autorização.
- Desligamento imediato disponível (seção 5) e alguém com acesso ao dashboard do Render durante a janela.

## 4. Condições para iniciar (checklist — todas obrigatórias)

| # | Item | Como conferir |
|---|---|---|
| 1 | `IFOOD_ORDER_CLIENT_ID` e `IFOOD_ORDER_CLIENT_SECRET` no Web Service | Render → Environment (o valor não é lido por ferramenta) |
| 2 | Loja piloto definida (unidade + merchant) | registro no checkpoint |
| 3 | Responsável operacional definido (nome + contato) | registro no checkpoint |
| 4 | Data/horário de início e fim definidos | registro no checkpoint |
| 5 | Gestor de Pedidos aberto na loja | confirmação do responsável no início |
| 6 | Procedimento de rollback lido por quem vai operar | seção 5 |
| 7 | Acompanhamento de logs | Render → Logs filtrando `events.` |
| 8 | Acompanhamento do lease | consulta da seção 6 |
| 9 | Forma rápida de desligar o Events | seção 5 (Render) + pausar a loja no Gestor |

Ativação (só depois do checklist): conectar a loja via OAuth Order → `IFOOD_EVENTS_EMBEDDED_ENABLED=true` no
Render (o salvamento dispara deploy) → conferir `/health` → `ifoodEvents: "active"` (ou `waiting_lease` por
alguns segundos durante o overlap do deploy).

## 5. Kill switch — procedimento de emergência

Como o código se comporta (verificado em `src/worker-ifood/embedded.js` e `src/servidor.lifecycle.js`):

- A flag é lida **uma vez, no boot**. Mudar a variável não para a instância que já está rodando; o que para é o
  **deploy/restart** que a mudança dispara: a instância nova sobe com `disabled` (não importa nem o poller) e a
  antiga recebe SIGTERM → para o Events (sem ciclo novo; espera o ciclo em voo até 7 s) → libera o lease se o
  ciclo terminou; senão o lease **vence sozinho** em até 90 s → fecha o HTTP → exit 0.
- **Não é instantâneo:** a antiga continua o polling até receber o SIGTERM. Referência medida (redeploy de
  2026-10-02): ~33 s do disparo até a nova ficar live. Depois que o polling para, a loja sai do online após o
  timeout de presença do iFood ("alguns minutos", pela documentação).

**Por isso o PRIMEIRO passo, se um pedido estiver em risco, é operacional: pausar/fechar a loja no Gestor de
Pedidos** (efeito imediato na venda, independente da nossa presença). Depois:

1. **Desligar a flag:** Render → serviço `crescercomdelivery` → Environment → `IFOOD_EVENTS_EMBEDDED_ENABLED`
   = `false` (ou remover) → **Save and deploy**.
2. **Reiniciar/redeploy se necessário:** se a variável foi salva sem deploy, usar **Manual Deploy → Deploy
   latest commit** (ou Restart). Esperar o deploy ficar **live**.
3. **Confirmar `ifoodEvents=disabled`:** `GET https://subway-saci-adm.onrender.com/health` → `"ifoodEvents":"disabled"`.
4. **Confirmar lease liberado/expirado** (seção 6): `vencido = true`, ou aguardar até 90 s e consultar de novo.
5. **Confirmar ausência de novo polling:** Render → Logs, a partir do horário do deploy: nenhum
   `events.ciclo_resumo` / `api.ok rotulo=events.polling` novo; boot com `iFood Events: embarcado DESABILITADO`.

Registrar no checkpoint: horário de cada passo e o estado do lease antes/depois.

## 6. Consultas de acompanhamento (somente leitura)

```sql
-- Lease (um titular; vencido = ninguém faz polling)
select nome, holder, lease_ate, lease_ate < now() as vencido, geracao, atualizado_em from ifood_poller_lease;

-- Volume e ACK pendente (em observação: sem ações)
select count(*) eventos, count(*) filter (where acknowledged_at is null) sem_ack,
       max(received_at) ultimo_recebido, max(acknowledged_at) ultimo_ack
  from ifood_eventos;
select count(*) acoes from ifood_pedido_acoes;   -- esperado: 0 na Fase 1 de observação
```

## 7. Condições de aborto (interromper imediatamente — seção 5)

- Gestor de Pedidos fechou ou caiu; responsável operacional saiu da loja.
- Qualquer pedido entrando sem alguém acompanhando.
- 429 recorrente (`events.rate_limited` / estado `degraded` com `rate_limited`).
- Polling fora do intervalo esperado (ciclos com início a início muito diferente de 30 s).
- Lease duplicado (mais de um titular / `geracao` subindo sem deploy) ou ACK duplicado.
- Eventos atrasados (`received_at − event_created_at` alto e crescente).
- Erro de autenticação (`events.conexao_falhou etapa=autenticacao`, `reauth_required`).
- Eventos inesperados (merchant desconhecido em quarentena, códigos fora do catálogo em volume).
- Qualquer 5xx no Web Service.
- Qualquer linha em `ifood_pedido_acoes` sem autorização.
