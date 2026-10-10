# Como executar a auditoria somente-leitura no Supabase (instruções curtas)

**Arquivo:** `database/auditoria/6b6-catalogo-consulta-unica.sql` — **um único `SELECT`** (o SQL Editor mostra só o último resultado; por isso é uma consulta só).
Não escreve, não muda configuração e **não devolve dado de cliente nem segredo**: apenas nomes de objetos, flags, privilégios, definição de views e corpo de funções.

## Passo a passo (5 minutos, supervisionado)
1. Supabase → projeto de **produção** → **SQL Editor** → *New query*.
2. Abra `6b6-catalogo-consulta-unica.sql`, copie **tudo** e cole. Confira que há **um só comando** (um `;` no final) e que começa em `select * from (`.
3. **Run**. Deve responder em segundos, sem erro. (Se der erro, **não** tente "consertar" a consulta: copie só a mensagem de erro e envie.)
4. Exporte o resultado inteiro (**CSV** ou copiar como texto). São linhas com as colunas `secao, a, b, c, d, e, f`.
5. Envie o resultado ao responsável técnico. Guarde uma cópia como **"ANTES"** da migration 115.

**Não faça:** usar a *service_role key*, conexão externa, `psql` com credenciais, ou rodar outras consultas "para ajudar". Não cole nada além do resultado.
Alternativa com `psql`/terminal: `database/auditoria/6b5-catalogo-somente-leitura.sql` (várias seções; roda em transação `READ ONLY` com `ROLLBACK`).

## O que pode e o que não pode ser compartilhado
| Pode (é o que a consulta devolve) | Não envie nunca |
|---|---|
| nomes de tabelas/views/funções/roles, flags `true/false`, contagens | chaves (anon/service_role), tokens, JWTs, refresh tokens |
| privilégios (quem tem SELECT/EXECUTE, quem concedeu) | senhas, connection strings, `.env` |
| definição das 4 views e o corpo de `auth_unidade_ids` (código, não dados) | linhas de qualquer tabela, e-mails/telefones de clientes, capturas do painel com dados |
| `pgrst.db_schemas`, limite de linhas (config pública da API) | qualquer coisa que **não** tenha sido devolvida por esta consulta |

> A própria consulta só lê um conjunto **fixo** de chaves de configuração (`pgrst.db_schemas`, `db_extra_search_path`, `db_max_rows`, `db_anon_role`, `db_pre_request`, `db_plan_enabled`) — segredos ficam de fora (testado com um segredo de teste que **não** aparece).
> Se alguma célula parecer conter um segredo (não deveria), **não envie**; avise o responsável.

## Como interpretar (sem expor nada) — confirma ou descarta cada risco
| Seção | Risco **CONFIRMADO** se… | Risco **DESCARTADO** se… |
|---|---|---|
| `7.views` + `7b.views_acl` | `c = (nenhuma: roda como o DONO)` **e** `d/e = anon_select=true / auth_select=true`, ou `7b` lista `anon`, `authenticated` ou `0` (=PUBLIC) com SELECT | `c` contém `security_invoker=true`, **ou** `7b` não lista nenhum privilégio |
| `8.unidade_config` | `b = rls_ligado=false` (e `f` mostra `anon_upd=true`) | `b = rls_ligado=true` **e** `e = policies=0` (ou policies adequadas) |
| `10.rpcs` | `e`/`f` com `anon=true` ou `authenticated=true`, ou `public=true` | tudo `false` e `service_role=true` |
| `9.sem_rls` | qualquer linha (tabela sem RLS) | nenhuma linha |
| `16.auth_unidade_ids` | corpo **sem** `display_operator` ⇒ a 114 **ainda não** está aplicada | corpo com `display_operator` |
| `2c.impressao` | `false` ⇒ aquela migration **não** está aplicada | `true` |
| `7b.quem_concedeu` | concedente ≠ dono (ex.: `supabase_admin`) ⇒ a `REVOKE` da 115 **não** removeria; tratar antes | só o dono |
| `6.pgrst` | `pgrst.db_schemas` inclui `public` (esperado) — a API **enxerga** o schema | — |
| `12.fora_de_public` / `11.funcoes_expostas` | linhas inesperadas ⇒ outros objetos expostos (item próprio) | só o esperado (auxiliares de RLS, `fn_custo_*`) |
| `3`/`4`/`5` | `authenticated`/`anon` com atributos fora do padrão (ex.: `rolbypassrls=true` em anon) | padrão do Supabase |
| `14.publicacao_realtime` | tabelas sensíveis publicadas (o RLS filtra, mas registre) | — |

Resultado esperado **hoje** (se a produção seguir o repositório): views **confirmadas**, `unidade_config` **confirmada**, 7 RPCs **confirmadas**, `16` sem `display_operator`.
Resultado esperado **depois** da 115 (e da 114): tudo "descartado" e `2c` com `true` nas linhas 114/115.
