# Auditoria de segurança do Supabase em produção — pacote 112–115 (Checkpoint 6B.5)

> **ATUALIZAÇÃO 6B.7 — resultado da auditoria de PRODUÇÃO (informado pelo responsável):** PostgreSQL 17.6 · as 4 views `vw_*` têm SELECT para anon/authenticated e rodam como o dono (**confirmado**) ·
> as 7 RPCs são executáveis por anon/authenticated/PUBLIC (**confirmado**) · **`unidade_config` JÁ tem RLS ligado e nenhuma policy ⇒ o risco B (leitura/escrita livre) está DESCARTADO em produção** (o repositório
> não liga esse RLS: é divergência de schema; hipótese a verificar com `database/auditoria/6b7-consulta-complementar.sql`: gatilho de evento do Supabase que liga RLS em tabelas novas, ou ação manual) ·
> `display_operator` e a 114 **ainda não** estão no banco. A migration 115 foi **reescrita (v2)** para escopo mínimo e somente-remoção — ver `docs/plano-migration-115-correcao-de-seguranca.md`.
> Onde este documento fala em "115 liga o RLS de `unidade_config`", leia: **só se estiver desligado**; em produção não toca nela.

> **Nenhuma alteração em produção foi feita ou autorizada.** Nenhuma migration foi aplicada. Nada foi commitado.

## 1. Etapa 1 — estado verificado da produção: **NÃO VERIFICADO (sem acesso autorizado)**

Esta sessão **não tem acesso autorizado ao Supabase de produção**: o conector do Supabase está **sem autenticação** (apenas a ação de login
disponível), não há conta de teste e o `backend/.env` da pasta principal é de produção e **não foi usado**. Eu também **não** chamei a API REST da
produção com a chave pública (uma leitura de view como `anon` devolveria dados de cliente — fora do permitido). Conforme a regra do checkpoint,
**parei esta etapa** e preparei a consulta supervisionada:

* **`database/auditoria/6b5-catalogo-somente-leitura.sql`** — 16 seções, **somente catálogo** (nomes, flags, privilégios, definição de views/funções),
  dentro de `BEGIN TRANSACTION READ ONLY … ROLLBACK`. Não lê tabela de negócio, `auth.users`, `storage.objects`, chave, token nem connection string; a única
  configuração lida são chaves `pgrst.*` da role `authenticator`. Cobre: versão do Postgres; migrations aplicadas (tabela de controle **e** "impressão digital"
  por objeto, já que o projeto aplica SQL à mão); atributos e herança das roles; privilégios padrão; exposição de schemas pela API; as 4 views (dono, opções,
  ACL **com quem concedeu**, definição); `unidade_config`; tabelas sem RLS; as 7 RPCs (todas as sobrecargas, DEFINER/INVOKER, `search_path`, PUBLIC);
  quem referencia o quê; funções expostas; objetos equivalentes em outros schemas; sequences; publicação Realtime; policies por dependência; corpo atual de `auth_unidade_ids`.
* **Foi testado** (`backend/test/auditoria-catalogo-sql.test.js`, 9 testes): estaticamente (só catálogo, sem escrita) e num Postgres descartável com o schema real,
  **antes** (a saída MOSTRA o risco) e **depois** da 114/115 (a saída mostra tudo fechado).
* **Como rodar:** o responsável cola o arquivo no SQL Editor com a role de administração normal e devolve **apenas o texto das seções** (nada além). Ver "Como ler o resultado".

### Como ler o resultado (confirma ou descarta cada risco)
| Seção | Risco confirmado se… | Risco descartado se… |
|---|---|---|
| 7 / 7b (views) | `opcoes = (nenhuma: roda como o DONO)` **e** `anon_select`/`auth_select = true`, ou 7b lista `anon`/`authenticated`/`0` com SELECT | `security_invoker=true` **ou** nenhum privilégio para anon/authenticated/PUBLIC |
| 8 (`unidade_config`) | `rls_ligado = false` | `rls_ligado = true` **e** `policies = 0` (nega tudo; o privilégio nominal permanece, o RLS é que nega) |
| 10 (RPCs) | `anon_exec`/`auth_exec`/`public_exec = true` | todos `false` e `service_exec = true` |
| 6 | `pgrst.db_schemas` inclui `public` (esperado) — a API **enxerga** o schema | (não é "risco" por si; é a exposição) |
| 9 | qualquer tabela sem RLS | vazio |
| 16 / 2c | `auth_unidade_ids` **sem** `display_operator` ⇒ a 114 ainda não foi aplicada | com `display_operator` |
| 7b / coluna `quem_concedeu` | concedente ≠ dono (ex.: `supabase_admin`) ⇒ a `REVOKE` da 115 **não** remove esse privilégio (limite testado) | só o dono |
| 2c | linhas "presente = f" mostram o que **falta** aplicar | — |

## 2. Etapa 2 — validação da migration 115 (ambiente descartável, schema REAL do repositório)

Testes: `perfil-exibicao-rls-schema-real-pg.test.js` (18) e `perfil-exibicao-rls-115-revisao-pg.test.js` (8). Resultado (todos passam):

| Verificação pedida | Resultado |
|---|---|
| Acesso anônimo às 4 views | **negado** (`permission denied`) a `anon`; antes lia as 2 unidades |
| Acesso direto do `display_operator` (TV) | tabelas: 27 lidas/26 alteradas → **0** (114); views: **negado**; `unidade_config`: **0 linhas**, sem escrita; 7 RPCs: **negado** |
| Caminhos alternativos às views | nenhuma view/policy/trigger/função do banco depende das views; varredura final: **nenhuma** view legível por anon/authenticated |
| Leitura **e escrita** de `unidade_config` | `authenticated`/`anon`/TV: SELECT 0 linhas e UPDATE sem efeito; `service_role` lê e grava |
| Revogação das 7 RPCs | `anon`, `authenticated` (TV e gestor): `permission denied` nas 7; PUBLIC sem privilégio; ACL por `aclexplode` sem grantee 0/anon/authenticated |
| Backend (service_role) | lê as 4 views, lê/grava `unidade_config`, executa as 7 RPCs sem `permission denied` (erro de negócio, se houver, é outro) |
| Dependências legítimas | nenhuma função/trigger/policy do banco usa as views/`unidade_config`; só `congelar→reabrir` e `promover/transferir→remapear` se chamam entre si — sob `service_role` funcionam |
| Regressão nos perfis | matriz **idêntica** antes×depois da 115 para os 9 papéis (TV, viewer, herda, gestor, financeiro, outra empresa, estranho, anon, service_role) |
| PUBLIC / owners / sobrecargas | donos = `postgres`; **sobrecarga nova** de uma das 7 nasce **exposta** (default privileges) e a 115 reaplicada a fecha (revogação por **nome**) |
| Grants de outro concedente | **limite confirmado:** um privilégio concedido por outra role com GRANT OPTION **sobrevive** à `REVOKE` do dono. Mitigação: seção 7b lista o concedente; remediar com `REVOKE … FROM <concedente> CASCADE` (testado) |

**Consumidores legítimos conferidos por busca no repositório:** as 4 views, `unidade_config` e as 7 RPCs só são usadas pelo **backend** (cliente único `service_role`,
`backend/src/config/supabase.js`); o frontend só usa o Supabase para **Auth e Realtime** (menções são comentários); scripts de desenvolvimento
(`auditar-performance.mjs`, `diagnosticar-chaves.js`) não consultam esses objetos. **Nenhum consumidor direto por `anon`/`authenticated` foi encontrado.**

## 3. Etapa 3 — revisão do pacote 112 → 113 → 114 → 115

| Item | 112 | 113 | 114 | 115 |
|---|---|---|---|---|
| Faz | `ADD VALUE` ao enum | constraint + índice único parcial | corpo de `auth_unidade_ids()` | revoga views/RPCs, RLS em `unidade_config` |
| Depende de | base | **112 commitada** (índice/constraint usam o valor) | **112 commitada** (falha limpa sem ela — testado) | nada (independente) |
| Lock / `lock_timeout` | instantâneo (sem tx própria) | 5 s + advisory lock | 5 s | 5 s; único lock forte: `ENABLE RLS` em `unidade_config` (tabela pequena) |
| Idempotente | sim (`IF NOT EXISTS`) | sim | sim (`CREATE OR REPLACE`) | sim (revoke/grant/enable) |
| Falha no meio | nada muda | tx desfaz | tx desfaz | **atômica** (testado: lock segurado ⇒ falha em ~5 s sem aplicar **nem** o REVOKE das views que vem antes) |
| Dados existentes | intocados | intocados (testado com todos os papéis) | intocados | intocados |
| Rollback | confere e aborta se o papel está em uso; **valor do enum é permanente** | remove constraint e índice | restaura o corpo (**reabre** o acesso direto da TV) | devolve privilégios padrão e desliga RLS (**reabre** o acesso direto) |

* **Aplicadas em sequência no schema real: nenhuma falha.** Fora de ordem (114 antes da 112): falha com erro claro e nada fica pela metade.
* **Compatibilidade com o código publicado hoje:** o backend publicado usa só `service_role`, que ignora RLS e mantém EXECUTE/SELECT ⇒ **nenhuma mudança de comportamento**.
  O frontend atual não usa nada que a 115 fecha. Código antigo + migrations aplicadas = seguro; migrations antes do código novo = seguro.
* **Estados intermediários seguros:** 112 só (conta de exibição pode ser criada pelo painel novo, não pelo antigo); 112+113; +114; +115 — cada degrau é consistente.
* **Rollbacks e riscos:** reverter a 114 ou a 115 **reabre exposição**; só faça isso junto com a retirada do papel/diagnóstico do problema. 112 não se desfaz (enum permanente).
* **Testes mínimos após aplicar (SQL, somente leitura):** rodar `6b5-catalogo-somente-leitura.sql` ⇒ seção 2c toda `t`, 7/7b sem privilégio, 8 `rls_ligado = t / policies = 0`, 10 só `service_exec`,
  16 com `display_operator`. **Smoke do app:** `/health`; login; Dashboard e CMV carregam (views); Configurações → "Metas e Limites de CMV" abre **e salva** (`unidade_config`); Bonificação: lançar e **reabrir**
  competência (RPCs); painel SuperAdmin: abrir empresa/unidade; Checklist (conta normal) abre; **conta da TV** entra só no Checklist. **Negativos:** com a chave `anon` pública, `GET /rest/v1/vw_faturamento_diario?limit=0` e
  `GET /rest/v1/unidade_config?limit=0` devem responder **401/403/404** (não 200) — executar pelo responsável.
* **Contingência:** falha da 115 por `lock_timeout` ⇒ repetir fora do pico; erro de permissão no app depois da 115 ⇒ conferir que o backend usa a **service_role** (chave certa no Render) e, só se necessário, `115_rollback.sql`;
  qualquer concedente diferente do dono ⇒ remediar conforme 7b.
* **Publicação NÃO executada.** Ordem e checklist em `docs/checklist-exibicao-perfil-e-sessao.md` (4b/3h) e `docs/seguranca-acesso-direto-supabase.md`.

## 4. Etapa 4 — verificação do JWT real: **PENDENTE (sem conta de teste autorizada)**

Procedimento pronto, executado **pelo responsável**, sem expor o token a ninguém: `docs/verificacao-jwt-supabase-conta-teste.md`. O script
(`backend/scripts/verificar-jwt-amr.mjs`) agora tem **modo de comparação**: na 2ª execução, `--carimbo-esperado=<UTC da 1ª> --iat-anterior=<UTC do iat da 1ª>` imprime
**ESTÁVEL** (carimbo igual e houve refresh) ou **INSTÁVEL** e sai com código 0/1. Ele **não imprime nem grava** token, e-mail, `sub` nem valores de claims. **Nada foi substituído por documentação ou simulação:**
o teto de 20 h **continua não aprovado** até esse resultado. Etapas independentes seguiram (itens 1–3 e 5).

## 5. Etapa 5 — classificação dos achados (prioridade = exposição de dados, independente do cronograma do Checklist)

Legenda: **[TV]** específico do Operador de Exibição · **[PRE]** preexistente, afeta outros perfis · **[ANON]** possível exposição anônima · **[AMB]** depende de verificação no ambiente real · **[OP]** risco operacional da aplicação.

| # | Achado | [TV] | [PRE] | [ANON] | [AMB] | [OP] | Prioridade |
|---|---|---|---|---|---|---|---|
| 1 | 4 views `vw_*` rodam como o dono: vazam faturamento/estoque/margens de **todas as unidades** | ✔ (TV lê) | ✔ | **✔** | ✔ (confirmar grants/propriedade) | baixo (115) | **P0 — independe do Checklist** |
| 2 | `unidade_config` sem RLS: **leitura e escrita** de metas/limites de qualquer unidade | ✔ | ✔ | **✔** | ✔ | baixo | **P0 — independe do Checklist** |
| 3 | RLS cego ao papel: a TV (e qualquer vínculo) lê **e escreve** 26 tabelas da própria unidade pela REST | **✔** | ✔ (qualquer papel de unidade escreve) | não | ✔ | baixo (114) | P1 p/ TV (114); **P1 geral**: auditoria de policies por papel |
| 4 | 7 RPCs de negócio expostas em `/rpc` (hoje só o RLS as segura) | ✔ | ✔ | exposto a `anon` (barrado pelo RLS) | ✔ | baixo | P2 (defesa em profundidade) |
| 5 | Grants de outro concedente sobrevivem à `REVOKE` | — | ✔ | possível | **✔ (só a seção 7b responde)** | médio (falha silenciosa) | verificar na produção |
| 6 | Sobrecargas futuras nascem expostas (default privileges em `public`) | — | ✔ | ✔ | ✔ | — | recomendação: revogar default privileges de funções para anon/authenticated (decisão futura) |
| 7 | `modulos`/`planos` legíveis por qualquer autenticado | ✔ | ✔ | não | — | — | baixa sensibilidade |
| 8 | Storage: sem policies no repositório (padrão do Supabase = negar) | ✔ | ✔ | ? | **✔** | — | conferir seção 12 / policies de `storage` |
| 9 | Carimbo `amr[].timestamp` não validado com token real | ✔ | — | — | **✔** | alto p/ o teto de 20 h | **bloqueio de homologação** |
| 10 | Ordem/atomicidade das migrations; `lock_timeout` | — | — | — | — | **✔** mitigado (5 s; atômica; idempotente) | — |

> Recomendação do auditor: **tratar 1 e 2 como correção de segurança própria**, com prioridade acima do cronograma do Checklist (a 115 pode ser publicada **sem** a 112–114 — é independente).
> Decisão do responsável.
