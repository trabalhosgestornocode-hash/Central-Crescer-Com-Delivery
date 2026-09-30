# iFood Events — polling, ACK e worker (Checkpoint B)

> Escopo: receber eventos do iFood por **polling**, persistir, deduplicar, resolver o tenant, derivar o
> estado **oficial** do pedido e reconhecer (**ACK**). **Não** há Order Details, Confirm, Ready, Dispatch,
> cancelamento nem Handshake aqui (Checkpoints C e D). Nada foi implantado (deploy/produção). A migration 101 (seção 3)
> foi aplicada e validada no banco de TESTE (`teste-multiempresarial`) — ver seção 7; nenhum banco de produção foi tocado.

## 1. Endpoints (portal oficial iFood, conferido em 2026-09-27)

| | |
|---|---|
| Polling | `GET https://merchant-api.ifood.com.br/events/v1.0/events:polling` — `200` lista · `204` vazio · `400` merchants demais · `403` `{ unauthorizedMerchants }` · `429` limite/throttling |
| Header | `x-polling-merchants: id1,id2,…` — **máx. 100** por requisição; obrigatório no centralizado |
| Filtros | **nenhum** (`types`/`groups`): consumimos tudo e decidimos localmente (eventos fora do filtro recebem *auto-ACK* no iFood) |
| ACK | `POST …/events/v1.0/events/acknowledgment` — corpo `[{ "id": "…" }]` · `202` · até 2000 ids (guia; a referência diz 10000 — usamos o menor) |
| Cadência | a cada **30 s** (mantém a loja online); rate limit 6000 RPM por token |
| Throttling | evento com 50 entregas sem ACK = 1 *strike*; 100 *strikes* = polling bloqueado 5 min |
| Retenção | 8 h — evento sem ACK volta enquanto retido |
| Garantias fracas | a API **repete** eventos (inclusive PLACED antigo) e pode entregá-los **fora de ordem** |

Evento: `id, code, fullCode, orderId, merchantId, createdAt, salesChannel, metadata`.

## 2. Fluxo de um ciclo

```
lease (banco) ─▶ reprocessa pendentes ─▶ conexões com merchant ─▶ por grupo:
   poll ─▶ normaliza ─▶ dedupe no lote ─▶ ordena por createdAt ─▶ resolve tenant (merchantId → conexão)
        ─▶ PERSISTE (UNIQUE(event_id)) ─▶ processa os novos ─▶ renova lease ─▶ ACK (lotes ≤ 2000) ─▶ carimba acknowledged_at
```

### Política de ACK (decidida e testada)

1. **ACK só depois de persistir.** Se a persistência lança, **nada** é reconhecido: o evento volta (retenção 8 h) e a
   `UNIQUE(event_id)` impede efeito duplicado.
2. **Falha ao *processar* um evento já persistido não impede o ACK**: ele está seguro no banco (`FALHOU`, `retry_count`)
   e é reprocessado a partir dele no início dos ciclos seguintes (máx. 5 tentativas). Não reconhecer só geraria reentregas e
   *strikes* sem ganho de segurança.
3. Reconhecemos **todos** os persistidos do lote: novos, **repetidos**, **desconhecidos** e **de merchant desconhecido**.
4. Falha no ACK (5xx/rede): `acknowledged_at` fica nulo; o evento volta e é reconhecido de novo, sem reprocessar.
5. **Fencing leve:** o lease é renovado imediatamente antes do ACK; se foi perdido, não reconhece.
6. Evento **sem `id`** não pode ser reconhecido (o ACK exige o id): é descartado com log — nunca inventamos um id.

### Estado do pedido = evento oficial

Só o grupo `ORDER_STATUS` (PLC, CFM, SPS, SPE, RTP, DSP, CON, CAN) altera `ifood_pedidos.status_oficial`. O ciclo de vida é
**monotônico** (`rank`): um evento de estágio anterior nunca desfaz o atual, mesmo com `createdAt` posterior (PLACED
reentregue); estados finais (CONCLUDED/CANCELLED) não regridem; `CANCELLED` é sempre um avanço; entre dois finais vale o mais
recente. Gravação por *compare-and-set* em `status_oficial_em`. Nenhuma ação nossa (confirm etc.) muda o estado.

### Multi-tenant

`merchantId → ifood_conexoes (status ativa, merchant_id único vivo) → organização/unidade`. **Nunca** do payload.
Merchant sem conexão viva → **quarentena** (`MERCHANT_DESCONHECIDO`, sem tenant, guardado e reconhecido; `CHECK` no banco).
`ifood_pedidos.order_id` é `UNIQUE`: pedido que já pertence a outra unidade nunca é alterado (`PEDIDO_DE_OUTRO_TENANT`).

## 3. Migration 101 (revisão)

Arquivo: `database/migrations/101_ifood_eventos.sql` · rollback: `101_rollback.sql` · **aplicada e validada no banco de TESTE**
(`wiqqsxnysbzhcrzrrean` / `teste-multiempresarial`, ver seção 7). **Nunca aplicada em produção.**

- `ifood_eventos` — `event_id` UNIQUE, `merchant_id`, `order_id`, `event_code`, `event_full_code`, `event_created_at`,
  `received_at`, `processed_at`, `acknowledged_at`, `processing_status` (RECEBIDO / PROCESSADO / IGNORADO / DESCONHECIDO /
  MERCHANT_DESCONHECIDO / FALHOU), `retry_count`, `reentregas`, `last_error`, `payload` (bruto) + `payload_hash`,
  `organizacao_id`/`unidade_id`/`conexao_id` (nulos só em quarentena).
- `ifood_pedidos` — **mínimo**: `order_id` UNIQUE, tenant NOT NULL, `status_oficial` (+ evento e horário que o definiram).
- `ifood_poller_lease` + `ifood_lease_adquirir/liberar` (relógio do **banco**) + `ifood_eventos_marcar_reentrega`.
- RLS habilitado nas 3, **sem policy** (backend-only, como `ifood_credenciais`). Funções `SECURITY DEFINER`, só `service_role`.
- Aditiva e idempotente; a 056 não é tocada.

**Validação local (sem banco real):** o SQL foi executado num Postgres descartável em memória (PGlite) com stubs mínimos:
aplicação, reaplicação (idempotência), UNIQUE, CHECKs de tenant/quarentena, trigger, lease (adquirir/renovar/tomar vencido/
liberar/8 tentativas simultâneas → 1 titular), RLS, rollback e reaplicação — todas as verificações passaram.
Validar no banco de **teste** (com autorização) continua sendo a prova final (Postgres real do Supabase).

## 4. Worker (`worker:ifood`)

| | |
|---|---|
| Processo | separado do `server.js` (nunca importado por ele). `npm run worker:ifood` = `node src/worker-ifood/index.js` (produção/Render: **só variáveis de ambiente do processo**, nenhum arquivo `.env`) · `npm run dev:worker:ifood` (desenvolvimento local, carrega `backend/.env`) · `npm run worker:ifood:centralized-test` (Teste (C); só ambiente técnico; passa pela trava) |
| Liga com | `IFOOD_EVENTS_WORKER_ENABLED=true` (padrão desligado: sai com 0 **antes** de carregar a config do backend) |
| Vivo entre ciclos | o timer do sono **não** usa `unref()`: sem health server ele é o que mantém o processo vivo (antes, o Node saía com 0 depois do 1º ciclo) |
| Código de saída | 0 só em SIGTERM/SIGINT que terminou bem; o loop terminar sozinho → log `worker.loop_terminou_inesperadamente`, lease liberado, saída **1** (`src/worker-ifood/lifecycle.js`) |
| Intervalo | 30 s de **início a início**, nunca menos (piso forçado no código e na config); ciclo lento desconta o tempo gasto |
| Laço | **serial**, sem `setInterval`: o próximo ciclo só nasce quando o anterior termina |
| Erros | backoff crescente 2 s → 4 s → … teto 5 min; `429`/throttling: +60 s; sucesso zera |
| Um poller por vez | `ifood_poller_lease` (TTL 90 s; mínimo 45 s e ≥ 2,5× o intervalo) |
| Multi-loja | uma loja **nunca** impede as outras. Distribuído: só conexões **com credencial `order`** (`listarConexoesElegiveisParaEvents`); `reauth_required` é pulada sem chamar o iFood (`conexoesIgnoradas`). Cada conexão roda isolada: a falha vira `conexoesComFalha` (conexão, merchant mascarado, código, etapa, horário) e log `events.conexao_falhou`; ciclo `PARCIAL`. Só quando **todas** falham o erro sobe (backoff). Globais: 429 (throttling do app) e lease perdido |
| Restart limpo | SIGTERM/SIGINT: termina o ciclo em andamento, **libera o lease**, sai (30 s de limite) → o novo processo assume na hora |
| Queda brusca | o lease vence sozinho (≤ TTL); eventos sem ACK voltam; `UNIQUE(event_id)` evita duplicidade; pendentes `RECEBIDO/FALHOU` são reprocessados |
| Memória | mínima: cache do token e contadores. Todo o estado vive no banco |
| Health | opcional (`IFOOD_EVENTS_HEALTH_PORT`): `/health` com modo, último ciclo e resultado — sem segredos |

**Render (NÃO aplicado):** um Background Worker separado, `rootDir: backend`, build `npm ci`,
start **`node src/worker-ifood/index.js`** (ou `npm run worker:ifood`; nunca `--env-file`: não há `.env` no Render),
**1 instância**, com as mesmas variáveis Supabase/iFood do `web` — inclusive o **mesmo** `IFOOD_TOKEN_SECRET` (senão não
decifra os tokens) e `IFOOD_ORDER_CLIENT_ID/SECRET`. `IFOOD_EVENTS_WORKER_ENABLED=true` só na ativação autorizada.
Nunca `IFOOD_HOMOLOGATION_MODE`, `IFOOD_CENTRALIZED_*` ou `IFOOD_FINANCIAL_FIXTURE` no worker. `render.yaml` **não foi alterado**.

## 5. Como Events obtém token

Só por `comAccessTokenValido()` (interface comum). Escopo `app` (centralizado) → 1 grupo com todos os merchants em lotes de 100;
escopo `conexao` (distribuído) → 1 polling por conexão, com o token daquela unidade. O poller não conhece o tipo de autenticação.

## 6. Decisões tomadas e pontos em aberto

1. **`appType = order` (decidido):** Events/Order pedem o token pelo Auth Provider com `appType = "order"` — **nunca** `financial`.
   A migration 101 amplia os CHECKs de `app_type` (`ifood_credenciais`, `ifood_oauth_sessoes`) para `analytics | financial | order`
   (o arquivo da 056 não é editado). `order` ainda **não** é oferecido ao OAuth/UI/status. `centralized_test` usa o token do app
   centralizado (sem credencial por unidade); `distributed` usará a credencial `order` da conexão quando o app real existir — até lá,
   sem credencial `order` o erro é `IFOOD_CREDENCIAL_NAO_ENCONTRADA` (não há queda para o `financial`).
2. **Binding temporário de homologação centralizada (decidido, só banco de TESTE):** uma linha em `ifood_conexoes` liga o merchant da
   loja sandbox (Teste C) à unidade de teste dedicada (`status='ativa'`, `merchant_razao_social = 'binding temporário de
   homologação centralizada'`). **Não representa OAuth distribuído** e não tem credenciais. Para desfazer: `status = 'revogada'`
   (libera o merchant e a unidade). Quando o OAuth distribuído do Teste (D) for concluído nessa unidade, a conexão viva é
   reaproveitada (`obterOuCriarConexao`).
3. **Presença:** o polling mantém a loja *online* no iFood. No sandbox é irrelevante; em produção, o worker precisa ser o único
   poller ativo daquela loja (o lease garante isso entre instâncias nossas).
4. **Aberto (Checkpoint C):** como o modo distribuído cria/associa a credencial `order` (app real) e a tela de operação de pedidos.

## 7. Fechamento real do Checkpoint B (banco de TESTE `teste-multiempresarial`, 2026-09-27)

**"VALIDAÇÃO TÉCNICA CENTRALIZADA" — não é homologação.**

- Migration 101 aplicada **só** no projeto de teste (após confirmar o `ref`), reaplicada (idempotente) e validada no Postgres real:
  tabelas, 7 índices, UNIQUE, CHECKs, RLS (sem policy), 3 funções `SECURITY DEFINER` só para `service_role`, lease
  (A adquire → B bloqueado → A libera → B assume, geração 2) e **056 intacta** (colunas/constraints/índices/policy/triggers/dados).
- Binding criado por `INSERT` (empresa e unidade localizadas por `SELECT`, correspondência única, sem fixture).
- E2E (`npm run ifood:events-e2e -- --merchant <id> --ack-real`): lease real → polling real (HTTP 200) → 6 eventos persistidos →
  processados → **ACK real HTTP 202** → espera de 31 s → novo polling **HTTP 204** (nenhum reconhecido foi reentregue) → lease liberado.
- Evidência preservada no banco (nada foi apagado): eventos PLC/CFM/DSP/CAN `PROCESSADO`, DDCR/CAR `IGNORADO` (conhecidos, sem
  efeito de estado neste checkpoint), todos com `acknowledged_at`, tenant e conexão de homologação; pedido em `CANCELLED`.

## 8. Testes

`backend/test/ifood-events-parser-client.test.js`, `ifood-events-service.test.js`, `ifood-events-poller.test.js`
(repositório em memória com a semântica do banco: `test/helpers/ifood-events-fakes.js`).
Validação real (Teste (C), sem banco, sem ACK): `npm run ifood:events-check` (`-- --ack` envia o ACK real).
