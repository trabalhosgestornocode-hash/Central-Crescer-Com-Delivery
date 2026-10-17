# Checklist de homologação T3 — MFA, concessões e isolamento (Supabase DESCARTÁVEL)

**Objetivo:** provar, num projeto novo e separado da produção, que as condições para ligar
`FINANCEIRO_CONCESSOES_HABILITADAS` são reais. **Enquanto este checklist não estiver 100% marcado e aprovado por escrito, a flag
permanece desligada** e conceder/revogar só existem como procedimento de emergência.

## 0. Pré-condições (bloqueantes)
- [ ] Projeto Supabase **novo**, criado só para isto, com nome que o identifica como descartável (ex.: `crescer-t3-descartavel`). Nenhum dado real.
- [ ] Marcador de ambiente gravado no banco (ex.: tabela/linha `ambiente_descartavel = true`) e verificado **antes** de qualquer escrita; os scripts recusam rodar se o marcador faltar.
- [ ] `backend/.env` de produção **fora do alcance**: usar um `.env.t3` próprio, nunca `--env-file=.env`. URL/chaves de produção não aparecem em nenhum arquivo da sessão.
- [ ] Aplicar as migrations existentes + **120** (e, na integração, a 121 do Agente 2) **somente neste projeto**.
- [ ] Autorização escrita do responsável para criar o projeto e aplicar as migrations.

## 1. Prova de MFA (AAL2 + 2º fator recente)
- [ ] Criar um SuperAdmin de teste e cadastrar TOTP.
- [ ] Capturar o JWT após login só com senha: `aal = "aal1"`; `amr` sem `totp`. → `avaliarMfaRecente` deve negar com `MFA_REQUERIDA`.
- [ ] Capturar o JWT após o desafio TOTP: `aal = "aal2"` e `amr` contém `{ method: "totp", timestamp: <segundos> }`. **Confirmar que `timestamp` é em SEGUNDOS** (hipótese de `shared/mfaRecente.js`) e o nome do método (`totp`).
- [ ] Aguardar > 10 min sem novo desafio: o mesmo JWT deve ser negado com `REAUTENTICACAO_RECENTE`; um novo desafio atualiza o carimbo.
- [ ] Refresh de token: confirmar se o `amr` preserva o carimbo do TOTP (se não preservar, a janela de 10 min fica menor que o esperado — registrar).
- [ ] Todo SuperAdmin real tem fator verificado **antes** de ligar a flag (senão ficam trancados fora das concessões).
- [ ] Registrar o resultado em documento datado (sem tokens): versão do Supabase Auth, claims observadas.

## 2. Prova ponta a ponta das concessões (flag LIGADA só neste ambiente)
- [ ] Conceder com AAL2 recente → 201; auditoria em `plataforma_auditoria` **e** em `gestao_financeira_concessoes_auditoria`.
- [ ] Conceder com AAL1 → 401 `MFA_REQUERIDA`; com AAL2 antigo → 401 `REAUTENTICACAO_RECENTE`; flag desligada → 403 `CONCESSOES_BLOQUEADAS`.
- [ ] Autoconcessão (perfil da própria conta) → 403 (serviço) e, por SQL direto, erro do trigger.
- [ ] Unidade de outra empresa → 400; perfil sem vínculo → erro do trigger; perfil `display_operator` → recusado.
- [ ] Revogar → a **próxima** requisição financeira do perfil recebe 403; a sessão **operacional** continua funcionando; `setores` deixa de listar `financeiro`.
- [ ] Concessão expirada → 403 sem intervenção.
- [ ] Impersonação (SuperAdmin entra como empresa) → financeiro 403 `FINANCEIRO_BLOQUEADO_IMPERSONACAO`.
- [ ] `organization_admin` sem concessão → 403 em todas as rotas `/gestao-financeira/*`.

## 3. Isolamento no banco (RLS, privilégios, superfícies)
- [ ] Com a chave `anon` e com um JWT `authenticated`: `select/insert/update/delete` em `gestao_financeira_concessoes` e `..._auditoria` → negado (REST).
- [ ] Mesmo teste para as tabelas do domínio do Agente 2 (121).
- [ ] RPC/GraphQL/views: `pg_graphql` não expõe as tabelas; nenhuma view/função nova concede acesso (`has_table_privilege`, `has_function_privilege` para `anon`/`authenticated`).
- [ ] Publicação Realtime não inclui essas tabelas.
- [ ] Duas empresas/duas unidades: leitura e escrita cruzadas → 0 linhas / erro.
- [ ] Perfil de exibição: nenhuma rota financeira; nenhuma linha.
- [ ] `get_advisors` (segurança) do Supabase sem alerta novo relacionado a estas tabelas.

## 4. Rollback e regressão
- [ ] `120_rollback.sql` recusa com concessão ativa / módulo habilitado; com tudo limpo, desfaz; reaplicar funciona.
- [ ] Executar o T1 e as suítes de integração (`npm run test:integracao` contra o **descartável**, com `.env.test-integracao` apontando para ele) sem regressão.
- [ ] Dashboard Operacional: smoke manual (login, seleção de unidade, Dashboard, Checklist, Dashboard iFood).

## 5. Critério de saída (todos obrigatórios)
1. Itens 0–4 marcados, com evidências arquivadas (sem segredos).
2. Revisão de `shared/mfaRecente.js` feita com as claims reais.
3. Aprovação escrita do responsável.
4. Só então: definir `FINANCEIRO_CONCESSOES_HABILITADAS=true` **no ambiente alvo**, nunca antes; habilitar o módulo para **um** cliente piloto por vez, com concessão explícita e motivo.

## Não faz parte deste checklist
Aplicar migrations em produção, habilitar usuários reais, `push`/`merge`/deploy — todos exigem autorização própria.

---

# Atualização A8 — as TRÊS migrations (120, 121, 122) no Supabase descartável

Ambiente: projeto Supabase **novo, descartável e separado de produção**, criado só com autorização. Nada abaixo foi feito. Tudo o que está marcado "(sim local)" já foi provado em PostgreSQL local com os privilégios do Supabase **simulados** (dono não-superusuário, *default privileges* concedendo ALL a anon/authenticated/service_role, `service_role` com BYPASSRLS) — por isso o que resta aqui é **confirmar que o Supabase real se comporta como a simulação**. Qualquer divergência é **bloqueante**.

## A. Papéis, dono e atributos (bloqueante)
- [ ] `select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('postgres','service_role','anon','authenticated','authenticator')`: **`service_role` tem BYPASSRLS** (as tabelas da 120 usam `FORCE RLS`; sem bypass o backend ficaria bloqueado) e `anon`/`authenticated` **não** têm.
- [ ] Dono real das tabelas e funções criadas pelas migrations (`pg_get_userbyid(relowner/proowner)`) e se esse dono tem BYPASSRLS. A 121/122 **não** usam `FORCE RLS` de propósito (os gatilhos `SECURITY DEFINER` dependem de o dono não ser filtrado pela RLS); a 120 usa `FORCE` (seus gatilhos rodam como invocador `service_role`).
- [ ] `select * from pg_default_acl` — listar os *default privileges* do projeto e conferir que são os que a simulação assumiu (ALL para anon/authenticated/service_role em tabelas, funções e sequências do `public`).

## B. Privilégios efetivos após aplicar 120 → 121 → 122 (rodar as mesmas consultas de `backend/testes-seguros/pg/sim_supabase.sh`)
- [ ] `anon`/`authenticated`: nenhum dos 7 privilégios em nenhuma tabela `fin_*` / `gestao_financeira_*` (sim local ✔).
- [ ] `service_role`: sem DELETE/TRUNCATE/REFERENCES/TRIGGER; `fin_auditoria` e `gestao_financeira_concessoes_auditoria` só por gatilho/insert mínimo (sim local ✔ após a correção da 120 feita no A8).
- [ ] **Sequências**: `fin_auditoria_id_seq` e `gestao_financeira_concessoes_auditoria_id_seq` sem USAGE/SELECT/UPDATE para anon/authenticated (sim local ✔; a 120 original falhava aqui).
- [ ] **Funções**: nenhuma `fin_*`/`gfc_*` executável por anon/authenticated (incluindo gatilho); RPCs com EXECUTE só para `service_role` (sim local ✔).
- [ ] `SECURITY DEFINER`: `fin_auditar`, `fin_desvincular_transferencia`, `fin_desvincular_transferencia_motivada` com `search_path = public, pg_temp`; confirmar dono e que `fin_desvincular_transferencia` (sem motivo) não é executável por ninguém além do dono.

## C. Acesso direto pela API pública (REST / GraphQL / Realtime) — só o Supabase real prova
- [ ] Com a chave **anon** e com um **JWT authenticated**: GET/POST/PATCH/DELETE em `/rest/v1/<cada tabela fin_* e gestao_financeira_*>` → negado (401/403/permission denied), nunca 200 com linhas.
- [ ] `/rest/v1/rpc/<cada função fin_*>` como anon/authenticated → negado; como service_role (somente pelo backend) → funciona.
- [ ] `pg_graphql`: introspecção como anon/authenticated **não lista** as tabelas/funções financeiras.
- [ ] Publicação Realtime (`supabase_realtime`) **não** inclui as tabelas financeiras.
- [ ] `get_advisors` (segurança e desempenho): nenhum alerta novo ligado a estas tabelas/funções.

## D. Reabertura de período e cancelamento (comportamento no banco)
- [ ] Decidir e aplicar a proposta **122b** (ou equivalente do Agente 2): com ela, `UPDATE fechado→reaberto` pelo `service_role` falha e `fin_reabrir_periodo` não é executável. **Sem a 122b isto é uma brecha aberta** (sim local: o `service_role` reabre um mês fechado por UPDATE direto).
- [ ] Cancelamento atômico do par e rede de segurança no COMMIT (`fin_transferencia_parcial`); desvínculo exige motivo; mês fechado recusa (sim local ✔).
- [ ] Concorrência real (duas sessões) no Postgres do Supabase: rodar `backend/testes-financeiro-pg/30_concorrencia.sh` contra o descartável.

## E. Aplicação e rollback no descartável
- [ ] 120 → 121 → 122 aplicam; cada uma reaplicada é idempotente; **nunca aplicar a 121 sozinha** (as correções R5–R10 estão na 122).
- [ ] Rollback **122 → (reaplicar 121) → 121 → 120**: o rollback da 122 deixa as escritas falhando (função de trava removida) até a 121 ser reaplicada — executar os dois passos juntos; o rollback da 121 recusa se houver QUALQUER linha (inclusive as linhas `aberto` de `fin_periodos` criadas automaticamente) — limpeza supervisionada.

## F. MFA / concessões (inalterado — ver seções anteriores)
- [ ] AAL2 e 2º fator ≤ 10 min; revogação imediata; flag `FINANCEIRO_CONCESSOES_HABILITADAS` só depois de tudo aprovado por escrito.

## G. Exceção de fechamento (LD-007, 122 de `cd35699`) — a repetir no Supabase DESCARTÁVEL
Pré-requisito: nada disto roda em produção. Todos os itens abaixo já passaram no PostgreSQL local (`docs/gestao-financeira/10-validacao-ld007-excecao-de-fechamento.md`); o T3 prova o que o local não prova.
- [ ] **Evento real de MFA** (usar `backend/testes-seguros/t3/amr_probe.mjs` com `T3_JWT` em variável de ambiente, nas etapas senha → TOTP → refresh após ~11 min → novo TOTP; o roteiro está no cabeçalho do script): `amr[].timestamp` do JWT é o do segundo fator efetivo (TOTP), **não** o da criação da sessão; um refresh de token **não** o renova; unidade em **segundos**. Só com isso a janela de **10 min** (`shared/mfaRecente.js`, `JANELA_MFA_RECENTE_MS`) é comprovada.
- [ ] **Evidência montada no servidor** a partir do JWT verificado (`aal`, `em` ISO-8601 UTC, `metodo`, `sessao_ref = sha256(session_id)`); `mfaEvidencia` vinda do corpo da requisição é ignorada/recusada; nenhum JWT/segredo chega ao banco nem à auditoria.
- [ ] Papéis reais do Supabase: `service_role` **sem** EXECUTE em `fin_conceder_excecao_fechamento`, `fin_revogar_excecao_fechamento`, `fin_reabrir_periodo`, validadores puros; `anon`/`authenticated` sem EXECUTE em nenhuma função `fin_*` mutante; PostgREST não expõe os validadores como RPC.
- [ ] Repetir `adversarial122.sql` + `adversarial122_complemento.sql` + `adversarial122_concorrencia.sh` (em `backend/testes-seguros/pg/`) sobre o esquema real: S0–S11 sem FALHA (exceto S11, que **deve** continuar mostrando R-1 até a mitigação).
- [ ] **R-1 (completude da conciliação) — M1 OBRIGATÓRIA (decisão do usuário, LD-011); IMPLEMENTADA e TESTADA LOCALMENTE pelo Agente 1 (doc 11), AGUARDANDO REVISÃO INDEPENDENTE:** recalcular as pendências de conciliação no banco e usar esse conjunto no fechamento e na concessão; `parity_m1.mjs` 100% igual; S11 passa a recusar; repetir tudo no Supabase descartável. Sem isto o fechamento em produção permanece bloqueado.
- [ ] O-1: `drop function if exists` das assinaturas antigas (`fin_fechar_periodo(...,int,boolean)`, `fin_conceder_excecao_fechamento(...,int,...,jsonb)`) no início da 122; confirmar que não restam sobrecargas.
- [ ] Endpoint de plataforma da exceção (meu): SuperAdmin + AAL2 recente (≤ 10 min) + motivo + auditoria + flag desligada; grant a papel específico em migration própria (nunca ao `service_role`), com revisão cruzada.
- [ ] **M1/O-1 no Supabase descartável:** `parity_m1.mjs` (`PG_CLUSTER_DIR` não se aplica: adaptar `PSQL`/porta ao projeto descartável ou rodar sobre um dump) 100 % igual; mutação 10/10 detectada; desempenho com ≥ 50 mil lançamentos/mês; `pg_proc` sem sobrecargas de `fin_fechar_periodo`/`fin_conceder_excecao_fechamento`; `fin_conciliacao_pendencias_ids` executável só por `service_role`.
- [ ] **Rotina:** incluir `parity_m1.mjs` na homologação de TODA mudança em `conciliacao.js` ou na função SQL (regra duplicada em JS e SQL).
- [ ] **Numeração de migrations:** o stream "Checklist universal + tempos" também usa 121; definir a ordem de entrada na main e renumerar o que entrar depois.
