# 14 — Roteiro T3 (Supabase DESCARTÁVEL) — Dashboard Financeiro 120 → 121 → 122

Data: 2026-10-18 · Base: `integracao/gestao-financeira` @ `1d7bcfc` (+ este checkpoint) · **Nenhum projeto Supabase foi criado ou acessado.** Este documento consolida o roteiro executável; consolida e substitui as seções A–G do `05-checklist-homologacao-t3-mfa.md` (que permanece como histórico).
Escopo congelado: M1 (conciliação autoritativa no banco), O-1 (assinaturas obsoletas), F-1 (integridade do pré-fechamento), F-2 (invalidação da prévia após 409). **A 122 continua sem promoção.** Nada aqui habilita concessões, o módulo financeiro nem acessos reais.

## 0. Regras de segurança do T3
1. **Projeto novo, criado só para isto**, sem dados reais, sem integrações, sem usuários reais. Nunca reutilizar produção, homologação com dados, nem o banco local do `backend/.env` (aponta para PRODUÇÃO).
2. Chaves (`service_role`, senha do banco) ficam **só em variáveis de ambiente do terminal**, nunca em arquivo, commit, chat ou log. Os scripts leem apenas `T3_*`/`M1_*` e exigem `T3_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL`.
3. Ao final, **destruir o projeto**. As linhas semeadas não são apagáveis pelo `service_role` por desenho.
4. Cada passo grava a saída em `evidencias-t3/AAAA-MM-DD/<passo>.txt` (fora do repositório), com o commit testado (`git rev-parse HEAD`).
5. Qualquer ✗ interrompe o T3: registrar o achado na Ligação Direta e devolver para correção; **não** alterar expectativa de teste para aprovar.

**Trava dos scripts SQL que escrevem** (`adversarial122*`, `desempenho_m1`, `reproduz_r1`, `seed_descartavel`): exigem `-v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL` e **recusam** qualquer banco que tenha organização com id fora do padrão de teste (`00000000-0000-0000-0000-0000000000xx`); a trava está INLINE em cada arquivo (erro dentro de `\ir` não encerra o script que incluiu — provado). Os scripts shell exigem `T3_CONFIRMO`/`T3_PSQL_CONN` (T3) ou o cluster local com `MARCADOR_DESCARTAVEL`; `parity_m1.mjs` exige `M1_CONFIRMO`; `f3_f4_e2e.mjs` exige `T3_CONFIRMO` e confere URL × ref (ou `T3_MODO=local` + marcador). Nenhum script lê `backend/.env`.

## 1. Preparação (decisão/ação do responsável pelo projeto)
| # | Ação | Observação |
|---|---|---|
| 1.1 | Criar projeto Supabase novo e descartável; anotar `ref`, URL, senha do banco | região livre; plano gratuito basta |
| 1.2 | Reproduzir o esquema BASE do produto (migrations 001–119, **e** 123–125 já existentes na `main`) | ordem: as de `origin/main` na ordem numérica. **120–122 entram depois e ficam "fora de ordem" (123–125 já aplicadas)** — o T3 prova que isso é seguro (item 3.A.5) |
| 1.3 | Conferir o esquema base: `organizacoes`, `unidades`, `modulos` (com `categoria` ∈ operacao/integracao), `organizacao_modulos`, `unidade_modulos`, `perfis_operacionais` | a 120 depende deles |
| 1.4 | Conexão de admin (`postgres`) por URI: `export T3_PSQL_CONN="postgresql://postgres:<senha-url-encoded>@<host>:5432/postgres"; export T3_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL` | senha com caracteres especiais precisa de URL-encode |
| 1.5 | Semente: `psql "$T3_PSQL_CONN" -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL -f backend/testes-seguros/t3/seed_descartavel.sql` | ajustar colunas NOT NULL do esquema real; manter os ids |
| 1.6 | Ferramentas na máquina de teste: `psql` ≥ 14, Node ≥ 20, `backend/node_modules` instalado | |

## 2. Matriz de cobertura (o que o T3 precisa provar)
| Tema | Passo | Script / comando | Critério |
|---|---|---|---|
| Aplicação 120, 121, 122 (+ reaplicação) | 3.A | `psql "$T3_PSQL_CONN" -v ON_ERROR_STOP=1 -1 -f …` | sem erro; reaplicar 120/121/122 sem erro e sem alterar contagens |
| RLS, privilégios efetivos, BYPASSRLS, donos, DEFINER, `search_path`, EXECUTE, sobrecargas, gatilhos | 3.B | `verificacoes_catalogo.sql` (23 verificações) | **todas `ok = t`** |
| Acesso pela API pública (PostgREST/GraphQL/Realtime) | 3.C | `curl` com `anon` e com JWT de `authenticated` | nenhum dado e nenhuma RPC financeira acessível |
| Paridade SQL × carregamento real da aplicação (**F-3**) | 3.D | `f3_f4_e2e.mjs` | todos PASS |
| Limites de consulta de referências/resoluções (**F-4**) | 3.D | `f3_f4_e2e.mjs` (bloco F-4) | iguais **ou** 409 `FIN_CONCILIACAO_DIVERGENTE` com mês aberto; **nunca** fechar |
| Paridade SQL × motor JS em massa | 3.E | `parity_m1.mjs` | 100 % iguais (≥ 500 cenários) |
| Concorrência real (F-1) | 3.F | `f1_concorrencia.sh` | 31/31 |
| Mês fechado, exceções de fechamento, MFA (formato/janela), O-1, R-1 reproduzido e bloqueado | 3.G | `adversarial122.sql`, `adversarial122_complemento.sql`, `adversarial122_concorrencia.sh` | 70 + 5 PASS, 0 FALHA |
| TOTP real e `amr.timestamp` | 3.H | `amr_probe.mjs` | 4 etapas conforme o roteiro do cabeçalho |
| Rollback respeitando condições de dados | 3.I | ver 3.I | recusa com dados; íntegro sem dados |
| Desempenho | 3.J | `desempenho_m1.sql` (N = 60 000 e 300 000) | fechamento < 2 s com 300 mil |
| Auditoria | 3.K | consultas em 3.K | trilha completa e imutável |
| Isolamento entre organizações e unidades | 3.L | `parity_m1.mjs` (2 organizações), adversarial S8, F-1 §6 | zero vazamento |
| UI (F-2) no ambiente real | 3.M | `qa-f2.mjs` contra o backend de teste | 30/30 por variação |

## 3. Passos
### 3.A Aplicação e reaplicação
```bash
export T3_PSQL_CONN=... T3_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL
for f in database/migrations/120_gestao_financeira_fundacao.sql database/migrations/121_gestao_financeira_dominio.sql docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql; do
  psql "$T3_PSQL_CONN" -v ON_ERROR_STOP=1 -f "$f" || break; done      # 1ª aplicação
# reaplicar as três (idempotência); contagens de linhas antes/depois idênticas
```
1. As três aplicam sem erro; pós-condições da 120/121/122 **não abortam** (a 122 aborta se `service_role` executar `fin_reabrir_periodo`, conceder/revogar exceção ou os validadores, ou se faltarem os gatilhos).
2. 2ª aplicação das três: sem erro.
3. A 122 é aplicada como está (arquivo provisório). **Promoção a migration (`begin/commit`, `lock_timeout`, pós-condição) só depois do T3 aprovado e da revisão independente.**
4. Conferir que a 120 registrou o módulo `gestao_financeira` (categoria `financeiro`, ordem 17) **sem habilitá-lo em nenhuma empresa/unidade** e que o módulo `checklist_operacional` (123, ordem 18) segue íntegro.
5. **Ordem:** com 123–125 já aplicadas, 120–122 entram "fora de ordem". Prova: nenhuma das 123–125 toca `fin_*`/`gestao_financeira_*`; 123 insere módulo com categoria `operacao` (válida antes e depois da 120). Registrar `select * from modulos order by ordem;`.

### 3.B Catálogo (RLS, privilégios, BYPASSRLS, donos, DEFINER, `search_path`, EXECUTE)
```bash
psql "$T3_PSQL_CONN" -v ON_ERROR_STOP=1 -P pager=off -f backend/testes-seguros/t3/verificacoes_catalogo.sql | tee evidencias/3B.txt   # exige 23 × ok = t
```
Complementos manuais no projeto real (o Supabase tem atributos reais que o simulado não tem):
- `select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname in ('postgres','service_role','authenticated','anon','authenticator');` — registrar; **`service_role` deve ter BYPASSRLS** (a 120 e as funções DEFINER dependem disso) e `anon/authenticated` não.
- Dono real das tabelas/funções financeiras (verificação 3 do script) e se o dono tem BYPASSRLS: as `fin_*` **não** usam FORCE RLS por causa dos gatilhos DEFINER; as da 120 usam FORCE e dependem do BYPASSRLS do `service_role`. Se o dono real for `supabase_admin`/`postgres` com atributos diferentes dos simulados, **reexecutar 3.G e 3.F** — é o principal motivo do T3.
- `\df+ fin_*` e `\dp fin_*`: guardar a saída.
- `select * from pg_default_acl;` — os default privileges do Supabase (ALL para anon/authenticated/service_role) são o que as migrations revogam explicitamente; conferir que nada novo escapou.

### 3.C API pública (só o projeto real prova)
Com a URL e a **anon key** do projeto descartável (chave pública, não a service_role):
```bash
curl -s "$URL/rest/v1/fin_lancamentos?select=id&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"          # esperado: erro de permissão / [] — nunca dados
curl -s -X POST "$URL/rest/v1/rpc/fin_fechar_periodo" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" -d '{}'   # esperado: 401/403/404
for rpc in fin_conciliacao_pendencias_ids fin_conceder_excecao_fechamento fin_revogar_excecao_fechamento fin_reabrir_periodo fin_mfa_evidencia_valida fin_periodo_travar; do
  curl -s -o /dev/null -w "$rpc %{http_code}\n" -X POST "$URL/rest/v1/rpc/$rpc" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" -d '{}'; done
```
Repetir com um JWT de usuário `authenticated` (de teste, sem concessão). **Esperado em todos: nenhum dado e nenhuma RPC financeira executável.** Conferir também o endpoint GraphQL (`/graphql/v1`, `pg_graphql`) e o schema cache do PostgREST (`/rest/v1/` lista de tabelas expostas): nenhuma tabela `fin_*`/`gestao_financeira_*` deve aparecer como legível; se `pg_graphql` expõe nomes, registrar (nomes expostos ≠ dados). Realtime: confirmar que nenhuma `fin_*` está na publicação `supabase_realtime` (`select * from pg_publication_tables where pubname='supabase_realtime';`).

### 3.D F-3 e F-4 — código real da aplicação × banco
```bash
export T3_SUPABASE_URL=https://<ref>.supabase.co T3_SERVICE_ROLE_KEY=... T3_PROJECT_REF=<ref> T3_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL
export T3_ORG_ID=00000000-0000-0000-0000-0000000000a1 T3_UNIDADE_ID=00000000-0000-0000-0000-0000000000a2
node backend/testes-seguros/t3/f3_f4_e2e.mjs | tee evidencias/3D.txt
```
- **F-3:** 8 cenários (vazio, ponte conciliada/aberta, caixa do dia aberto, sangria aberta/com exceção ativa, resolução parcial, previsto/cancelado) com o **carregamento real** (`calcularMes` + PostgREST) comparado à RPC `fin_conciliacao_pendencias_ids`. Todos devem ser iguais.
- **F-4:** (a) 5 001 referências de venda + 1 taxa; (b) 5 001 resoluções vigentes. O repositório usa `.limit(5000)` (`repositorio.conciliacao.js`: `listarReferencias`, `listarResolucoes`). Esperado: ou app = banco (limite corrigido) **ou** divergência ⇒ `fechar` responde **409 `FIN_CONCILIACAO_DIVERGENTE`** e o mês fica **aberto**. **Fechar com lista incompleta = reprovação.** Resultado esperado hoje: divergência com 409 (fail-closed). Se o produto precisar fechar meses com > 5 000 referências, abrir item próprio (paginar o repositório) — fora do escopo congelado.
- O script é **novo e nunca foi executado** (não há projeto): se falhar por esquema (colunas NOT NULL, nomes), corrigir o *script*, não a expectativa.

### 3.E Paridade em massa SQL × motor JS
```bash
export M1_CONN="$T3_PSQL_CONN" M1_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL
for s in 7 2026 31337; do node backend/testes-seguros/pg/parity_m1.mjs --aleatorios=250 --semente=$s; done     # 100 % iguais
```
Nota: o harness usa `set session_replication_role = replica` para semear rápido; se o papel do projeto não puder, remover essas linhas (mais lento). Duas organizações no mesmo mês provam o isolamento entre organizações (3.L).

### 3.F Concorrência real (F-1)
```bash
export T3_ORG_ID=00000000-0000-0000-0000-0000000000a1
bash backend/testes-seguros/pg/f1_concorrencia.sh | tee evidencias/3F.txt        # 31 × PASS, "TODAS AS PROVAS OK"
```
Usa `set role service_role` a partir de `postgres`; o papel `dono_sim` (dono simulado das funções DEFINER, usado para conceder exceção) **não existe** no Supabase: no T3 exporte `T3_DONO_ROLE=<dono real das funções>` (ex.: o papel que aparece em `verificacoes_catalogo.sql`, verificação 3/18) e o script usa esse papel na concessão do cenário 5. Mutação opcional (já feita localmente): remover os gatilhos ⇒ os cenários 4 e 7 devem falhar.

### 3.G Mês fechado, exceções, MFA, O-1, R-1
```bash
psql "$T3_PSQL_CONN" -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL -f backend/testes-seguros/pg/adversarial122.sql            | tee evidencias/3G-1.txt   # 70 PASS, 0 FALHA
psql "$T3_PSQL_CONN" -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL -f backend/testes-seguros/pg/adversarial122_complemento.sql | tee evidencias/3G-2.txt   # 5 PASS
bash backend/testes-seguros/pg/adversarial122_concorrencia.sh                    | tee evidencias/3G-3.txt   # A fecha; B ja_fechado; C fin_periodo_fechado; exceção consumida 1×
```
Pontos que só o ambiente real confirma: (a) `set role anon/authenticated/service_role/dono` — passar o dono real: `psql … -v DONO=<dono> -f adversarial122.sql` (e `-f adversarial122_complemento.sql`), `T3_DONO_ROLE=<dono>` para `adversarial122_concorrencia.sh`; (b) `S0` (EXECUTE) com os papéis reais; (c) **R-1 reproduzido e bloqueado** (S11: lista de conciliação omitida/fabricada/extra/repetida/nula ⇒ `fin_conciliacao_divergente`; mês aberto); (d) O-1: ver verificação 16 do catálogo e rodar a 122 por cima de uma 122 antiga, se houver; (e) reabertura direta e fechamento direto (S9) barrados também para o dono.

### 3.H TOTP real e `amr.timestamp` (janela de 10 min)
Com um usuário **de teste** com TOTP cadastrado (MFA do Supabase Auth), `T3_JWT` em variável de ambiente (nunca em arquivo/log):
| Etapa | Ação | Rótulo | Esperado |
|---|---|---|---|
| 1 | login por senha | `senha` | `aal1`, `amr` só com password |
| 2 | verificar TOTP agora | `totp` | `aal2`; `amr` totp com `timestamp` ≈ agora (**em segundos**); `avaliarMfaRecente` = PERMITE |
| 3 | esperar ~11 min e **refresh** do token | `refresh` | `aal2` mantido; `timestamp` do TOTP **inalterado** ⇒ idade > 10 min ⇒ NEGA |
| 4 | novo login + novo TOTP | `re-totp` | timestamp novo ⇒ PERMITE |
`T3_JWT="$JWT" node backend/testes-seguros/t3/amr_probe.mjs <rótulo>`. Se o timestamp for o da **criação da sessão** (e não do evento TOTP), ou o refresh o renovar, ou a unidade não for segundos: **o fluxo administrativo da exceção permanece bloqueado** e o desenho do carimbo precisa mudar (ex.: exigir reautenticação com TOTP imediatamente antes da concessão e registrar o `session_id` hash). Registrar também que `sessao_ref = sha256(session_id)` nunca vai ao banco/auditoria em claro e que nenhum JWT é gravado.

### 3.I Rollback respeitando condições de dados
1. **Com dados** (após 3.F/3.G): `psql "$T3_PSQL_CONN" -v ON_ERROR_STOP=1 -f docs/gestao-financeira/proposta-122/122_rollback.provisorio.sql` ⇒ **deve RECUSAR** (`rollback recusado: ha dados…`) e não remover nada (contagens iguais antes/depois).
2. **Sem dados** (banco/projeto separado só com as três migrations aplicadas): rollback 122 ⇒ lançamentos continuam gravando (a 122 restaura as funções da 121 sozinha); reaplicar 122 ⇒ ok; rollback 122 → `121_rollback.sql` → `120_rollback.sql` ⇒ `select count(*) from pg_proc where proname like 'fin\_%'` = 0 e tabelas `fin_*` = 0; reaplicar 120 → 121 → 122.
3. O rollback da 121 recusa qualquer linha em `fin_periodos` com dados reais; âncoras `aberto` vazias são descartadas pelo rollback da 122 (conferir).

### 3.J Desempenho
```bash
psql "$T3_PSQL_CONN" -v N=60000  -v ORG=$T3_ORG_ID -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL -f backend/testes-seguros/pg/desempenho_m1.sql
psql "$T3_PSQL_CONN" -v N=300000 -v ORG=$T3_ORG_ID -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL -f backend/testes-seguros/pg/desempenho_m1.sql
```
Referência local (PG 17, máquina de desenvolvimento): 60 mil ⇒ função ~75–155 ms, fechamento completo ~210–260 ms; 300 mil ⇒ função ~480 ms. Critério T3: fechamento completo **< 2 s com 300 mil**; registrar `explain (analyze, buffers)` da função e confirmar uso do índice `ix_fin_lancamentos_periodo`. Observar também o tempo de retenção da trava (o fechamento segura `FOR UPDATE` no período) com carga concorrente de lançamentos em outro mês (não deve bloquear).

### 3.K Auditoria
```sql
select entidade, acao, count(*) from fin_auditoria group by 1,2 order by 1,2;                           -- exceções (insert/update), períodos, lançamentos…
select count(*) from fin_auditoria where depois::text ~ 'eyJ';                                         -- 0: nenhum JWT na trilha
select count(*) from fin_excecoes_fechamento where mfa_evidencia::text ~ 'eyJ' or (mfa_evidencia ? 'sessao_ref' and mfa_evidencia->>'sessao_ref' !~ '^[0-9a-f]{64}$');   -- 0
-- imutabilidade (como service_role): update/delete em fin_auditoria ⇒ erro; update de conteúdo de exceção/período fechado ⇒ erro
```
Conferir: quem concedeu (`aprovada_por`), justificativa, pendências cobertas (ids do **banco**), `mfa_evidencia` (aal, em, método, hash), quem consumiu e quando; snapshot do fechamento com `pendenciasConciliacaoIds`, `excecaoFechamentoId`.

### 3.L Isolamento entre organizações e unidades
- `parity_m1.mjs` alterna duas organizações com dados nas mesmas datas (qualquer vazamento quebra a paridade; mutação local detectou vazamento de lançamentos e de referências).
- `adversarial122.sql` S8: exceção da unidade A não vale para A2; org B + unidade A ⇒ `fin_escopo_invalido`; revogar com tenant trocado ⇒ `false`.
- `f1_concorrencia.sh` §6: operações em outra unidade/organização não bloqueiam nem alteram.
- Na API: com concessão financeira de teste **da unidade A**, tentar a unidade B (header/contexto) ⇒ 403; sem concessão ⇒ 403; impersonação ⇒ 403 (`gestao-financeira-a8-integrado.test.js` cobre isso com gate real; repetir 3 chamadas HTTP no ambiente de teste).

### 3.M Interface (F-2) e exportações no ambiente de teste
Subir o backend contra o projeto descartável **apenas** em máquina de teste (variáveis `SUPABASE_*` do projeto descartável; nunca `backend/.env`), e rodar `QA_MODULOS=… node backend/testes-seguros/qa-visual/qa-f2.mjs` adaptado ao backend real (o servidor de QA local usa dados em memória). Verificar manualmente: pré-fechamento → outra sessão altera uma conta → confirmar → aviso + confirmação desabilitada + "Atualizar pré-fechamento" → recalcular → confirmar. Desktop, celular (390 px) e tema escuro.

## 4. Critérios de saída
**T3 APROVADO** somente se: 3.A–3.L sem ✗; 3.H confirmar `amr.timestamp` do evento real (senão o fluxo de exceção continua bloqueado — o T3 pode ser aprovado **sem** o fluxo administrativo); F-3 e F-4 conforme 3.D; evidências arquivadas com o commit testado; **revisão independente** do pacote (doc 15) concluída. Só então: promover a 122 (migration com `begin/commit`, `lock_timeout`, pós-condição) em autorização separada.

## 5. O que este T3 NÃO cobre
Carga de produção; integração com dados reais; habilitação do módulo/concessões; o endpoint de plataforma da exceção (não implementado, desabilitado); reabertura (desabilitada por decisão).
