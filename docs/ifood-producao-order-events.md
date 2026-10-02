# iFood Order + Events — preparação de produção (Fase 0)

> **Status:** migrations 101–103 aplicadas (2026-10-01); Events embarcado publicado e DESLIGADO (2026-10-02). Cada passo
> operacional exige autorização explícita no checkpoint correspondente.

## 1. Migrations 101 → 102 → 103

| | Objetivo | Depende de | Rollback |
|---|---|---|---|
| **101** | `ifood_eventos` (UNIQUE event_id), `ifood_pedidos` mínima, `ifood_poller_lease`; funções `ifood_lease_adquirir/liberar` e `ifood_eventos_marcar_reentrega` (SECURITY DEFINER, `search_path=public`, EXECUTE só `service_role`); RLS sem policy; **amplia** os CHECKs de `app_type` da 056 para aceitar `order` | 056, `organizacoes`, `unidades` | `101_rollback.sql` — aborta se houver `app_type='order'` |
| **102** | detalhes do pedido, SLA, `action_state` (confirm) em `ifood_pedidos`; `ifood_pedido_acoes` (RLS) | 101 | `102_rollback.sql` — aborta se houver detalhes/ações |
| **103** | `action_state` com 13 valores (regex), carimbos ready/dispatch/cancel, auditoria ampliada, `ifood_disputas` (RLS) | 102 | `103_rollback.sql` — aborta se houver dados da 103 |

**Verificado (banco de teste, numa transação terminada em ROLLBACK — nada persistiu):** as três reaplicam sem
erro dentro de `BEGIN` (idempotentes; nenhum `CONCURRENTLY`/`VACUUM`/`ALTER TYPE ... ADD VALUE`); CHECKs de
`app_type` com `order`; RLS ligado nas 5 tabelas com 0 policies; funções DEFINER com EXECUTE só para
`service_role`; as três travas de rollback **abortam** com dados presentes.

**Código atual (`main`) exige as três:** o processamento de eventos grava colunas da 102/103 e o status lê
tabelas da 101. Em produção hoje: 101 0/10, 102 0/4, 103 0/6; `ifood_credenciais.app_type` só aceita
`analytics|financial` — sem a 101 nenhuma credencial `order` pode ser gravada.

### Procedimento (NÃO executado)

```
0. BACKUP do banco de produção (snapshot/PITR do Supabase) + registrar horário e ref do projeto.
1. Conferir o alvo: ref = uqybgauuxcrqzquultfu; catálogo read-only (101/102/103 = 0/N; 056 = completa).
2. BEGIN;  <conteúdo de 101_ifood_eventos.sql>  COMMIT;     -- em erro: ROLLBACK; e PARAR
3. Validar 101 (read-only): catálogo 101 = 10/10; CHECKs de app_type com 'order'; RLS nas 3 tabelas;
   funções com EXECUTE só para service_role; ifood_lease_adquirir/liberar num nome de teste e apagar a linha.
4. BEGIN;  <conteúdo de 102_ifood_pedidos_detalhes_confirm.sql>  COMMIT;   -- em erro: ROLLBACK; e PARAR
5. Validar 102: catálogo 102 = 4/4; ifood_pedido_acoes com RLS.
6. BEGIN;  <conteúdo de 103_ifood_order_actions.sql>  COMMIT;             -- em erro: ROLLBACK; e PARAR
7. Validação final: catálogo 101/102/103 completos; smoke read-only do GET /integracoes/ifood/status e
   /pedidos de uma unidade (sem conexão Order: `order` null, lista vazia, sem 500).
```

Rollback (só com autorização): 103 → 102 → 101, cada um em transação; os scripts abortam se houver dados.

> **Atualização 2026-10-01:** 101, 102 e 103 **aplicadas e validadas em produção** (`20261001192230`,
> `20261001214117`, `20261001214706`), com 0 linhas iFood e as 12 sessões OAuth antigas preservadas.

## 2. Onde o Events roda

**Decisão desta fase: EMBARCADO no Web Service** (sem serviço novo no Render). O worker dedicado (abaixo)
continua existindo como rota de escala — os dois usam o MESMO core (`worker-ifood/runtime.js`: poller,
service, repositórios, lease, loop); só muda o host.

### 2a. Embarcado no Web Service (`IFOOD_EVENTS_EMBEDDED_ENABLED=true`; padrão desligado)

- **Host:** `src/worker-ifood/embedded.js`, chamado pelo `server.js` **depois** do `listen()` e sem `await`;
  o `/health` já responde antes de qualquer polling. Flag desligada = runtime/poller/token nem são importados.
- **Supervisor** (`src/worker-ifood/supervisor.js`, host-agnóstico): dá vida ao loop serial, traduz cada
  ciclo em estado e, se o próprio loop terminar/quebrar, registra e cria outro com backoff (5 s → 5 min).
  **Nunca chama `process.exit`**: falha do Events = estado `degraded` + log, a API segue saudável.
- **Estados:** `disabled` · `starting` · `active` · `waiting_lease` (outra instância tem o lease — normal em
  deploy) · `degraded` · `stopping` · `stopped`. `/health` mostra só `ifoodEvents: <estado>` e é **sempre
  200**; `GET /integracoes/ifood/status` traz `eventosRecebimento` (estado e horários, nada que agregue outras
  lojas). Detalhe (contagens, lease mascarado, duração do ciclo): logs `events.supervisor_estado`,
  `events.ciclo_resumo`, `events.supervisor_loop_terminou`.
- **Deploy com duas instâncias:** o lease decide. A nova sobe, recebe `LEASE_DE_OUTRO` (`waiting_lease`) e
  segue saudável; quando a antiga libera (SIGTERM) ou o lease vence, a nova assume. **Fencing do ACK:** cada
  lote de ACK só pode sair até (renovação do lease + TTL − 15 s) — um AbortSignal corta o ACK e os retries
  dele antes do vencimento; do 2º lote em diante o lease é renovado de novo. Assim nenhuma instância envia
  ACK depois que a outra pode ter assumido.
- **SIGTERM:** um único handler (`src/servidor.lifecycle.js`): sem ciclo novo; espera o ciclo em voo até 7 s;
  libera o lease **só se o ciclo terminou** (se não, o lease vence sozinho em ≤ 90 s e ninguém reconhece em
  paralelo); fecha o HTTP; exit 0. Prazo final de 10 s.

### 2b. Carga no processo Web e quando migrar para o worker dedicado

Base: polling a cada 30 s (piso da doc), **serial** — no modo distribuído, uma requisição de polling por
conexão por ciclo; ACK só quando há eventos; Supabase via HTTP (PostgREST, sem pool de conexões persistente);
1 timer de espera do loop + 1 timeout por chamada HTTP em voo. Plano atual do web: 0,5 CPU / 512 MB.

| Lojas | Chamadas iFood (sem eventos) | Duração do ciclo | Leitura |
|---|---|---|---|
| 1 | ~2 polls/min | ≈ latência de 1 poll + escritas | desprezível |
| 10 | ~20 polls/min | ~10 × (latência do poll + escrita) | baixo; a medir |
| 50 | ~100 polls/min | ~50 × (…) — pode se aproximar de 30 s | o limite é o loop SERIAL, não CPU |

Os números de duração dependem da latência real do iFood e do Supabase — **medir na Fase 1** com
`events.ciclo_resumo.duracaoMs`. Uma loja lenta (timeout 20 s × 3 tentativas) atrasa as demais do ciclo.

**Sinais para migrar para Background Worker dedicado** (qualquer um sustentado): duração do ciclo p95 > 15 s
(metade do intervalo); atraso de evento (`received_at − event_created_at`) p95 > 60 s; 429 recorrente; CPU do
web > 70 % ou memória > 80 % com o Events ligado; lag do event loop perceptível na API; reinícios frequentes
do supervisor; mais de ~20–30 lojas conectadas (confirmar com as medições). Migrar = ligar
`IFOOD_EVENTS_WORKER_ENABLED` no worker e desligar `IFOOD_EVENTS_EMBEDDED_ENABLED` no web — o lease impede
dois pollers durante a troca.

### 2c. Worker dedicado no Render (NÃO criado — rota de escala)

- **Tipo:** Background Worker, `rootDir: backend`, build `npm ci`, start **`node src/worker-ifood/index.js`**
  (= `npm run worker:ifood`; nenhum `--env-file`). **1 instância.**
- **Variáveis:** as mesmas do web — Supabase, **o mesmo** `IFOOD_TOKEN_SECRET` (senão não decifra os tokens),
  `IFOOD_ORDER_CLIENT_ID/SECRET`. `IFOOD_EVENTS_WORKER_ENABLED=true` só na ativação autorizada;
  `IFOOD_ORDER_DETAILS_ENABLED=true` só depois da 102. **Nunca** `IFOOD_HOMOLOGATION_MODE`,
  `IFOOD_CENTRALIZED_*`, `IFOOD_FINANCIAL_FIXTURE`.
- **Comportamento (Fase 0):** vivo entre ciclos (sem `unref`); SIGTERM → termina o ciclo, libera o lease, exit 0;
  loop que termina sozinho → `worker.loop_terminou_inesperadamente`, lease liberado, exit 1 (o Render reinicia);
  uma loja com problema não para as outras (`conexoesComFalha` / `conexoesIgnoradas`).
- **Limitação conhecida do teste local:** em Windows o SIGTERM do teste é disparado por IPC no mesmo handler;
  o sinal POSIX real (o do Render) só é exercitado em Linux.

## 3. Observabilidade (auditoria)

| Sinal | Hoje |
|---|---|
| Lease atual / worker vivo | `ifood_poller_lease` (`lease_ate`, `atualizado_em` — renovado a cada ciclo) → painel "Worker ativo/inativo" |
| Último polling | aproximado por `ifood_poller_lease.atualizado_em` (renovação no início de cada ciclo) |
| Último evento / último ACK | `ifood_eventos.criado_em` / `acknowledged_at` → painel |
| Eventos com falha | `ifood_eventos.processing_status='FALHOU'` → painel |
| Último pedido | `ifood_pedidos.criado_em` → painel |
| Último ciclo executado / bem-sucedido, último erro, código, conexão afetada | **só em log** (`events.ciclo_falhou`, `events.conexao_falhou`, `events.conexao_ignorada`) e no `/health` opcional |

**Decisão:** nenhuma migration nova nesta fase — para a Fase 1 (uma loja, acompanhamento manual) os logs do
Render + os sinais acima bastam. **Proposta mínima** para antes de alertas/expansão: colunas em
`ifood_poller_lease` — `ultimo_ciclo_em`, `ultimo_ciclo_ok_em`, `ultimo_estado`, `ultimo_erro_codigo`,
`ultimo_erro_em`, `conexoes_com_falha jsonb` (conexão, merchant mascarado, código, etapa, horário), gravadas
pelo titular do lease ao fim do ciclo. Número: a sequência real termina em **104** (nenhuma branch/worktree
tem 105+); como a frente de comunicação também numera, **reservar o número só no momento do merge**.

## 4. Pendências externas (iFood) — RESOLVIDAS (2026-10-02)

1. **ACK:** controle de entrega/ACK **por device** (um por aplicativo, baseado nas credenciais) — o nosso ACK
   não interfere no Gestor de Pedidos nem em outro integrador (FAQ oficial + guia "Polling de eventos").
2. **Heartbeat:** confirmado pelo suporte iFood — o polling da aplicação Order **mantém a loja online**, mesmo
   com o Gestor fechado (basta um device ativo). `excludeHeartbeat=true` **não é suportado/recomendado** para
   Order e **não será implementado**.

Consequência e controles da Fase 1 (piloto em uma loja, Gestor aberto, responsável presente, janela curta,
kill switch): [`ifood-fase1-piloto-runbook.md`](ifood-fase1-piloto-runbook.md).
