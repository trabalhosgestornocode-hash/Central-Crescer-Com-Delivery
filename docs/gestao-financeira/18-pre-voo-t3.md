# 18 — Pré-voo do T3 (Supabase DESCARTÁVEL) e plano da primeira versão

Data: 2026-10-18 · Sem novas funcionalidades. **Nenhum banco foi conectado ou alterado** (o ensaio da cadeia de migrations rodou só no PostgreSQL local descartável). Complementa o doc 14 (roteiro) com a identidade do alvo, a ordem exata e os pontos de autorização.

## 1. Ambiente inspecionado
| Item | Estado |
|---|---|
| Branches | `integracao/gestao-financeira` @ `01a63cb`+ (este doc) e `integracao/financeiro-com-main` @ `93d4908`; ambas **limpas**; `origin/main` @ `3545968` |
| Projetos Supabase conhecidos no repositório | **produção** `uqybgauuxcrqzquultfu` ("Crescer Com Delivery") e **teste compartilhado** `wiqqsxnysbzhcrzrrean` ("teste-multiempresarial", usado por iFood/Checklist). **Nenhum dos dois serve para o T3**: o T3 cria dados permanentes (o `service_role` não apaga por desenho) e termina destruindo o projeto → **projeto NOVO e exclusivo** |
| Estrutura-base exigida pelas 120–122 | `000_base_migration.sql` (consolida 001–067) → 068…119 → 123…125 (versões de `origin/main`), depois 120 → 121 → 122. **Ensaio local** da cadeia inteira (55 arquivos) com um stub mínimo de `auth`: só falharam os trechos que dependem de `storage` e `realtime` (existem em qualquer projeto Supabase); 120–122 aplicaram depois de 123–125 sem erro |
| Proteções contra produção | `preflight_t3.mjs` recusa os dois refs acima, exige URL/conexão/chaves do **mesmo** ref, recusa terminal com `SUPABASE_URL`/`DATABASE_URL` de produção; scripts SQL que escrevem exigem `-v CONFIRMO=…` e recusam banco com organização real (trava **inline**); scripts shell exigem `T3_CONFIRMO`; **nenhum** script lê `backend/.env` |

Testes do pré-voo (todos sem rede): sem variáveis ⇒ recusa; ref de produção ⇒ recusa; ref do teste compartilhado ⇒ recusa; chave de outro projeto ⇒ recusa; terminal com `SUPABASE_URL` de produção ⇒ recusa; tudo certo ⇒ "Fase A OK". Fase B (somente leitura) validada contra o PostgreSQL local (`default_transaction_read_only=on`).

## 2. O que configurar (sem colar nada no chat)
1. No painel do Supabase, criar um projeto **novo** (ex.: `t3-financeiro-<data>`), sem integrações, sem usuários reais. Ativar **MFA TOTP** no Auth.
2. Num **terminal novo** (sem as variáveis da Central), exportar somente:
   - `T3_PROJECT_REF` — o ref do projeto novo (20 letras)
   - `T3_SUPABASE_URL` — `https://<ref>.supabase.co`
   - `T3_PSQL_CONN` — `postgresql://postgres:<senha-url-encoded>@db.<ref>.supabase.co:5432/postgres` (ou o pooler com usuário `postgres.<ref>`)
   - `T3_SERVICE_ROLE_KEY` e `T3_ANON_KEY` — do próprio projeto novo
   - `T3_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL`
   - depois do passo 4: `T3_ORG_ID=00000000-0000-0000-0000-0000000000a1`, `T3_UNIDADE_ID=00000000-0000-0000-0000-0000000000a2`, `T3_DONO_ROLE=<dono real das funções>`
3. Um usuário **de teste** com TOTP cadastrado (para o passo 10) — e-mail descartável, nunca de pessoa real.
Nada disso vai para arquivo, commit, chat ou log. Ao final, **excluir o projeto**.

## 3. Sequência única de execução (pare no primeiro ✗)
| # | Passo | Comando | Precisa de autorização? |
|---|---|---|---|
| 1 | Validar a identidade (sem rede) | `node backend/testes-seguros/t3/preflight_t3.mjs` | não (não conecta) |
| 2 | Confirmar que o banco não tem dados reais (**somente leitura**) | `node backend/testes-seguros/t3/preflight_t3.mjs --conectar` | **sim — 1ª conexão** |
| 3 | Estrutura-base (52 arquivos de `origin/main`) | `T3_AUTORIZO_BASE=SIM bash backend/testes-seguros/t3/aplicar_estrutura_t3.sh base` (sem a variável só lista) | **sim** |
| 4 | Semente de teste | `psql "$T3_PSQL_CONN" -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL -f backend/testes-seguros/t3/seed_descartavel.sql` | sim (junto do 3) |
| 5 | Migrations financeiras 120 → 121 → 122 | `T3_AUTORIZO_120_122=SIM bash backend/testes-seguros/t3/aplicar_estrutura_t3.sh financeiro` | **sim — específica** |
| 6 | Catálogo de privilégios (somente leitura) | `psql "$T3_PSQL_CONN" -f backend/testes-seguros/t3/verificacoes_catalogo.sql` — 23 × `ok = t` | não (leitura) |
| 7 | Isolamento entre organizações/unidades | `M1_CONN="$T3_PSQL_CONN" M1_CONFIRMO=… node backend/testes-seguros/pg/parity_m1.mjs` (2 organizações) + adversarial S8 (passo 9) + chamadas HTTP do doc 14 §3.L | coberto pelo 5 |
| 8 | PostgREST real, paginação, F-3 e F-4 | `node backend/testes-seguros/t3/f3_f4_e2e.mjs` (agora com o **PostgREST real**: teto de linhas e carregamento da aplicação) + `curl` com a chave anon do doc 14 §3.C | coberto pelo 5 |
| 9 | Concorrência, M1 e fechamento | `bash …/pg/f1_concorrencia.sh`; `psql … -v CONFIRMO=… -v DONO=$T3_DONO_ROLE -f …/pg/adversarial122.sql` e `…_complemento.sql`; `bash …/pg/adversarial122_concorrencia.sh`; `psql … -v CONFIRMO=… -v N=300000 -f …/pg/desempenho_m1.sql` | coberto pelo 5 |
| 10 | MFA AAL2 com TOTP real e semântica do `amr.timestamp` | 4 etapas do doc 14 §3.H com `node backend/testes-seguros/t3/amr_probe.mjs` (JWT só em variável) | **sim** (usuário de teste com TOTP) |
| 11 | Regressão e evidências | rollback com/sem dados (doc 14 §3.I), auditoria (§3.K), UI do pré-fechamento (§3.M); arquivar saídas em `evidencias-t3/<data>/` com o commit testado | parte (rollback) |
**Sucesso parcial não é homologação.** O T3 só é aprovado com 1–11 sem ✗; se o passo 10 falhar, o T3 pode ser aprovado **sem** o fluxo de concessões (que segue desligado).

## 4. Primeira versão (plano de lançamento — nenhuma flag ativada agora)
| Item | v1 |
|---|---|
| Fechamento | **ligado** só para meses **sem pendências impeditivas** |
| Exceção de fechamento (SuperAdmin + MFA) | **desligada** (função sem EXECUTE para qualquer papel da aplicação; sem rota) |
| Reabertura | **desligada** (sem rota, sem botão, gatilho no banco) |
| Módulo `gestao_financeira` | nasce **desabilitado** em todas as empresas/unidades; habilitar por empresa/unidade é ato administrativo separado |
| Concessões por perfil (`FINANCEIRO_CONCESSOES_HABILITADAS`) | **desligada** até: (a) passo 10 do T3 aprovado (prova do `amr.timestamp`) **e** (b) sua autorização específica para ligar. Sem concessão ninguém acessa o Financeiro — é o portão da v1 |
Sequência proposta para produção (cada item com autorização própria): merge da `main` → aplicar 120 → 121 → 122 em janela própria → deploy com módulo desabilitado e flag desligada → piloto: habilitar módulo numa unidade + ligar concessões (pós-T3) + conceder a 1–2 perfis → acompanhar → ampliar.

## 5. Riscos que ainda impedem a publicação
1. **T3 não executado** (RLS/privilégios com papéis reais, exposição da API pública, PostgREST real, MFA real).
2. **Concessões dependem do MFA comprovado** — sem isso a v1 não tem como dar acesso pela interface.
3. **122 não promovida** e **merge na `main` pendente** (autorizações separadas; refazer o ensaio se a `main` andar).
4. **Revisão independente ausente** (toda a auditoria é do mesmo agente).
5. Operacional: o SHA-256 da `000_base_migration.sql` versionada não confere com o registrado no `BASE_MIGRATION_MANIFEST.md` (os dois vieram no mesmo commit `49fbd2b`; nem com fim de linha CRLF confere — provável hash calculado sobre outra geração do arquivo). No T3, conferir a base aplicada pela **contagem de objetos** do manifesto (78 tabelas, 79 policies etc. até a 067) antes de seguir.
