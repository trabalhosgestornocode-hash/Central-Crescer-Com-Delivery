# 21 — Diagnóstico SQL somente leitura do Supabase de testes e plano único do T3 compartilhado

Data: 2026-10-19 · Executor único: Agente 2. Decisão do responsável: **não criar projeto novo**; usar o projeto de testes existente, que **não é descartável**. Autorizado só leitura. **Nada foi escrito** no banco: nenhuma migration, dado, RLS, função ou teste destrutivo.

## 1. Como o diagnóstico foi feito (somente leitura comprovada)
- Conexão: `DATABASE_TESTE_URL` de `backend/.env`, lida só em memória e repassada por variável (`DIAG_CONN`). O valor nunca foi impresso nem gravado. `DATABASE_URL` do mesmo arquivo aponta para **produção** (`uqybgauuxcrqzquultfu`) e **não foi usada**.
- Ferramenta nova: `backend/testes-seguros/t3/diagnostico_leitura.mjs` + `diagnostico_leitura.sql`.
  - recusa sem `DIAG_CONN`, recusa o ref de produção e qualquer ref que não seja `wiqqsxnysbzhcrzrrean`, recusa terminal com `SUPABASE_URL`/`DATABASE_URL` de produção (as 4 recusas foram testadas sem conectar);
  - abre a sessão com `default_transaction_read_only=on`, `statement_timeout=20s`; o SQL faz `BEGIN TRANSACTION READ ONLY`, aborta se a sessão não estiver em modo leitura e termina em `ROLLBACK`;
  - só `SELECT` em catálogo e contagens; não chama nenhuma função de negócio; não lê texto de consultas de outras sessões.
- Saída conferida: `somente_leitura = on`. Duas execuções (a segunda acrescentou o md5 normalizado dos corpos).

## 2. Identidade e estado real
| Item | Resultado |
|---|---|
| Projeto | `wiqqsxnysbzhcrzrrean` (teste-multiempresarial) — **não é produção** |
| Servidor | PostgreSQL 17.6; usuário `postgres` (**não** superusuário, **com** BYPASSRLS, membro de `service_role`/`authenticator`) |
| Papéis | `service_role` BYPASSRLS; `anon`/`authenticated` sem BYPASSRLS; `authenticator` noinherit — igual ao simulado em `sim_supabase.sh` |
| Donos | as 109 tabelas do `public` são de `postgres`, todas com RLS (o gatilho de evento `ensure_rls` → `rls_auto_enable` liga RLS em toda tabela nova) |
| Default privileges | do Supabase: ALL em tabelas/sequências e EXECUTE em funções para `anon`/`authenticated`/`service_role` — exatamente o pior caso que as 120–122 revogam explicitamente (provado no simulador) |
| Financeiro | **ausente**: 0 tabelas `fin_*`/`gestao_financeira_*`, 0 funções; catálogo `modulos` com 16 linhas (sem 17 `gestao_financeira` e sem 18 `checklist_operacional`); CHECK de `categoria` = `operacao`/`integracao` |
| Migrations registradas | só **15** em `supabase_migrations.schema_migrations` (079, 080, 091, 100, 106, 068, 107, 077, 089, 108); o resto foi aplicado pelo SQL Editor → o registro **não** serve para medir drift (doc 19 §2 continua a referência) |
| Extensões | `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `supabase_vault`; `gen_random_uuid()` e `sha256()` disponíveis |
| `unidades` | 1 gatilho (`trg_und_upd` → `set_updated_at`); `service_role` com SELECT/UPDATE (pré-requisito do `FOR SHARE` da 121) |
| Dados | 17 organizações, 14 unidades (só 1 org com id do padrão sintético; nenhuma `[T3-FIN]`) |
| Atividade | só PostgREST, pg_net, pg_cron e exporter, todos ociosos no momento |

## 3. Funções compartilhadas que a 120 toca
| Função | Corpo × `main` (md5 normalizado) | Dono | Quem executa |
|---|---|---|---|
| `remapear_organizacao_em_tabelas_de_unidade` | **idêntico** | postgres | PUBLIC, anon, authenticated, service_role |
| `transferir_unidade_organizacao` | **idêntico** | postgres | idem |
| `promover_unidade_para_empresa` | **idêntico** (com o defeito `on conflict (usuario_id, organizacao_id)`) | postgres | idem |
| `converter_empresa_para_unidade`, `excluir_organizacao_definitivamente` | **idênticos** | postgres | idem |
| `set_updated_at` | idêntico | postgres | todos |
- A pré-condição da 120 ("quem aplica administra `remapear`") **passa** aplicando como `postgres`.
- `remapear` hoje varreria **42** tabelas (iFood, comunicação, bonificação, parser FD, Martin Brower, lançamentos operacionais…); com a 120 elas continuam sendo remapeadas como antes (as financeiras ficam fora).
- **ACHADO (pré-existente, fora do Financeiro):** a **115** (`fecha_acesso_direto_residual`) **não está aplicada** neste banco. As RPCs de estrutura (`transferir`, `promover`, `remapear`, `converter`, `excluir_organizacao_definitivamente`) estão executáveis por **PUBLIC/anon/authenticated** no banco. Se o PostgREST aceitar a chave pública, isso permitiria chamar transferência/exclusão de empresa sem login; a exposição pela API **não foi testada** (exigiria chamar a RPC; a OpenAPI com a chave pública devolveu 401 no doc 20 §5). Não toquei (não autorizado; é outra frente). A 120 não piora: depois dela, `remapear` chamada por `anon` falha na guarda (sem EXECUTE).
- **ACHADO (pré-existente):** o índice único de `usuarios_organizacoes` é `(perfil_id, organizacao_id)` e `promover` usa `on conflict (usuario_id, organizacao_id)` → toda promoção falha com 42P10 também aqui (doc 20 §6.1).

## 4. Compatibilidade com os outros módulos neste banco
- **iFood:** nenhuma tabela/função do iFood muda; `ifood_conexoes` e afins continuam no remapeamento. 124/125 ausentes aqui não interagem com 120–122.
- **Checklist:** 123 ausente; 120 usa a ordem 17 e o Checklist a 18 (ordem das migrations provada nos dois sentidos localmente).
- **Estrutura Organizacional:** com a 120 corrigida, unidade sem Financeiro transfere igual (equivalência provada); a promoção já falha hoje pelo defeito acima.
- **Mudança compartilhada inevitável:** CHECK de `modulos.categoria` (+`financeiro`), 1 linha em `modulos` (módulo desabilitado), substituição de `remapear` (mesmo corpo + guarda) e o gatilho novo em `unidades`.

## 5. O que pode ser testado SEM prejudicar dados existentes
- **Já possível (só leitura):** o diagnóstico acima; contagens por tabela antes/depois; `verificacoes_catalogo.sql` (depois das migrations); `pg_policies`/ACL.
- **Exige escrita (autorização):** tudo o que prova o Financeiro de verdade — aplicar 120–122, semente sintética, adversariais, concorrência, paridade, F-3/F-4 com PostgREST real, MFA.
- **Nunca neste banco:** rollback da 120; limpeza global/`truncate`/reset; `session_replication_role`; `desempenho_m1.sql` com 300 mil linhas; tocar organizações/unidades/perfis/conexões existentes; habilitar o módulo fora das organizações sintéticas; ligar `FINANCEIRO_CONCESSOES_HABILITADAS`.

## 6. Plano ÚNICO do T3 no banco compartilhado (cada passo marcado precisa de autorização expressa)
| # | Operação exata | Escreve? | Autorização |
|---|---|---|---|
| 0 | Janela combinada: nenhuma outra suíte (iFood/Checklist/estrutura) rodando; `diagnostico_leitura.mjs` de novo (linha de base) + contagem de linhas de **todas** as tabelas não financeiras | não | — |
| 1 | Adaptar as travas dos scripts de escrita para **modo compartilhado**: aceitar só `wiqqsxnysbzhcrzrrean` com `T3_COMPARTILHADO=SIM`, e trocar "nenhuma organização real" por **allowlist** de ids sintéticos (`00000000-0000-0000-0000-0000000f1a__`), recusando qualquer escrita fora deles | não (código local) | **A1** — aprovar a adaptação |
| 2 | Aplicar `120_gestao_financeira_fundacao.sql` → `121_gestao_financeira_dominio.sql` → `122_conciliacao_periodos.provisorio.sql` como `postgres`, cada uma com `psql --single-transaction -v ON_ERROR_STOP=1` e `PGOPTIONS='-c lock_timeout=5s'` (a 122 provisória não tem `begin/commit` próprio) | **sim** (esquema + `modulos` + função/gatilho compartilhados) | **A2** — específica |
| 3 | `verificacoes_catalogo.sql` (23 linhas `t`) + recontagem: tabelas não financeiras **iguais**, `modulos` +1 | não | — |
| 4 | Semente: 2 organizações `[T3-FIN]` e 3 unidades com ids da allowlist; nenhum vínculo com usuários existentes; módulo habilitado só nelas | **sim** (`organizacoes`, `unidades`, `organizacao_modulos`, `unidade_modulos`) | **A3** |
| 5 | Provas restritas à allowlist: `adversarial122*.sql`, `adversarial_d1_periodo_fechado.sql`, `f1_concorrencia.sh`, `parity_m1.mjs` (2 orgs), `f3_f4_e2e.mjs` (PostgREST real, teto 1000), transferência de unidade **sem** Financeiro entre as 2 orgs sintéticas (deve passar) e **com** Financeiro (deve recusar 22023), UPDATE direto de `unidades.organizacao_id` (deve recusar) | **sim** (linhas financeiras permanentes: o `service_role` não apaga e a auditoria é imutável) | **A4** — aceitar que ficam no banco |
| 6 | MFA: criar **1** usuário de teste (e-mail descartável) com TOTP pelo Supabase Auth; `amr_probe.mjs` com JWT só em variável | **sim** (`auth.users`, `auth.mfa_factors`) | **A5** |
| 7 | Encerramento: desabilitar o módulo e inativar as 2 organizações `[T3-FIN]`; **sem** rollback da 120/121/122 (o esquema financeiro fica inerte) | **sim** | **A6** |
| 8 | Evidências em `evidencias-t3/<data>/` (fora do Git se tiverem ids reais), com o commit testado | não | — |
Recuperação: antes do passo 4, dá para desfazer 122 → 121 (sem dados); a 120 **não** volta neste banco (mexe em `modulos` e, com a 121 presente, a função da 054 quebraria a transferência). Depois do passo 5, não há rollback: o esquema e os dados sintéticos permanecem.

**Recomendação antes do T3 (decisão de outra frente):** aplicar a 115 neste banco, para fechar o EXECUTE público das RPCs de estrutura.
