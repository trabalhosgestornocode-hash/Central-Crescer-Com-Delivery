# Multi-perfil — validação em produção (deploy controlado — Caminho B)

**Data:** 2026-09-02 05:30–06:00 UTC
**Status:** ⏸️ **PRONTO PARA A PRIMEIRA ESCRITA — aguardando o "go".** Os 4 gates obrigatórios estão **✅ confirmados**. Nenhuma migration aplicada, nenhum deploy, nenhuma escrita em produção (só `SELECT` e `pg_dump`).

> Caminho B aprovado (deploy do lote: multi-perfil + iFood + Inteligência + Painel Administrativo). Instrução: *"NÃO FAÇA A PRIMEIRA ESCRITA ANTES DE ME MOSTRAR QUE OS TRÊS [pré-checks 056/059/061] PASSARAM."*

---

## GATE 1 — Inventário ✅

Produção `uqybgauuxcrqzquultfu` — Postgres **17.6**. Conexão direta via `psql` **confirmada** (`postgres@db.uqybgauuxcrqzquultfu.supabase.co:5432`).

### Estado REAL das migrations em produção (verificado no banco)

| Migration | Feature | Aplicada? | Evidência |
|---|---|---|---|
| `001`–`055` | base | ✅ SIM | — |
| **`056` iFood** | iFood | ✅ **JÁ APLICADA** | `ifood_conexoes`, `ifood_credenciais`, `ifood_oauth_sessoes` **existem** |
| `057` unidade dados contato | base | ✅ SIM | `unidades.responsavel`, `unidades.email` existem |
| `058` unidade_config | base | ✅ SIM | tabela `unidade_config` existe |
| **`059` Inteligência** | Inteligência | ❌ **NÃO** | `modulos` sem `id='inteligencia'` |
| **`060` perfis_operacionais** | multi-perfil | ❌ **NÃO** | sem tabela `perfis_operacionais`, sem coluna `perfil_id` |
| **`061` Painel Administrativo** | Painel Adm | ❌ **NÃO** | sem tabela `painel_administrativo_usuarios` |
| **`062` CHECK XOR** | multi-perfil | ❌ NÃO | (depende de 060) |
| **`063` perfil_id NOT NULL + UNIQUE** | multi-perfil | ❌ NÃO | UNIQUE atual ainda é `(usuario_id, X)` |
| **`064` PIN nonce + RPCs** | multi-perfil | ❌ NÃO | (depende de 060) |

**Sequência real a executar: `059`, `060`, `061` → deploy → `062`, `063`, `064`.** (`056` já está aplicada — **NÃO reaplicar** — embora seja idempotente.)

---

## GATE 2 — Git limpo ✅

`main`, HEAD anterior = `95b3858` (= `origin/main`, deployado hoje). **4 commits novos**, working tree **LIMPA**:

| Commit | Escopo | Arquivos |
|---|---|---|
| `495c112` `feat(ifood)` | módulo `ifood/`, `shared/cripto.js`, `frontend/src/ifood*.js`, migration `056`, 7 testes | 25 |
| `4423e5a` `feat(inteligencia)` | módulo `inteligencia/`, `frontend/src/{config,router,views,api,agentePainel,dashboardExecutivo}.js`, migration `059`, 2 testes | 12 |
| `24509fc` `feat(painel-administrativo)` | módulo `administrativo/`, `frontend/src/painelAdm*.js`, `encaminhamento.js`, migration `061`, 4 testes | 15 |
| `c904cb7` `feat(multi-perfil)` | `sessao/*`, `usuarios/*`, `shared/{pin,profileSelectionToken,identidade,contextToken,ApiError,auditoria,modulos}.js`, `agente/*`, controllers Fase I, `frontend/src/{app,sessao,state,selecaoPerfil,adminApi,adminViews,styles.css,index.html}`, migrations `060`/`062`/`063`/`064`, 8 testes, 12 docs. **Carrega os pontos de integração compartilhados** (`auth.js`, `routes.js`, `plataforma.*`) das 4 features. | 68 |

`node --check src/app.js` ✅ · `import('./src/app.js')` carrega ✅. **Nada pushado** — `origin/main` segue em `95b3858`.

> Nota: os arquivos de entrypoint (`auth.js`, `routes.js`, `plataforma.{routes,controller,usuarios.service,repo}.js`, `auditoria.js`, `modulos.js`) têm hunks das 4 features misturados sem fronteira — ficaram no commit `c904cb7`. Split cirúrgico foi descartado (Caminho B). A árvore é **internamente consistente** (testes abaixo).

---

## GATE 3 — Backup ✅

`pg_dump` de produção (**READ-ONLY**), local em `scratchpad/backup-prod-20260902T053712Z/`:

| Arquivo | Tamanho | Timestamp | Conteúdo |
|---|---|---|---|
| `schema-public.sql` | 252 KB | 2026-09-02T05:37:37Z | DDL completo do schema `public` |
| `data-afetadas.sql` | 1,18 MB | 2026-09-02T05:37:54Z | dados de `perfis`, `usuarios_organizacoes`, `usuarios_unidades`, `agente_conversas`, `sessoes_contexto` |
| `constraints-antes.txt` | 869 B | 2026-09-02T05:37:56Z | definições exatas das constraints (rollback preciso da `063`) |

**Rollback SQL** documentado no rodapé de cada migration (`056`/`059`/`060`/`061`/`062`/`063`/`064`) — todos `drop … if exists`, transacionais.

⚠️ **Recomendação:** antes do "go", criar também um **backup/PITR pelo painel Supabase** (Database → Backups). O dump local é rede de segurança; o PITR é a restauração de verdade.

---

## GATE 4 — Pré-checks ✅ TODOS PASSAM

### 056 (iFood) — **JÁ APLICADA** (análise só para o registro)

| Item | Resultado |
|---|---|
| 1. Tabelas criadas | `ifood_conexoes`, `ifood_credenciais`, `ifood_oauth_sessoes` (3 novas) |
| 2. Tabelas alteradas | **nenhuma** |
| 3. Funções/triggers/policies | `ifood_touch_atualizado_em()` + 3 triggers + 1 RLS policy condicional |
| 4. Inserts/seeds | **nenhum** |
| 5. Constraints | só nas 3 tabelas novas (FK, CHECK de status, UNIQUE `(conexao_id, app_type)`) |
| 6. Dependências | `organizacoes`/`unidades`/`perfis` ✅; helpers `auth_organizacao_ids`/`auth_unidade_ids`/`is_platform_superadmin` ✅ (presentes → policy criada) |
| 7. Risco em dados existentes | **ZERO** — "Nenhum dado existente é tocado" |
| 8. Compat backend atual | ✅ transparente |
| 9. Rollback | `drop table … cascade` (×3) + `drop function` |
| 10. Aditiva ou destrutiva | **100 % ADITIVA** |

### 059 (Inteligência) — pendente, **SEGURA** ✅

| Item | Resultado |
|---|---|
| 1. Tabelas criadas | **nenhuma** |
| 2. Tabelas alteradas | **nenhuma** |
| 3. Funções/triggers/policies | **nenhum** |
| 4. Inserts/seeds | **1 linha** em `modulos`: `('inteligencia','Inteligência (seção)','operacao',16)` `ON CONFLICT DO UPDATE`. **Zero concessões** (`organizacao_modulos`/`unidade_modulos` intactos) — módulo entra FECHADO para todos |
| 5. Constraints | **nenhuma** (não toca o CHECK de `modulos.categoria`) |
| 6. Dependências | `modulos` ✅, `organizacao_modulos` ✅, `unidade_modulos` ✅; CHECK `categoria` aceita `'operacao'` ✅; **sem colisão** — nenhum módulo com `ordem=16`, `id='inteligencia'` ainda não existe |
| 7. Risco em dados existentes | **ZERO** — 1 linha de catálogo, concedida a ninguém |
| 8. Compat backend atual | ✅ um módulo que ninguém tem = invisível |
| 9. Rollback | `delete from unidade_modulos/organizacao_modulos/modulos where … = 'inteligencia'` |
| 10. Aditiva ou destrutiva | **ADITIVA** (1 INSERT) |

### 061 (Painel Administrativo) — pendente, **SEGURA** ✅

| Item | Resultado |
|---|---|
| 1. Tabelas criadas | `painel_administrativo_usuarios` (PK `usuario_id → auth.users`, `ativo`, `criado_por`, `observacao`, timestamps) |
| 2. Tabelas alteradas | **nenhuma** |
| 3. Funções/triggers/policies | 1 trigger (`trg_padmadm_upd` → reusa `set_updated_at()` ✅) + 1 RLS policy (`rls_padmadm_self`) |
| 4. Inserts/seeds | **nenhum** (concessão do 1º acesso está comentada) |
| 5. Constraints | PK + 2 FKs → `auth.users`, só na tabela nova |
| 6. Dependências | `auth.users` ✅, `set_updated_at()` ✅, `is_platform_superadmin()` ✅ |
| 7. Risco em dados existentes | **ZERO** — "esta migration não toca superadmin nem vínculos" |
| 8. Compat backend atual | ✅ o backend `95b3858` não consulta essa tabela. **O backend NOVO consulta em `requireAuth`** → **`061` DEVE ser aplicada ANTES do deploy** (está na sequência) |
| 9. Rollback | `drop table if exists painel_administrativo_usuarios` |
| 10. Aditiva ou destrutiva | **100 % ADITIVA** |

**Regra atendida:** `059` e `061` são aditivas, backward-compatible, sem perda de dados, com rollback conhecido, compatíveis com o lote. `056` já está aplicada. → **prossegue.**

### 060 (multi-perfil) — revalidado imediatamente antes (05:46 UTC)

| # | Check | 05:35 | 05:46 | Esperado |
|---|---|---|---|---|
| 1 | `perfis` (contas) | 37 | **37** | — |
| 3 | perfis sem nome | 0 | (est.) | 0 |
| 4 | `usuarios_organizacoes` órfãos | 0 | **0** | **0** |
| 5 | `usuarios_unidades` órfãos | 0 | **0** | **0** |
| 6 | `agente_conversas` órfãs | 0 | (est.) | **0** |
| 7 | `sessoes_contexto` órfãs | 0 | **0** | **0** |
| 8 | sessões vivas a revogar | 6 | **6** | (informativo) |
| — | duplicatas `(usuario_id, org)` / `(usuario_id, unidade)` | 0 / 0 | (est.) | **0 / 0** |
| 11 | sessões de impersonação (perfil_id fica NULL) | 32 | — | (informativo) |

**Sem alteração. Nenhum órfão. `060` segura.** O backfill de `sessoes_contexto.perfil_id` exclui as 32 impersonações (`… and impersonado_por is null`) → a CHECK XOR da `062` fica coerente para 100 % das linhas.

---

## TESTES (na HEAD commitada `c904cb7`) ✅

| Suite | Total | Pass | Fail | Skip |
|---|---|---|---|---|
| Backend | 1457 | **1402** | 52 | 3 |
| Frontend | 215 | **215** | 0 | — |

**As 52 falhas são as MESMAS pré-existentes** (baseline da Fase J = 52). Categorias: testes de integração iFood (`concluirAutorizacao`, `trocarAuthorizationCodePorToken`, `refresh falha…` — precisam de merchant/API de teste) + fixtures de bonificação/parser ("unidade de teste tem os 11 indicadores", "réplica da Subway Saci"). **Zero falha em multi-perfil / PIN / seleção / Context Token / sessão / autorização / identidade.** `node --test` grep por termos multi-perfil → só bate em `authorizationCode` do iFood.

---

## PLANO DE EXECUÇÃO (Render = 1 serviço; deploy de backend+frontend é atômico no `git push`)

| Passo | Ação | Escrita? | Reversível |
|---|---|---|---|
| **1** | Backup PITR no painel Supabase | não (é backup) | — |
| **2** | `psql -f 059` → pós-check (`select … from modulos where id='inteligencia'` = 1; grants = 0) | **1ª ESCRITA** | `delete … 'inteligencia'` |
| **3** | `psql -f 060` → pós-check (`perfis_operacionais` = 37; `id==conta_id` em todos; `usuarios_organizacoes.perfil_id`/`usuarios_unidades.perfil_id`/`agente_conversas.perfil_id` preenchidos; `sessoes_contexto` — 0 vivas, 6 revogadas com motivo `migracao_060_multi_perfil`; nenhum vínculo/conversa perdido) | sim | rodapé da `060` |
| **4** | `psql -f 061` → pós-check (`painel_administrativo_usuarios` existe; superadmins e vínculos inalterados) | sim | `drop table` |
| **5** | `git push origin main` → Render builda e deploya backend+frontend (~2–5 min, plano free) | — | reverter commit + push |
| **6** | **Smoke backend** (conta real de 1 perfil — só leitura): `GET /me` 200 · `GET /sessao/perfis` (1 perfil, sem 500) · `GET /sessao/acessos` · login legado sem tela/PIN · `GET /administrativo/ping` (403 esperado p/ não-autorizado, não 500) · rotas iFood/inteligência sem 500 · painel SuperAdmin abre | não | — |
| **7** | `psql`: `delete from sessoes_contexto where perfil_id is null and impersonado_por is null;` (limpa sessões-gap criadas pelo backend antigo entre o passo 3 e o 5 — dead rows) | sim (só linhas mortas) | — |
| **8** | `psql -f 062` → pós-check (constraint `sessoes_contexto_perfil_xor_impersonacao` existe; insert malformado falha) | sim | `drop constraint` |
| **9** | `psql -f 063` → pós-check (`uo_perfil_org_unico`/`uu_perfil_uni_unico` existem; `perfil_id` NOT NULL nas 2 tabelas) | sim | rodapé da `063` |
| **10** | `psql -f 064` → pós-check (`sessoes_contexto.selecao_nonce`, `perfis_operacionais.pin_atualizado_em`, funções `perfil_pin_registrar_*`) | sim | rodapé da `064` |
| **11** | **Fixture de teste** (produção): criar conta `Operacional Teste MultiPerfil` (e-mail de teste), perfil `Fulana Teste 1` (PIN + org/unidade de teste A), adicionar `Fulana Teste 2` (PIN 2 + org/unidade de teste B). **Verificar se já existem org/unidade `eh_teste=true` antes de criar** | sim (só fixture) | desativar/excluir a conta de teste |
| **12** | **E2E** — 2 navegadores independentes: login X → Fulana 1 → PIN 1 → Empresa A → app; outro navegador → Fulana 2 → PIN 2 → Empresa B → app; voltar ao 1º → Fulana 1 segue logada | leitura + 2 sessões | — |
| **13** | Logout isolado · bypass de PIN (via API, só fixture) · isolamento empresa (via API, só fixture) · lockout (mínimo de tentativas na fixture) · usuário legado de 1 perfil (só leitura) · superadmin/impersonação (smoke) | fixture apenas | — |
| **14** | Monitorar ~30 min: 5xx, taxa de 409 (re-seleção — esperada uma vez por usuário), erros em `/sessao/*` | — | — |

**Janela (impacto da 060):** apenas **6 sessões vivas** serão revogadas → 6 usuários (no máximo) re-selecionam empresa/unidade uma vez. JWT/senha/dados/vínculos **intactos**. Momento de baixíssimo uso.

**Critérios de rollback (Regra 24):** 5xx generalizado · auth quebrado · usuário legado não entra · vínculo/conversa perdido · permissão vazando · PIN bypassável · sessões irmãs se derrubando · painel SuperAdmin quebrado · inconsistência de FK.

---

## Seções E–P (pós-check / deploy / smoke / fixture / E2E / …)

**Pendentes — a executar nos passos 2–14 acima, após o "go".**

---

## Q. Erros observados

Nenhum. Só `SELECT` e `pg_dump`.

## R. Rollback disponível

* Backup local `20260902T053712Z` + rollback SQL por migration.
* Código: `git reset` / reverter os 4 commits (nada pushado ainda; `origin/main` = `95b3858`).
* Supabase PITR (a criar no passo 1).

---

## S. Veredito parcial

> ## ⏸️ 4 GATES CONFIRMADOS — PRONTO PARA A PRIMEIRA ESCRITA
>
> * ✅ **Inventário** — `056`/`057`/`058` já aplicadas; pendentes **`059`, `060`, `061`, `062`, `063`, `064`** nessa ordem lógica.
> * ✅ **Git** — 4 commits (`feat(ifood)` · `feat(inteligencia)` · `feat(painel-administrativo)` · `feat(multi-perfil)`), working tree limpa, HEAD carrega. Nada pushado.
> * ✅ **Backup** — `pg_dump` schema + dados afetados (local, 05:37 UTC) + rollback SQL por migration. *(Recomendo somar PITR no painel.)*
> * ✅ **Pré-checks** — `056` já aplicada; **`059` e `061` são 100 % aditivas, sem risco**; **`060` revalidado — todos os checks 0/limpos, 6 sessões vivas**.
> * ✅ **Testes** — 1402/1457 backend (52 pré-existentes, **0 multi-perfil**), 215/215 frontend.
>
> **Aguardando o "go" para o PASSO 1 (backup PITR) + PASSO 2 (primeira escrita: `psql -f 059`).** A partir daí sigo o plano de execução acima até `✅ LOTE VALIDADO EM PRODUÇÃO` ou `❌ REVERTIDO — MOTIVO`.

---

## NÃO FIZ (respeitado)

Nenhuma migration aplicada · nenhum deploy · nenhum `git push` · nenhuma escrita em produção · nenhum split cirúrgico · nenhum teste destrutivo/carga · nenhum dado de cliente tocado · nenhuma feature reaplicada (`056` fica como está).
