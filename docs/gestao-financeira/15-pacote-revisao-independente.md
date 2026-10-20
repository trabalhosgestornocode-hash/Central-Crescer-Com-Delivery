# 15 — Pacote para REVISÃO INDEPENDENTE (Agente 2 ou outro revisor)

Data: 2026-10-18 · Branch `integracao/gestao-financeira` · Entrega do Agente 1 (que implementou **e** fez auditoria local própria: **não é independente**). Objetivo: permitir que alguém que **não escreveu** M1/O-1/F-1/F-2 confirme ou conteste, sem refazer o trabalho. Nada publicado; 122 sem promoção; concessões desligadas.

## 1. Como ler (ordem sugerida, ~2–3 h)
1. Este arquivo (mapa) → 2. `11-m1-o1-conciliacao-autoritativa.md` (problema R-1 e solução) → 3. `12-auditoria-m1-o1.md` (auditoria local, itens 1–12) → 4. `13-f1-f2-pre-fechamento.md` → 5. `10-validacao-ld007-excecao-de-fechamento.md` (provas adversariais e MFA) → 6. o SQL (seção 3) → 7. reproduzir (seção 6) → 8. `14-roteiro-t3-supabase-descartavel.md` (o que falta provar fora do ambiente local) e `16-conflitos-com-a-main.md`.

## 2. Commits (do mais novo ao mais antigo; base = `ebb355f`)
| Commit | Conteúdo |
|---|---|
| (este checkpoint) | docs 14–16, `verificacoes_catalogo.sql`, `f3_f4_e2e.mjs`, `seed_descartavel.sql`, `desempenho_m1.sql`, `reproduz_r1.sql`; scripts parametrizados para o T3 |
| `1d7bcfc` | **F-1** (impressão digital + trava + guarda de mês fechado) e **F-2** (UI após 409) |
| `6cb2305` | auditoria local da M1/O-1 (doc 12); harness ampliado (2 organizações, contas inativas, fronteiras) |
| `6d29b37` | verificação de numeração de migrations (Checklist já é 123) |
| `f2b1a40` | **M1** (`fin_conciliacao_pendencias_ids`) e **O-1** (assinaturas obsoletas) |
| `c963bce` | harness de paridade, sonda `amr`, correção da prova S11 |
| `115d634` / `87428ba` | integração de `cd35699` (Agente 2) e validação de LD-007 com ressalva R-1 |
| `cd35699`, `d848c81`, `8a644bd` | Agente 2: A1–A6 de LD-009 (MFA 10 min, evidência fechada, cobertura por conjunto), P-1, F-D |
| `962ba6d` / `7913b11` / `8747b8a` | B9 integrado; 122 única (F-A/F-B); exceção de fechamento por competência |
| `969faff`, `570820a`, `22271b7` | Agente 2: B9 (relatórios, exportações, configurações) |

## 3. SQL e funções críticas — `docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql` (878 linhas) e `122_rollback.provisorio.sql` (154)
| Função / objeto | Linha | O que revisar |
|---|---|---|
| `drop function if exists fin_fechar_periodo(…integer, boolean)` / `fin_conceder_excecao_fechamento(…integer, integer, jsonb)` | 11–12 | O-1: só assinaturas de **rascunhos**; nenhuma função da 120/121 |
| `fin_mfa_evidencia_valida`, `fin_ids_conciliacao_validos` | 94, 106 | lista fechada de chaves; sem JWT/segredo; validadores **sem EXECUTE** para qualquer papel de aplicação |
| `fin_periodo_travar_e_checar` | 143 | trava existente (121/122): FOR SHARE e recusa se fechado |
| `fin_fingerprint_periodo` | 237 | **F-1**: + `tipo_conta:canal` das contas com movimento no mês e exceções de sangria ativas cuja categoria tem saída no mês |
| `fin_periodo_travar` | 271 | **F-1**: FOR SHARE devolvendo o status (sem raise); cria âncora `aberto` |
| `fin_contas_regra_conciliacao_trava` + gatilho (279, 292) | | **F-1**: toma a trava dos meses com movimento (ordem crescente) e **recusa mês fechado** |
| `fin_sangria_excecoes_regra_trava` + gatilho (294, 307) | | **F-1**: toma a trava dos meses em que a categoria tem saída; **não** recusa mês fechado (decisão a contestar, ver §7) |
| **`fin_conciliacao_pendencias_ids`** | **322** | **M1**: STABLE, invoker, `search_path` fixo; replica `conciliar()`; ponte (venda **e** taxa), caixa/dia, sangria/dia; resoluções vigentes; referências ativas; exceções de sangria ativas |
| **`fin_fechar_periodo`** | **397** | lock → versão → impressão digital → **conjunto do banco** → conferência com a lista da app (igualdade) → exige exceção/reconhecimento → **cobertura por subconjunto** → consome a exceção → fecha (flag `fin.fechando_periodo`) |
| `fin_periodos_bloqueia_reabertura`, `fin_periodos_bloqueia_fechamento_direto` | 708, 721 (+gatilhos 717, 730) | F-A e F-D (flags locais de transação) |
| `fin_excecoes_fechamento_guarda` | 736 | imutabilidade; escrita só pelas funções |
| `fin_conceder_excecao_fechamento` | 760 | conjunto **do banco**; MFA ≤ 10 min; validade ≤ 30 d; **sem EXECUTE** para `service_role` |
| `fin_revogar_excecao_fechamento`, `fin_consumir_excecao_fechamento` | 803, 818 | consumo só dentro do fechamento do mesmo período |
| Privilégios e pós-condição | ~830–880 | `revoke`/`grant` e `raise exception '122 abortada…'` (reabertura, conceder/revogar, validadores, gatilhos F-1, `fin_periodo_travar`, sobrecargas O-1) |
Fora do SQL: `backend/src/modules/gestao-financeira/dominio/{periodos.service.js, repositorio.periodos.js, repositorio.util.js (409 FIN_CONCILIACAO_DIVERGENTE)}`, `backend/src/financeiro-calculos/{conciliacao.js, periodos.js}`; frontend `src/financeiro/{periodos.js, ui.js, financeiro-paginas.css}`.
Obsoleto (não aplicar): `122b_endurecimento.proposta.sql` e `122b_rollback.proposta.sql` (incorporados à 122 única).

## 4. Diferenças dos testes (o que **mudou** nos testes do Agente 2 — conferir que nada foi afrouxado)
```bash
git diff cd35699 1d7bcfc -- backend/testes-financeiro-pg backend/test/financeiro backend/test/gestao-financeira-a8-integrado.test.js
```
- `20_periodos_conciliacao.test.sql`: blocos **4a, 4f2, 4k** reescritos. Antes aceitavam ids de conciliação **fabricados** como se fossem pendências (era o R-1 codificado). Agora: cenário **real** (venda+taxa ⇒ ponte aberta; dinheiro 1 000 × caixa 700 ⇒ `caixa_dia`), lista omitida/extra/repetida/nula ⇒ `fin_conciliacao_divergente`, pendência de conciliação **nova real** ⇒ `fin_periodo_excecao_insuficiente`, troca 1-por-1 **real**, resolver coberta ⇒ fecha e consome 1×. 4f2 passou de "qualquer 23514" para `fin_conciliacao_divergente` (mais estrito).
- `gestao-financeira-a8-integrado.test.js`: política (`PUT /periodos/politica` ⇒ 403 `POLITICA_EXCEPCIONAL_DESABILITADA`) e reabertura (rota inexistente ⇒ 404 para POST/PUT/PATCH/DELETE).
- Novos: `test/financeiro/conciliacaoAutoritativa.test.js` (409), `test/gestao-financeira-b9-exportacoes.test.js` (9), scripts em `backend/testes-seguros/pg/` e `t3/`.
- QA visual: `qa-integrado.mjs` (a tela de Períodos não tem mais o texto sobre reabertura; checagem de "sem botão" mantida) e novo `qa-f2.mjs`.

## 5. Evidências (todas locais; PostgreSQL 17 descartável + privilégios Supabase simulados)
| Prova | Resultado |
|---|---|
| Ciclo 120→121→122→122→rollback→reaplica→…→rollback total→reaplica (`ciclo_120_121_122.sh`) | OK; rollback com dados **recusa** |
| Privilégios (`sim_supabase.sh`) | sem falhas; `verificacoes_catalogo.sql` **23/23** (e reprova ao enfraquecer RLS/EXECUTE/sobrecarga) |
| Paridade JS × SQL (`parity_m1.mjs`) | **531/531** em 3 sementes (2 organizações, contas inativas, fronteiras); **mutação 16/16** detectada |
| Adversariais (`adversarial122*.sql/.sh`) | 70 + 5 PASS, 0 FALHA (MFA 22 variações, uso duplicado, vencida, SQL direto, outra unidade/organização, assinatura antiga, falha de transação, corrida de 3 sessões) |
| F-1 (`f1_concorrencia.sh`, sessões reais) | **31/31**; mutação sem a impressão digital ⇒ 7 falhas; sem gatilhos ⇒ 6 falhas |
| Suíte do Agente 2 (`backend/testes-financeiro-pg/run.sh`) | exit 0 (inclui cancelamento de transferências, concorrência de fechamento/cancelamento/exceção) |
| Desempenho | 60 mil lançamentos: função 75–155 ms, fechamento 210–260 ms; 300 mil: função ~480 ms |
| Backend T1 / domínio+HTTP integrado / frontend / navegador real | 5386 ok (3 falhas conhecidas) / 235/235 / 1530 ok / 17/17 |
| QA visual (Chrome real) | 56/56; F-2 em desktop, celular e tema escuro 30/30 (409 real) |
| Ensaio de merge com a `main` (worktree descartável) | ver doc 16 |

## 6. Reprodução do R-1 (antes e depois)
```bash
export PG_CLUSTER_DIR=<cluster descartável com MARCADOR_DESCARTAVEL>
git show cd35699:docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql > /tmp/122_pre_M1.sql
P122=/tmp/122_pre_M1.sql bash backend/testes-seguros/pg/sim_supabase.sh && psql -h 127.0.0.1 -p 54321 -U postgres -d sim -q -tA -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL -f backend/testes-seguros/pg/reproduz_r1.sql   # ANTES: imprime "fechado" (mês com ponte aberta fecha com lista vazia, sem exceção)
bash backend/testes-seguros/pg/sim_supabase.sh && psql -h 127.0.0.1 -p 54321 -U postgres -d sim -q -tA -v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL -f backend/testes-seguros/pg/reproduz_r1.sql                       # DEPOIS: ERROR fin_conciliacao_divergente (informada=0, banco=1)
```
Para preparar o cluster: `initdb -D <dir> -U postgres -A trust --no-locale -E UTF8 && echo d > <dir>/MARCADOR_DESCARTAVEL && pg_ctl -D <dir> -o "-p 54321 -c listen_addresses=127.0.0.1" start` (porta fixa 54321; exportar `PGCLIENTENCODING=UTF8`).

## 7. Perguntas objetivas ao revisor
1. `fin_conciliacao_pendencias_ids` ≡ `conciliar()`? Pontos de atenção: `receita_operacional` na ponte e no caixa; saída de caixa com categoria nula; `status = 'realizado'`; `chave` das resoluções (dia/1º do mês); dia que existe só por referência.
2. **Igualdade** (fechamento) × **subconjunto** (cobertura da exceção): decisão correta? O fechamento exige lista da app **igual** ao conjunto do banco; a exceção cobre se o conjunto atual ⊆ coberto.
3. F-1: o escopo "só o que afeta este mês" da impressão digital é suficiente? Há outra entrada da regra fora da trava/impressão (ex.: `fin_plano_contas.papel` — hoje imutável quando em uso)?
4. **Não** recusar criar/alterar exceção de sangria em mês fechado é aceitável (a visão ao vivo do mês fechado passa a refletir a regra atual)? Alternativa: congelar a conciliação do mês fechado no snapshot.
5. Os gatilhos criam âncoras `fin_periodos` por mês com movimento: aceitável? Risco de deadlock (ordem crescente de mês, só o fechamento toma FOR UPDATE)?
6. Flags locais de transação (`fin.fechando_periodo`, `fin.reabertura_autorizada`, `fin.excecao_op`): limite aceito (não defendem SQL bruto de `service_role`)?
7. UX do 409 (F-2) e mensagem; a tela deve atualizar sozinha em vez de pedir clique?
8. Desenho do T3 (doc 14): falta alguma prova? O `f3_f4_e2e.mjs` **nunca foi executado**.

## 8. Riscos residuais conhecidos (consolidado)
Regra duplicada em JS e SQL (mitigada por paridade; precisa entrar na rotina de mudança); entradas fora da trava (plano de contas) hoje protegidas por outras regras; visão ao vivo de mês fechado ≠ snapshot se exceções mudarem; âncoras `fin_periodos`; limite de 5 000 linhas em referências/resoluções (F-4: falha fechada, a provar no T3); flags locais não defendem `service_role` com SQL bruto; `fin_abrir/fingerprint/reabrir` sem `search_path` fixo; MFA (`amr.timestamp`) ainda **não provado com TOTP real**; revisão **não independente**; T3 não executado.

## 9. Resultado a devolver
`APROVADO` / `APROVADO COM RESSALVAS` / `REPROVADO`, com achados (arquivo:linha, evidência, recomendação) na Ligação Direta (`02` do Agente 2 ou arquivo do revisor). A aprovação local **não substitui** o T3.
