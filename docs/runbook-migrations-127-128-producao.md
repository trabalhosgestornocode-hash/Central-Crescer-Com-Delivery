# Runbook — migrations 127 e 128 em produção (Checklist Operacional 2.0, PR #53)

> Estado: **preparado, NÃO executado.** Pré-voo de leitura feito em 24/10/2026 16:26 UTC. Execução depende de (1) backup
> verificado e (2) liberação da ferramenta de aplicação. Merge e deploy fora desta etapa.

## 1. Alvo e arquivos

| | |
|---|---|
| Projeto | `Crescer Com Delivery` — ref `uqybgauuxcrqzquultfu` (us-west-2, PostgreSQL 17.6.1.141) |
| Código aprovado | PR #53 @ `7b94b81` |
| `127_checklist_metas.sql` | SHA-256 `c3ca62f637559e52…` |
| `128_ifood_pedidos_indice_periodo.sql` | SHA-256 `69e50f1cc92d5f68…` |
| `127_rollback.sql` / `128_rollback.sql` | `1f26666e8416f4ac…` / `a3d313c23790de21…` |

## 2. Pré-voo (leitura, 24/10 16:26 UTC)

| Verificação | Resultado |
|---|---|
| Nomes livres (`checklist_metas`, `checklist_metas_historico`, funções `checklist_metas*`, `idx_ifood_pedidos_tenant_criado`) | ✅ |
| Pré-requisitos de banco (`organizacoes`, `unidades`, `ifood_pedidos`, papéis Supabase) | ✅ |
| Migrations do código já aplicadas (112, 113, 116–118, 120–124, 126; módulo `checklist_operacional`) | ✅ — só a 110 (pareamento de exibição) ausente, sem relação com o PR |
| Carga | 0 sessões ativas, nenhuma transação longa, nenhum lock exclusivo nas tabelas afetadas |
| Linha de base | 3 168 pedidos (33 MB), 35 147 eventos (último 16:25:21), lease do poller renovado 16:26:19 |
| Indisponibilidade | **não exige**: 127 só pega lock curto em `unidades`/`organizacoes` (lock_timeout 5 s, aborta inteira se não conseguir); 128 é `CONCURRENTLY` (não bloqueia escritas) |
| **Backup de hoje / PITR** | ❌ **não verificável pela ferramenta** (sem tool de backups no conector, sem Supabase CLI/token) — exige confirmação no painel (§3) |

## 3. Backup — o que precisa ser confirmado ANTES de executar

No painel do projeto `uqybgauuxcrqzquultfu`: **Database → Backups** — backup de 24/10/2026 com status concluído e horário;
**Settings → Add-ons** — PITR habilitado ou não (e a janela). Sem PITR, a recuperação é a do backup diário (perde-se o que
entrou depois dele — por isso o rollback deve ser **localizado**, §5, e nunca restauração completa por um problema do Checklist).

## 4. Execução

1. Registrar a linha de base (consulta do §2) com horário.
2. **127** — o arquivo inteiro, como está (já tem `begin … commit` e `lock_timeout 5s`). Pode ir pela ferramenta de
   migrations ou pelo SQL Editor.
3. Verificar (leitura): 2 tabelas, RLS ligada e **0 policies**; anon/authenticated sem privilégio; service_role só `select`
   e `execute` em `checklist_metas_salvar`; 8 CHECKs; FKs `on delete cascade`; gatilhos de tenant e de imutabilidade;
   nenhuma outra tabela alterada (comparar `pg_class.relnatts`/contagens da linha de base).
4. **128** — **fora de transação**: `create index concurrently if not exists idx_ifood_pedidos_tenant_criado on
   ifood_pedidos(organizacao_id, unidade_id, criado_em);` — no SQL Editor, rodar **só esta instrução**. Ferramentas que
   envolvem o SQL em transação recebem `CREATE INDEX CONCURRENTLY cannot run inside a transaction block` (inofensivo: nada
   é criado) — nesse caso, usar o SQL Editor.
5. Validar: `select indisvalid, indisready from pg_index where indexrelid = 'public.idx_ifood_pedidos_tenant_criado'::regclass;`
   → `t, t`.

## 5. Recuperação (proporcional; nunca restaurar o banco inteiro por causa do Checklist)

| Situação | Ação |
|---|---|
| 127 falha | a transação desfaz tudo sozinha; conferir que nada ficou (`to_regclass` nulo) e investigar |
| 128 falha / índice `indisvalid = f` | `drop index concurrently if exists idx_ifood_pedidos_tenant_criado;` e repetir a 128. **Reaplicar sem dropar não conserta** (`IF NOT EXISTS`) |
| Índice causa problema | `128_rollback.sql` (`drop index concurrently`): só o índice sai; nenhum pedido é tocado |
| Metas precisam sair | **antes**, exportar e conferir: `copy (select * from checklist_metas order by unidade_id) to stdout with csv header;` e `copy (select * from checklist_metas_historico order by unidade_id, versao) to stdout with csv header;` (guardar, contar linhas e somar `versao`); só então `127_rollback.sql`. Restauração: reaplicar a 127 e reinserir as linhas exportadas (o gatilho de tenant valida cada uma) |

Antes do deploy do código as tabelas ficam **vazias** (nada usa as metas ainda): reverter a 127 nesse intervalo não perde dado.

## 6. Pós-validação (leitura)

Pedidos e eventos continuam crescendo e o lease do poller renova; contagens do Financeiro iguais; nenhuma policy nova
em outras tabelas; advisors do Supabase (segurança/performance) sem alerta novo ligado às duas migrations.
