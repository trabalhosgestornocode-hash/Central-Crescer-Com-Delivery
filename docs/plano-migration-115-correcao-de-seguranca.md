# Plano independente — Migration 115 v2 como correção de segurança (Checkpoint 6B.7)

> **PROPOSTA. Nada foi aplicado.** A 115 é uma correção de segurança **própria**, **independente** das migrations 112–114 (provado: aplica sozinha num schema sem elas, e as três aplicam
> depois sem conflito). Pode ser publicada antes, depois ou sem o perfil Operador de Exibição. **Versão 2 (6B.7):** reescrita à luz da auditoria de **produção**.

## 1. O que a auditoria de produção confirmou (6B.6 — informado pelo responsável; 6B.8 acrescentou donos/concedentes/INVOKER)
| Fato confirmado | Consequência para a 115 v2 |
|---|---|
| PostgreSQL **17.6** | A 115 não usa nada dependente de versão (não usa `security_invoker`). Testada em 17.4. |
| 4 views `vw_*` pertencem a **postgres**, rodam com o privilégio do **dono**, **SELECT para anon e authenticated**, privilégios **concedidos por postgres** | **Risco confirmado.** A `REVOKE` do dono (postgres) **alcança** esses grants (mesmo concedente). A pré-condição passa quando executada como postgres. |
| 7 RPCs pertencem a **postgres**, **SECURITY INVOKER**, EXECUTE para **anon, authenticated e PUBLIC** | **Risco confirmado.** INVOKER ⇒ rodam com os direitos de quem chama (por isso hoje só o RLS as segura). A 115 revoga de PUBLIC/anon/authenticated. |
| `unidade_config` **já tem RLS ligado e nenhuma policy** | **Risco DESCARTADO em produção.** A v2 **não a toca** quando o RLS já está ligado (nem lock); só liga se estiver desligado (ambientes novos). Nunca mexe em policies; o rollback **nunca** desliga o RLS. |
| `display_operator` e as migrations 112–114 **não estão** no banco | A 115 independe delas — não presumi nada parcialmente aplicado. |

**Ainda NÃO conhecido (o texto linha a linha não foi entregue a mim) e que a consulta mínima `6b8-consulta-minima-115.sql` resolve numa só execução:** (a) se existem **outros grantees** além de PUBLIC/anon/authenticated/service_role/postgres nos alvos;
(b) se há **sobrecargas** além das 7 assinaturas; (c) o que **dentro do banco** referencia as views/RPCs (funções, views, policies); (d) **herança** — roles de que anon/authenticated são membros; (e) `pgrst.db_schemas` (define a **exposição potencial** pela API).
Como cada divergência dessas é tratada **de forma segura pela própria migration** (seção 4) ou **só muda a classificação** (item e), elas **não impedem pedir a autorização**; elas decidem se a aplicação segue (seção 5).

## 2. O que a v2 faz (escopo mínimo, somente remoção)
* `REVOKE ALL` nas 4 views e nas 7 funções (todas as sobrecargas, por nome) de **PUBLIC, anon e authenticated**.
* **Nenhum GRANT novo.** Única exceção defensiva: se, depois da revogação, a `service_role` perdeu o acesso **efetivo** (ele vinha só via PUBLIC), devolve **a ela** o que já tinha (SELECT/EXECUTE).
* `unidade_config`: se o RLS já estiver ligado (caso da produção) → **nada** (nem lock); se desligado → liga. Policies intocadas.
* **Pré-condição (falha segura):** se a role que executa não administra algum alvo (não é dono nem membro do dono) → **aborta**, lista os objetos, nada é alterado.
* **Pós-condição (falha segura), por privilégio EFETIVO:** se `anon` ou `authenticated` ainda tiverem qualquer acesso a um alvo — por grant de **outra** role (que a `REVOKE` do dono não alcança) **ou por herança** de outra role — **aborta e desfaz tudo**, listando objeto, role e origem. Nunca deixa exposição parcial.
* Uma transação, `lock_timeout = 5 s`, idempotente. Não altera dados, policies, funções auxiliares de RLS (`auth_*`, `is_platform_superadmin`, `tem_grant_realtime`), `fn_custo_*` nem qualquer outro objeto.

## 3. Evidências (Postgres descartável; schema que **reproduz** a produção; só dados sintéticos)
`perfil-exibicao-115-producao-real-pg.test.js` (**13 testes**, todos passam; inclui o aborto por herança) + `perfil-exibicao-rls-115-revisao-pg.test.js` (9) + `perfil-exibicao-rls-schema-real-pg.test.js` (18):
| Verificação | Resultado |
|---|---|
| Reprodução do estado de produção (PG17, views do dono com SELECT anon/auth, 7 RPCs PUBLIC, `unidade_config` com RLS e 0 policies, sem `display_operator`, sem 114) | ✔ |
| **Antes:** anon e authenticated leem as 2 unidades pelas views e executam as RPCs (privilégio SQL comprovado, dados sintéticos) | ✔ confirmado |
| **Depois:** anon/authenticated (estranho, gestor, viewer) → `permission denied` nas 4 views e nas 7 RPCs | ✔ |
| **Nenhuma ampliação:** nenhum privilégio novo em NENHUM objeto de `public`; só saem entradas de PUBLIC/anon/authenticated das 4 views e das 7 funções; service_role/dono mantêm tudo | ✔ |
| `unidade_config`: RLS ligado e **0 policies** exatamente como estavam; com policies existentes, **preservadas**; **não toma lock** (aplica em < 4 s com outra transação segurando a tabela) | ✔ |
| Backend (service_role): lê as 4 views (Dashboard/CMV), lê/grava `unidade_config`, executa as 7 RPCs (bonificação, funções administrativas) sem `permission denied` | ✔ |
| Usuários existentes: matriz de tabelas **idêntica** antes×depois (viewer, "herda", gestor, financeiro, outra empresa, estranho, anon, service_role) | ✔ |
| Acesso direto por anon e authenticated: tabelas sob RLS (anon não vê nada); `unidade_config` nega | ✔ |
| Pré-condição (role sem posse) → aborta, nada muda; pós-condição (privilégio de outro concedente) → aborta e **desfaz tudo**, e aplica depois de remediar | ✔ |
| Idempotência (2ª execução não muda nada); service_role que dependia só de PUBLIC mantém o acesso | ✔ |
| Rollback: devolve **só** o estado encontrado (views: SELECT; RPCs: EXECUTE a PUBLIC), **não** desliga o RLS; reaplicar fecha de novo | ✔ |

## 4. Se o catálogo de produção diferir (a v2 reage assim)
| Divergência | Comportamento | Ação |
|---|---|---|
| Role do SQL Editor **não** é dona dos alvos | **aborta** (nada muda) listando objetos | rodar com a role dona; **não** mudar dono nesta migration |
| Privilégio concedido por **outra role** (ex.: `supabase_admin`) | **aborta e desfaz tudo**, citando objeto e concedente | `REVOKE ALL ON <objeto> FROM <concedente> CASCADE` e repetir |
| Sobrecarga adicional de uma das 7 | coberta (por nome) | conferir no "depois" |
| Função/view ausente | ignorada | — |
| View já `security_invoker` ou sem grants | `REVOKE` inócuo | — |
| `unidade_config` com policies | preservadas | revisar à parte se são adequadas |
| Acesso da `service_role` só via PUBLIC | devolvido a ela (não a outra role) | — |
| Privilégio **herdado** por anon/authenticated de outra role com acesso ao alvo | a pós-condição EFETIVA **aborta e desfaz tudo** (testado) | remover a herança/concessão e repetir (`6b8`, seção 5 e 2) |

## 5. Critérios GO / NO-GO (objetivos)
**Para SOLICITAR a autorização: GO** (condições abaixo já satisfeitas por testes e pelos fatos de produção confirmados: dono = postgres; concedente = postgres; RPCs INVOKER; backend via service_role; `unidade_config` já protegida; migration atômica, com pré e pós-condição e `lock_timeout`).

**Para APLICAR (depois da autorização escrita), TODOS verdadeiros — verificação indispensável e mínima:**
1. Rodar **uma vez** `6b8-consulta-minima-115.sql` e conferir as 6 regras de decisão da seção 5b. Qualquer "NO-GO" ali ⇒ tratar a causa antes.
2. **Declaração do responsável** de que **não existe** integração externa (BI, planilha, automação, app) lendo `/rest/v1/vw_*` ou chamando `/rpc/<as 7>` com a chave anon ou JWT de usuário — o repositório só mostra o backend como consumidor; o que está **fora** do repositório só o responsável sabe (verificação rápida opcional: logs de API do Supabase dos últimos dias filtrando `vw_` e `rpc`).
3. Backup/ponto de restauração e janela combinada; responsável de plantão.
4. Executar com a role **postgres** do SQL Editor (a pré-condição aborta, sem alterar nada, se não for).
5. Autorização **escrita**.
**NO-GO** se qualquer item falhar, ou se a migration abortar por pré/pós-condição **sem** remediação clara.

### 5b. Regras de decisão para a saída da `6b8` (sem interpretação subjetiva)
| Seção | Resultado esperado ⇒ segue | Resultado diferente ⇒ ação |
|---|---|---|
| `1.sessao` | `a = postgres` (ou membro de postgres: `membro_de_postgres=true`) | outra role ⇒ **NO-GO** até rodar como postgres |
| `2.acl_completo` | grantees apenas `postgres` (dono), `service_role`, `anon`, `authenticated` e/ou `-` (PUBLIC), **concedidos por postgres** | grantee extra (ex.: `dashboard_user`, `supabase_*`, role custom) ⇒ avaliar se essa role precisa do objeto; **se anon/authenticated a herdam**, a pós-condição abortaria — resolver a herança |
| `3.assinaturas` | exatamente **7 linhas** | mais linhas = sobrecargas: cobertas por nome; conferir que nenhuma é usada por cliente externo |
| `4.dependencias` | só `RPC→RPC` da mesma família (congelar→reabrir; promover/transferir→remapear) e **nenhuma** view dependente/policy | outro chamador/dependente ⇒ confirmar que roda como `service_role`/postgres (não anon/authenticated) |
| `5.membros` | anon/authenticated sem membros-de-grupo além dos padrão do Supabase (`authenticator` é membro delas) | anon/authenticated membros de uma role que tem acesso aos alvos ⇒ a migration aborta; remover a herança/concessão antes |
| `6.pgrst_schemas` | contém `public` ⇒ **exposição potencial confirmada** (prioridade máxima) | não contém `public` ⇒ exposição pela API menor; a correção continua válida (RPC via /rpc só vale para schemas expostos) |

## 6. Exposição pela API — o que está provado e o que não foi feito
| Nível | Estado |
|---|---|
| **Privilégio SQL comprovado** (produção, pela auditoria) | `anon` e `authenticated` têm SELECT nas 4 views, que ignoram o RLS; `anon`/`authenticated`/PUBLIC executam as 7 RPCs |
| **Exposição potencial pela API** | depende de `public` constar em `pgrst.db_schemas` (**seção 6 — não recebida**); se constar (padrão do Supabase), as 4 views e as 7 funções ficam alcançáveis em `/rest/v1/vw_*` e `/rest/v1/rpc/*` com a chave **anon pública** |
| **Exploração efetiva** | **NÃO realizada**: nenhuma chamada à API de produção, nenhuma leitura de dado de cliente |
Sem exploração, **não há** afirmação de vazamento real; só de exposição possível. A investigação de **uso passado** (logs de API) é recomendada e fica fora da migration.

## 7. Plano de publicação (futuro; não executar sem autorização)
0. **Pré-requisitos:** itens 1–5 do GO. Arquivar a saída da auditoria 6b6 como **"antes"**.
1. **Backup** do projeto (ponto de restauração) e janela de baixa carga.
2. **Aplicar** `115_fecha_acesso_direto_residual.sql` no SQL Editor (role dona), **uma execução**, `lock_timeout` de 5 s: ou aplica por inteiro ou nada. Em produção ele **não** toma lock em `unidade_config` (RLS já ligado).
3. **Verificar (somente leitura):** rodar a consulta única 6b6 de novo ("depois"): `2c` das linhas 115 coerentes, `7`/`7b` sem privilégio de anon/authenticated/PUBLIC, `8` `rls_ligado=true` e `policies=0`, `10` só `service_role=true` e `public=false`.
4. **Smoke do app** (usuário administrador): `/health`; login; Dashboard e CMV carregam; Configurações → "Metas e Limites de CMV" abre **e salva**; Bonificação: lançar e **reabrir** uma competência de teste; painel SuperAdmin: abrir empresa/unidade; Checklist com conta normal.
5. **Negativos externos** (pelo responsável, com a chave `anon` **pública**, **sem retornar linhas** — `limit=0`): `GET /rest/v1/vw_faturamento_diario?limit=0` e `GET /rest/v1/unidade_config?limit=0` ⇒ **401/403/404** (nunca 200); `POST /rest/v1/rpc/bonificacao_reabrir_competencia` com `{}` ⇒ **401/403/404**.
6. Registrar "antes/depois" e a decisão.

## 8. Contingência **sem reabrir exposições**
O `115_rollback.sql` **reabre** e é o **último recurso** (só com aprovação escrita e mitigação compensatória). Corrija para frente, no menor escopo:
| Sintoma | Causa provável | Correção cirúrgica |
|---|---|---|
| `lock_timeout` | outra transação segurando um alvo | repetir fora do pico (nada foi aplicado) |
| Aborto por **pré-condição** | role sem posse | usar a role dona; não mudar dono |
| Aborto por **pós-condição** | concedente ≠ dono | `REVOKE … FROM <concedente> CASCADE` e repetir |
| App com `permission denied` em view/função | backend não está com `service_role`, ou objeto fora da lista | confirmar a chave do backend (sem expor); `GRANT SELECT/EXECUTE ON <objeto> TO service_role` **só nele** |
| Consumidor direto legítimo descoberto | cliente não mapeado | **não** reabrir: expor o dado pelo backend ou criar view `security_invoker` + policy específica |
| Rollback total inevitável | — | aprovação escrita; reabre **só** SELECT nas views e EXECUTE (PUBLIC) nas RPCs; **mantém** o RLS de `unidade_config`; reauditar |

## 9. O que ainda depende do responsável
1. **Rodar `6b8-consulta-minima-115.sql`** (uma execução, somente leitura) e devolver o texto — ou confirmar que o resultado já fornecido contém as seções 2/3/4/5/6 do 6b6 e eu confiro por ele.
2. **Declarar** que não há consumidores externos de `vw_*`/RPCs (ou checar os logs de API).
3. Backup, janela e **autorização escrita** — só então a aplicação.
