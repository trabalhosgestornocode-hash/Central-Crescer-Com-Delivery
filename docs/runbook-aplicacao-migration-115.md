# Runbook — aplicação da migration 115 v2 (Checkpoint 6B.8)

> **NÃO EXECUTADO.** Este é o procedimento para quando houver **autorização expressa** de aplicação. Nada foi aplicado em produção.
> Evidência da auditoria: `docs/auditoria-producao-6b8-antes-da-115.txt` (consulta 6b8, read-only, produção, **antes** da 115).

## 0. Resultado da auditoria de produção (6b8) — os 6 critérios
| # | Critério (plano §5b) | Resultado na produção | Passa? |
|---|---|---|---|
| 1 | `1.sessao`: executa como `postgres` / membro de `postgres` | `postgres`, não superuser, `membro_de_postgres=true` | **SIM** |
| 2 | `2.acl_completo`: só `postgres`, `service_role`, `anon`, `authenticated` e/ou PUBLIC, **concedidos por postgres** | Views: `anon`, `authenticated`, `postgres`, `service_role` (**sem** PUBLIC). RPCs: PUBLIC (`-`), `anon`, `authenticated`, `postgres`, `service_role`. **Todos concedidos por `postgres`.** `service_role` tem grant **explícito** em tudo (não depende de PUBLIC) | **SIM** |
| 3 | `3.assinaturas`: exatamente 7 linhas | **7** assinaturas, todas `SECURITY INVOKER`, dono `postgres` — **sem sobrecargas** | **SIM** |
| 4 | `4.dependencias`: só RPC→RPC da mesma família; nenhuma view dependente/policy | Só `congelar→reabrir` e `promover/transferir→remapear`; **nenhuma** view/policy depende das views | **SIM** |
| 5 | `5.membros`: anon/authenticated sem herança de outras roles | `authenticator` (sem herança) e `postgres` são membros **delas**; **anon e authenticated não são membros de nenhuma role** ⇒ nada a herdar | **SIM** |
| 6 | `6.pgrst_schemas`: define a exposição potencial pela API | **Sem linhas** — o Supabase não guarda `pgrst.db_schemas` na config da role. **Não determinável por SQL.** Verificar no painel: *Project Settings → Data API → Exposed schemas*. **Não bloqueia** (a revogação é correta de qualquer forma) | **N/D — não bloqueia** |

**Diferenças que IMPEDIRIAM a aplicação (nenhuma ocorreu):** executar como role que não seja `postgres`/membro; grantee extra com acesso aos alvos que anon/authenticated herdem; concedente ≠ dono; mais de 7 assinaturas usadas por cliente externo; qualquer view/policy dependente; dependência de função chamada por anon/authenticated.
**Achado adicional:** `anon` e `authenticated` têm **todos** os privilégios (inclusive INSERT/UPDATE/DELETE/TRUNCATE/MAINTAIN) nas 4 views — como são views agregadas (não atualizáveis), na prática só a leitura funciona; a 115 remove tudo.
**Consumidores no repositório:** as 4 views e as 7 RPCs só são usadas por 8 módulos do **backend**, todos via o cliente único `service_role` (`backend/src/config/supabase.js`); o frontend só cita os nomes em comentários e só cria cliente Supabase com a chave anon para **Auth/Realtime**. Sem Edge Functions. O responsável **declarou** que não há integração externa (Power BI, Sheets, Make, n8n etc.).

## 1. Independência (confirmada)
A 115 **não depende** de 112–114 (que não estão no banco): aplica sozinha, e 112 → 113 → 114 aplicam depois sem conflito. Provado em `perfil-exibicao-rls-115-revisao-pg` (teste "INDEPENDÊNCIA") e `perfil-exibicao-115-producao-real-pg` (schema que reproduz a produção, sem `display_operator`/114). Nenhum arquivo de implementação mudou desde então — **nenhum teste foi repetido**.

## 2. Pré-voo (no dia, antes de aplicar)
1. **Autorização escrita** do responsável (esta é a única que libera a aplicação).
2. **Backup:** em *Dashboard → Database → Backups* confirme um backup/ponto de restauração **do mesmo dia** (ou PITR ligado). Anote o horário. *(A migration só remove privilégios — não toca em dados —, então a recuperação real é o `115_rollback.sql` + o ACL "antes" arquivado em `docs/auditoria-producao-6b8-antes-da-115.txt`; o backup é a rede de segurança geral.)* Opcional: `pg_dump --schema-only` pelo responsável.
3. **Janela de baixa carga** (a migration é de milissegundos; não há downtime esperado) e responsável de plantão.
4. Conferir que ninguém está aplicando outra migration/DDL ao mesmo tempo.

## 3. Aplicação (uma execução)
1. Supabase → **SQL Editor** → *New query* (role padrão `postgres`).
2. Colar **o conteúdo inteiro** de `database/migrations/115_fecha_acesso_direto_residual.sql` (SHA-256 `10b88ee30e5ff21f…`) e **Run**.
3. Esperado: **sucesso** (a migration é uma transação; `lock_timeout` de 5 s). Pode aparecer o aviso *"MIGRATION 115: 4 views e 7 funções … fechadas"*.
4. **Se falhar**, **nada foi aplicado** (atômica). Leia a mensagem:
   * `lock_timeout` ⇒ repetir fora do pico;
   * `abortada: a role X não administra…` ⇒ executar como `postgres`;
   * `abortada e DESFEITA: … ainda teriam acesso efetivo …` ⇒ tratar a origem indicada (grant de outra role/herança) e repetir.
   **Não** use o rollback para isso (não há o que reverter).

## 4. Auditoria posterior (somente leitura)
Rodar **a mesma** `6b8-consulta-minima-115.sql` (SQL Editor, ou psql read-only) e arquivar como "depois". **Esperado:**
* `2.acl_completo`: views → só `postgres` e `service_role`; RPCs → só `postgres` e `service_role`; **nenhuma** linha `grantee=-`, `anon` ou `authenticated`;
* `3.assinaturas`: as mesmas 7; `4.dependencias` e `5.membros`: iguais às de antes; `1.sessao`: `postgres`.
Qualquer `anon`/`authenticated`/`-` remanescente ⇒ **NO-GO do pós-teste**: investigar antes de liberar (e **não** reverter às cegas).

## 5. Smoke tests
**Aplicação (usuário administrador da Central):**
1. `GET /health` ⇒ ok; login normal.
2. **Dashboard** e **CMV/Produtos** carregam (usam as views) — valores coerentes com o dia anterior.
3. **Configurações → Metas e Limites de CMV**: abrir e **salvar** (`unidade_config`; já protegida por RLS, não muda).
4. **Bonificação mensal**: lançar e **reabrir** uma competência de teste (usa `bonificacao_congelar_competencia` / `bonificacao_reabrir_competencia`).
5. **Painel SuperAdmin**: abrir uma empresa e uma unidade (e, se houver ambiente de teste, transferir/converter unidade — usam as RPCs de empresa/unidade).
6. **Checklist Operacional** com uma conta normal.
**Negativos externos** (pelo responsável, com a **chave anon pública** — a de `/api/config` —, **sem retornar linhas**):
* `GET {SUPABASE_URL}/rest/v1/vw_faturamento_diario?limit=0` ⇒ **401/403/404** (nunca 200);
* `GET {SUPABASE_URL}/rest/v1/vw_estoque_critico?limit=0` ⇒ idem;
* `POST {SUPABASE_URL}/rest/v1/rpc/bonificacao_reabrir_competencia` com corpo `{}` ⇒ **401/403/404** (nunca 200/400 de negócio).
Registrar horário e resultado.

## 6. Contingência — sem reabrir exposição
| Sintoma depois de aplicar | Ação |
|---|---|
| Tela do app com `permission denied for view/function …` | **Não** reverter. Causa provável: o backend não está usando a `service_role` (improvável: a tela de Usuários e o Dashboard dependem dela) ou há objeto fora da lista. Confirmar a chave do backend **sem expor** e, se necessário, `GRANT SELECT/EXECUTE ON <objeto> TO service_role` **só naquele objeto** |
| Consumidor externo descoberto depois | **Não** reabrir `anon`: expor o dado pelo backend, ou criar uma view `security_invoker` + policy específica com revisão |
| Falha de aplicação | nada foi aplicado — repetir conforme §3.4 |
| Rollback total inevitável | só com aprovação escrita: `115_rollback.sql` devolve **apenas** SELECT nas views e EXECUTE (PUBLIC) nas RPCs (o estado encontrado) e **não** mexe no RLS de `unidade_config`; **reauditar** em seguida e tratar a exposição de outra forma |

## 7. Critério de encerramento
Aplicação OK **e** auditoria "depois" limpa **e** smoke tests OK **e** negativos externos 401/403/404 ⇒ a correção de segurança da 115 está **concluída**. Pendências **fora** da 115: `pgrst.db_schemas` no painel (informativo), investigação de uso passado nos logs de API, validação do JWT real (20 h), e as migrations 112–114.

---
## 8. REGISTRO DA EXECUÇÃO (Checkpoint 6B.9) — migration 115 v2 APLICADA em 10/10/2026 14:52 UTC
* **Projeto:** `uqybgauuxcrqzquultfu` (DATABASE_URL e SUPABASE_URL conferidas contra o ref; credenciais nunca impressas). Role `postgres`, TLS obrigatório, `lock_timeout` 5 s da própria migration.
* **Pré-voo (todos PASS):** projeto ✔ · nenhuma migration/DDL em execução e nenhum lock nos alvos (rechecado imediatamente antes) ✔ · baixa utilização (11–12 sessões **idle**, nenhuma consulta ativa, ≈ 11 transações/s) ✔ · SHA-256 `10b88ee30e5ff21f…` = versão v2 auditada ✔ · auditoria 6b8 reexecutada: **66 linhas idênticas** ao resultado aprovado ✔ ·
  **backup:** backup do próprio Supabase **não verificável por mim** (sem acesso ao painel) → criado backup próprio: `pg_dump --schema-only --schema=public` (895 KB, íntegro, ACLs incluídos; fora do repositório) **+ script de restauração EXATA do ACL "antes"** (`docs/restore-acl-antes-115.sql`, testado: 115 → restore devolve o ACL idêntico). A migration não toca em dados.
* **Execução:** uma execução, sem erro (`NOTICE: MIGRATION 115: 4 views e 7 funções (todas as sobrecargas) fechadas`), ~3 s. Nenhum outro comando de escrita.
* **Auditoria posterior (PASS):** `docs/auditoria-producao-6b9-depois-da-115.txt`. Nas 4 views e nas 7 RPCs restaram **só `postgres` e `service_role`** (22 linhas de ACL; antes 51) — **0** ocorrências de `anon`, `authenticated` ou PUBLIC. Privilégio efetivo: `anon`/`authenticated`/`authenticator`/PUBLIC = 0 views, 0 RPCs; `service_role` = 4/4 views (leitura e escrita nominal) e 7/7 RPCs. Seções 1, 3, 4 e 5 **idênticas** às de antes.
* **Nada mais mudou (impressões digitais idênticas antes×depois):** colunas, constraints/índices, corpo das funções, definição das views, policies/RLS, triggers, **ACL de todos os demais objetos**, contagem de objetos (124 relações / 98 funções). `unidade_config`: RLS ligado, 0 policies, dono postgres — **inalterado**.
* **Smoke (seguro, sem escrita):** chave anon pública → `GET /rest/v1/vw_faturamento_diario|vw_estoque_critico|vw_produto_margem|vw_produtos_vendidos?limit=0` ⇒ **401 `42501`** (permission denied) nas 4; `POST /rest/v1/rpc/bonificacao_reabrir_competencia` e `…/excluir_organizacao_definitivamente` com `{}` ⇒ **404 `PGRST202`** (a função deixou de existir para a API); **controle** `GET /rest/v1/unidades?select=id&limit=0` ⇒ 200 `[]` (API alcança o schema `public` e o RLS segue valendo ⇒ **`public` é exposto pelo PostgREST**). App de produção: `/health` 200, `/api/config` 200, `/api/v1/me` sem login 401. Logs do Render desde 14:40Z: **0** ocorrências de `permission denied`/`42501` e **0** logs de nível erro.
* **NÃO executado (precisa de autorização separada ou ambiente de teste):** fluxos autenticados com efeito (salvar Metas de CMV, lançar/reabrir bonificação, transferir/converter unidade, painel SuperAdmin) e Dashboard/CMV logado — exigem login de usuário. Cobertura equivalente: o backend usa `service_role`, que mantém 4/4 views e 7/7 RPCs.
