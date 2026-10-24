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
entrou depois dele — por isso o rollback deve ser **localizado**, §7, e nunca restauração completa por um problema do Checklist).

## 4. Métodos de execução (sem contornar permissões)

| Migration | Método recomendado | Alternativa | Não usar |
|---|---|---|---|
| **127** | **SQL Editor** do projeto, papel `postgres`, colando o arquivo inteiro (já tem `begin … commit` e `lock_timeout 5s`) — mesmo método oficial da migration 115 (`docs/runbook-aplicacao-migration-115.md`) | ferramenta de migrations do conector Supabase (`apply_migration`), **só se** você liberar explicitamente essa permissão no Claude Code; registra a versão em `supabase_migrations` | psql com a `DATABASE_URL` de produção pelo Claude (contornaria a trava de permissão) |
| **128** | **SQL Editor**, executando **só a instrução** `create index concurrently …` (sozinha, sem `begin`); ou `psql "$DATABASE_URL" -c "…"` pelo responsável (autocommit) | — | ferramentas que embrulham o SQL em transação (o Postgres recusa: `cannot run inside a transaction block` — inofensivo, nada é criado) |

## 5. Verificação antes/depois — `database/operacoes/checklist-127-128-verificacao.sql` (somente leitura)

* **V0** imediatamente antes da 127 (anotar `agora` = `t0`); **V1** depois da 127; **V2** depois da 128; **V3** = V0 com o `t0`
  anotado.
* **Igualdade obrigatória V0 × V3:** `pedidos_ate_t0`/`_md5`, `eventos_ate_t0`/`_md5` (o conjunto que já existia em `t0` —
  só identificadores, porque estado muda legitimamente), `financeiro_totais`, e as impressões digitais de estrutura fora do
  escopo (`estrutura_colunas_md5`, `estrutura_indices_md5`, `politicas_rls_md5`, `rls_e_privilegios_md5`, `funcoes_md5`).
* **Crescimento esperado:** `pedidos_total`/`eventos_total` ≥ V0, `ultimo_evento` recente, lease do poller renovado,
  `eventos_falhou` sem salto.
* **Ensaio do script** (24/10, PostgreSQL 17.11 local, schema real até 126, 500 pedidos/eventos ao longo de 3 semanas +
  60 novos depois de `t0` + mudança legítima de estado): V1 com todos os valores esperados; V2 `t|t` e o plano do período
  "hoje" usando `idx_ifood_pedidos_tenant_criado` com as 3 colunas; V3 com **todas as impressões digitais iguais** e totais
  500 → 560. O plano usa o índice quando o período é uma fração do histórico (o caso do Dashboard); com período que cobre
  quase tudo, o planejador pode preferir o índice existente por tenant — comportamento correto.

## 6. Execução

1. Registrar a linha de base (V0) com horário.
2. **127** — o arquivo inteiro, como está (já tem `begin … commit` e `lock_timeout 5s`), pelo método do §4.
3. Verificar com o **V1** (§5): 2 tabelas, RLS ligada e **0 policies**; anon/authenticated sem privilégio; service_role só `select`
   e `execute` em `checklist_metas_salvar`; 8 CHECKs; FKs `on delete cascade`; gatilhos de tenant e de imutabilidade;
   nenhuma outra tabela alterada (impressões digitais de estrutura do V3 iguais às do V0).
4. **128** — **fora de transação**: `create index concurrently if not exists idx_ifood_pedidos_tenant_criado on
   ifood_pedidos(organizacao_id, unidade_id, criado_em);` — no SQL Editor, rodar **só esta instrução**. Ferramentas que
   envolvem o SQL em transação recebem `CREATE INDEX CONCURRENTLY cannot run inside a transaction block` (inofensivo: nada
   é criado) — nesse caso, usar o SQL Editor.
5. Validar com o **V2**: `indisvalid` e `indisready` = `t, t`, definição exata, plano do período "hoje" usando o índice.
6. Rodar o **V3** com o `t0` do V0 e comparar (§5). Arquivar V0–V3 com horários.

## 7. Recuperação (proporcional; nunca restaurar o banco inteiro por causa do Checklist)

| Situação | Ação |
|---|---|
| 127 falha | a transação desfaz tudo sozinha; conferir que nada ficou (`to_regclass` nulo) e investigar |
| 128 falha / índice `indisvalid = f` | `drop index concurrently if exists idx_ifood_pedidos_tenant_criado;` e repetir a 128. **Reaplicar sem dropar não conserta** (`IF NOT EXISTS`) |
| Índice causa problema | `128_rollback.sql` (`drop index concurrently`): só o índice sai; nenhum pedido é tocado |
| Metas precisam sair | **antes**, exportar e conferir: `copy (select * from checklist_metas order by unidade_id) to stdout with csv header;` e `copy (select * from checklist_metas_historico order by unidade_id, versao) to stdout with csv header;` (guardar, contar linhas e somar `versao`); só então `127_rollback.sql`. Restauração: reaplicar a 127 e reinserir as linhas exportadas (o gatilho de tenant valida cada uma) |

Antes do deploy do código as tabelas ficam **vazias** (nada usa as metas ainda): reverter a 127 nesse intervalo não perde dado.

## 8. Pós-validação (leitura) — V3 (§5)

Pedidos e eventos continuam crescendo e o lease do poller renova; contagens do Financeiro iguais; nenhuma policy nova
em outras tabelas; advisors do Supabase (segurança/performance) sem alerta novo ligado às duas migrations.

## 9. Resultado da execução em produção (24/10/2026, projeto `uqybgauuxcrqzquultfu`)

Backup atestado pelo responsável antes do início. 127 e 128 executadas pelo responsável no SQL Editor; V0–V3 executadas
somente leitura via MCP. Nenhuma outra migration, nenhum rollback, nenhum merge ou deploy.

| Etapa | Horário (UTC) | Resultado |
|---|---|---|
| V0 (linha de base, `t0`) | 16:44:01 | pedidos 3173 · eventos 35201 · `FALHOU` 0 · lease do poller renovado 16:43:51 · Financeiro: fin_auditoria 585, fin_contas 4, fin_lancamentos 409, fin_plano_contas 36, gestao_financeira_concessoes 2 |
| 127 | ~16:53 | aplicada (transação única) |
| V1 | 16:54:22 | 14/14 itens conforme §6.3; impressões digitais de estrutura das demais tabelas iguais ao V0 |
| 128 | ~16:56 | aplicada fora de transação |
| V2 | 16:57:13 | `indisvalid`/`indisready`/`indislive` = t; definição exata; 200 kB; plano do período "hoje" (unidade com 2489 pedidos): `Index Scan using idx_ifood_pedidos_tenant_criado` com a condição completa + Incremental Sort |
| V3 (com `t0` do V0) | 16:57:38 | ver abaixo |

Comparação V0 × V3:

| Item | V0 | V3 | |
|---|---|---|---|
| Pedidos até `t0` (contagem / md5 dos ids) | 3173 / `0120c157…5aa` | 3173 / `0120c157…5aa` | igual |
| Eventos até `t0` (contagem / md5) | 35201 / `4b6bddbd…74c` | 35201 / `4b6bddbd…74c` | igual |
| Totais (tráfego após `t0`) | 3173 / 35201 | 3177 / 35242 | cresceram — iFood seguiu processando (último evento 16:57:20) |
| Eventos `FALHOU` | 0 | 0 | igual |
| Lease do poller | 16:43:51 | 16:57:21 | renovando |
| Financeiro (5 contagens) | — | — | iguais |
| md5 colunas / índices / policies / RLS+privilégios / funções (fora do escopo) | `6b238d6a…` / `1e060f2a…` / `dd7c0d03…` / `401ac2f6…` / `676edcdc…` | idem | iguais |
| Objetos do PR (`checklist_metas`, `checklist_metas_historico`, índice 128) | ausentes | presentes | esperado |
| Sessões / transação longa | — | 1 sessão, nenhuma longa | ok |

Advisors do Supabase após a execução: segurança — apenas `rls_enabled_no_policy` (INFO) nas duas tabelas novas, que é o
desenho (acesso só pelo backend com service_role); `checklist_metas_salvar` **não** aparece entre as funções security
definer executáveis por anon/authenticated. Performance — apenas `unused_index` nos dois índices das tabelas novas (vazias
até o deploy); nenhum alerta sobre `idx_ifood_pedidos_tenant_criado`.

**Conclusão:** dados preservados, estrutura fora do escopo inalterada, índice válido e usado, processamento iFood e
Financeiro sem impacto. Rollback não necessário. As tabelas de metas seguem vazias até o deploy do código.
