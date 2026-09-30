# iFood Order + Events — preparação de produção (Fase 0)

> **Status:** procedimento preparado e revisado. **Nada aqui foi executado em produção.** Cada passo
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

## 2. Worker de Events no Render (NÃO criado)

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

## 4. Pendências externas (iFood) — bloqueiam a Fase 1 real

Sem resposta confiável do iFood, **não** assumir:

1. **ACK:** o ACK de Events do nosso app pode interferir nos eventos que outras interfaces/aplicações da loja
   (ex.: Gestor de Pedidos) recebem ou processam?
2. **Heartbeat:** o polling do app integrador funciona como heartbeat operacional capaz de afetar a
   disponibilidade da loja quando o worker fica offline?
