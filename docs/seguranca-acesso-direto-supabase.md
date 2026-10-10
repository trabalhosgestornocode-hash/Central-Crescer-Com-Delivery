# Acesso direto ao Supabase pela conta de exibição — auditoria e plano (Checkpoint 6B.4)

> **ATUALIZAÇÃO 6B.7 — resultado da auditoria de PRODUÇÃO (informado pelo responsável):** PostgreSQL 17.6 · as 4 views `vw_*` têm SELECT para anon/authenticated e rodam como o dono (**confirmado**) ·
> as 7 RPCs são executáveis por anon/authenticated/PUBLIC (**confirmado**) · **`unidade_config` JÁ tem RLS ligado e nenhuma policy ⇒ o risco B (leitura/escrita livre) está DESCARTADO em produção** (o repositório
> não liga esse RLS: é divergência de schema; hipótese a verificar com `database/auditoria/6b7-consulta-complementar.sql`: gatilho de evento do Supabase que liga RLS em tabelas novas, ou ação manual) ·
> `display_operator` e a 114 **ainda não** estão no banco. A migration 115 foi **reescrita (v2)** para escopo mínimo e somente-remoção — ver `docs/plano-migration-115-correcao-de-seguranca.md`.
> Onde este documento fala em "115 liga o RLS de `unidade_config`", leia: **só se estiver desligado**; em produção não toca nela.

**Pergunta:** a conta `display_operator` (a TV) alcança dados fora do Checklist **sem passar pelo backend**, falando com a API
REST/RPC do Supabase (chave `anon` pública + o JWT da própria conta, que fica no navegador da loja)?

**Método.** O schema REAL do repositório (migration base + 068…114/115) foi montado num Postgres local descartável, com
stubs do Supabase (roles `anon`/`authenticated`/`service_role`, schemas `auth`/`storage`/`realtime`) e os privilégios padrão
que o Supabase concede em `public`. Cada papel foi medido **como o PostgREST o executaria** (papel + claim `sub`):
tabelas visíveis, linhas alteráveis e se um INSERT novo passa pela policy — em **87 tabelas** semeadas (uma linha na unidade A1
e outra na B1). Teste: `backend/test/perfil-exibicao-rls-schema-real-pg.test.js` (18 testes).
**Limite:** reflete as migrations do repositório, não o estado ao vivo da produção (alterações feitas à mão no painel do
Supabase, versão do Postgres e grants reais **não** foram verificados). Para fechar isso, rode o SQL de conferência da seção 7
no SQL Editor (somente leitura).

## 1. Matriz de acesso direto (tabelas com `unidade_id`/`organizacao_id`, 87 semeadas)

Células: tabelas **lidas / alteradas / INSERT permitido** (a unidade B1 e a empresa B nunca aparecem, exceto para a própria empresa B).

| Papel (como o RLS enxerga) | ANTES da 114 | DEPOIS da 114 |
|---|---|---|
| **Conta da TV** (só unidade A1, `display_operator`) | **27 / 26 / 9** | **0 / 0 / 0** |
| Viewer só de unidade A1 | 27 / 26 / 9 | 27 / 26 / 9 (idêntico) |
| Unidade A1 "herda" + empresa A (operations) | 61 / 43 / 15 | idêntico |
| Gestor de empresa A | 27 / 10 / 5 | idêntico |
| Financeiro de empresa A | 27 / 10 / 5 | idêntico |
| Viewer da empresa B | lê só a própria empresa (B1: 27) | idêntico |
| Estranho (sem vínculo) / `anon` | 0 / 0 / 0 | idêntico |
| `service_role` (o backend) | 85 / 82 / 24, nas duas unidades | idêntico |

* **Antes da 114** a TV lia **e escrevia** direto vendas, estoque, bonificação, parser, notas fiscais etc. da unidade dela
  (as policies `rls_*_tenant` são `for all` e cegas ao papel); nunca de outra unidade/empresa.
* **Depois da 114** nenhuma tabela é legível, alterável ou aceita INSERT. (2–4 tabelas dão erro **anterior** à policy no
  probe de INSERT — coluna gerada, trigger — mas todas têm leitura e alteração negadas.)
* **Os outros papéis não mudam em nada**, tabela por tabela (comparação exata antes × depois, inclusive `anon` e `service_role`).
* O Checklist **continua funcionando**: o backend usa `service_role`, que ignora RLS e segue vendo tudo.

## 2. Policies (88 em `public`) — o que depende de quê

| Dependência | Qtde | Display após a 114 |
|---|---|---|
| `auth_unidade_ids()` | 38 | nada (função passou a ignorar o papel) |
| `auth_organizacao_ids()` | 33 | nada (a conta de exibição **não tem** vínculo de empresa; a 113 barra o papel em `usuarios_organizacoes`) |
| próprio usuário / superadmin (`rls_*_self`, `plataforma_*`…) | 17 | só as linhas do próprio usuário (vínculo, sessões, perfil) e catálogo `modulos`/`planos` ativos (legível por qualquer autenticado — pré-existente, baixa sensibilidade) |
| 36 tabelas com RLS ligado e **sem** policy | — | negam tudo a authenticated/anon (estilo "lockdown" da migration 001) |

A 114 sozinha cobre **as 71 policies** que dependem dos dois auxiliares **porque ambas passam por `auth_unidade_ids()`/`auth_organizacao_ids()`**;
a de empresa já era inalcançável para a conta de exibição. **Mas a 114 sozinha NÃO fecha tudo** (seção 3).

## 3. Caminhos ALTERNATIVOS encontrados (não cobertos pela 114)

Todos **pré-existentes** e válidos para qualquer papel (até `anon`), mas furam o "só Checklist" da TV:

| # | Achado | Gravidade | Prova (teste) | Fecha com |
|---|---|---|---|---|
| A | **4 views `vw_*` sem `security_invoker`** rodam como o dono e ignoram o RLS: `vw_faturamento_diario` (e as de estoque/margem/produtos vendidos) devolvem linhas de **todas as unidades** a `authenticated` e a **`anon`** | **Alta** (vazamento entre empresas, sem login) | `ACHADO PRÉ-EXISTENTE (views)`: a TV, um estranho e `anon` leem as 2 unidades | **115**: `REVOKE` nas 4 views (só o backend as lê) |
| B | **`unidade_config`** (metas/limites de CMV) é a **única** tabela de `public` **sem RLS**: leitura **e escrita** por `anon`/`authenticated` em qualquer unidade | **Alta** (escrita anônima) | `ACHADO PRÉ-EXISTENTE (unidade_config)` | **115**: `ENABLE ROW LEVEL SECURITY` sem policy |
| C | **7 funções de negócio SECURITY INVOKER** (+ `fn_custo_produto`/`fn_recalc_custo`, utilitárias de cálculo mantidas) (`converter_empresa_para_unidade`, `excluir_organizacao_definitivamente`, `promover_unidade_para_empresa`, `transferir_unidade_organizacao`, `remapear_…`, `bonificacao_congelar/reabrir_competencia`) expostas em `/rpc` a `anon`/`authenticated`; hoje só o RLS as segura | Média (defesa em profundidade) | RPCs chamadas pela TV não alteram dados; `EXECUTE` revogado após a 115 | **115**: `REVOKE EXECUTE` de public/anon/authenticated, `GRANT` a `service_role` |
| D | Funções SECURITY DEFINER alcançáveis: só os 6 auxiliares de RLS (`auth_*`, `is_platform_superadmin`, `tem_grant_realtime`), todos com `search_path=public` e que só devolvem dados do **próprio chamador**; as de `pgcrypto` são utilitárias | Baixa | catálogo | nada |
| E | Realtime: a policy de `realtime.messages` exige **grant vivo e próprio** do tópico (testado: grant de outro usuário, vencido ou de outra unidade não vale) | OK | teste "Realtime" | nada |
| F | Storage: 3 buckets privados; **sem policies em `storage.objects` no repositório** (padrão do Supabase = negar) | Verificar em produção | — | conferência (seção 7) |
| G | O RLS das tabelas `for all` deixa **qualquer papel de unidade ESCREVER direto** (ex.: "consulta" altera vendas da unidade) | Média, pré-existente, **fora do 6B** | matriz: viewer altera 26 tabelas | auditoria própria (policies por papel) |

## 4. SECURITY DEFINER, `search_path`, privilégios (114)
* `CREATE OR REPLACE` **preserva** dono, ACL e `SECURITY DEFINER`; só o corpo muda (testado: `proacl|dono|prosecdef|proconfig` idênticos antes e depois).
* `search_path=public` continua fixo (sem sequestro por schema); o corpo usa `usuarios_unidades` (resolvido em `public`) e `auth.uid()` qualificado.
* `papel IS DISTINCT FROM 'display_operator'` mantém vínculos com papel `NULL` ("herda da empresa") — testado.

## 5. Compatibilidade, ordem, falhas e reversão
* **Ordem:** 112 (commit) → 113 → 114 → 115. A 114 **falha** se a 112 não existe ("invalid input value for enum") e não deixa nada pela metade (testado);
  a 115 não depende das anteriores. Aplicadas em sequência no schema real: **sem nenhuma falha**.
* **Idempotência:** as quatro rodam duas vezes sem erro (`create or replace`, `revoke`/`grant`, `enable row level security`).
* **Bloqueios na publicação:** todas usam `lock_timeout = 5 s` → se uma transação longa segurar o objeto, **falham sem aplicar** e sem formar fila
  (basta repetir). 114: lock leve na função; 115: `ENABLE RLS` em `unidade_config` (tabela pequena) é o único lock forte e curto.
* **Dados existentes:** nenhuma das quatro altera linha de dado (testado para 112/113 com todos os papéis antigos).
* **Reversão (ordem inversa):** `115_rollback` (devolve os privilégios padrão e desliga o RLS de `unidade_config`) → `114_rollback`
  (corpo original; **reabre** o acesso direto da TV — só reverta junto com a retirada do papel) → `113_rollback` → `112_rollback` (aborta
  se o papel estiver em uso; o valor do enum é permanente). Rollbacks testados.
* **Impacto no app:** nenhum consumidor direto das views/`unidade_config`/RPCs além do backend (`service_role`): conferido por busca no repositório
  (o frontend só usa o Supabase para Auth e Realtime).

## 6. Resultado
Para a conta de exibição, **114 + 115** removem todos os caminhos de dados **fora do Checklist** encontrados no schema do repositório.
Sem a 115, a TV (e qualquer pessoa, até anônima) ainda lê o faturamento de todas as unidades pela view e escreve em `unidade_config`.

## 7. Conferência SOMENTE-LEITURA na produção (para o responsável rodar no SQL Editor — nenhum dado alterado)
```sql
-- 1) tabelas de public SEM RLS
select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity;
-- 2) views de public e se rodam como dono
select c.relname, c.reloptions from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m');
-- 3) corpo atual de auth_unidade_ids (deve ser o ORIGINAL, sem display_operator, até a 114)
select prosrc from pg_proc where proname = 'auth_unidade_ids';
-- 4) funções executáveis por anon/authenticated
select p.proname, p.prosecdef from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) order by 1;
-- 5) policies em storage.objects e versão do Postgres
select policyname, cmd, roles from pg_policies where schemaname = 'storage'; select version();
```
