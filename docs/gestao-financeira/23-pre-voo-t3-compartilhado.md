# 23 — Último pré-voo do T3 no Supabase de testes compartilhado (115, travas A1, sequência remota)

Data: 2026-10-19 · Executor único: Agente 2 · Branch local `final/financeiro`. **Nada foi escrito no banco de testes**: só sessões `default_transaction_read_only=on` com `BEGIN READ ONLY … ROLLBACK`. Nenhuma função de negócio foi executada remotamente. Sem push, PR, merge, deploy ou migration remota. Não há revisão independente.

## 1. A 115 no banco de testes (leitura: `t3/diagnostico_115.sql`)
**O que a 115 faz:** só `REVOKE ALL` de PUBLIC/anon/authenticated em 4 views (`vw_estoque_critico`, `vw_faturamento_diario`, `vw_produto_margem`, `vw_produtos_vendidos`) e em 7 RPCs. Devolve ao `service_role` só o acesso que ele já tinha. Liga o RLS de `unidade_config` só se estiver desligado. Tem pré e pós-condições de falha segura e é idempotente. Está aplicada em **produção** desde 10/10 (`docs/auditoria-producao-6b9-depois-da-115.txt`).

**Estado real do banco de testes:**

| Alvo | Estado |
|---|---|
| 4 views | ALL para `anon` e `authenticated`; dono `postgres` (BYPASSRLS) e sem `security_invoker`. Por isso **ignoram o RLS** das tabelas-base. Hoje devolvem 1 linha (`vw_produto_margem`); as outras 3 estão vazias |
| `transferir_unidade_organizacao`, `promover_unidade_para_empresa`, `converter_empresa_para_unidade`, `excluir_organizacao_definitivamente`, `remapear_organizacao_em_tabelas_de_unidade` | EXECUTE para PUBLIC, `anon` e `authenticated`. Todas são INVOKER, uma sobrecarga cada. **Nenhuma verifica autorização no corpo** (sem `auth.uid()`/`auth.role()`): só o RLS as segura |
| `bonificacao_congelar/reabrir_competencia` | **ausentes** (as migrations da bonificação mensal não estão neste banco) |
| Exposição | `anon` tem USAGE em `public`. O PostgREST serve `public` (doc 19: 114 tabelas e 63 RPCs pela API). `pgrst.db_schemas` não aparece no catálogo. **A chamada pela API não foi feita** (seria explorar) |
| Pré/pós-condições da 115 aqui | `postgres` administra os 9 alvos. Nenhuma herança em `anon`/`authenticated`. Nenhum grant de outro concedente. Nenhuma view ou policy dependente. ⇒ a 115 aplica sem ajuste |

**Risco efetivo, provado só no PostgreSQL local** (`pg/ensaio_115_120.sh`, réplica do estado lido, funções executadas só lá):
- **R1 — leitura sem login (EFETIVO):** `anon` lê pela view o faturamento que o RLS esconde na tabela `vendas`. Vale para estoque, margens e vendidos de **todas** as unidades. O volume hoje é baixo (1 linha), mas a classe do risco é alta.
- **R2–R5 — escrita pelas RPCs (hoje bloqueada por acaso):**
  - `anon`: o RLS não tem policy para ele, então a RPC não encontra nada e não muda linha nenhuma;
  - `authenticated`: transferir/promover/converter/excluir abortam no INSERT de `plataforma_auditoria`, que não tem policy de INSERT;
  - `remapear` chamada direto aborta porque faltam UPDATE em 8 tabelas da varredura (lido neste banco).
- **R5b — latente:** basta um GRANT de UPDATE nessas tabelas, vindo de qualquer frente, para um usuário comum da unidade regravar `organizacao_id` de conexões iFood e importações do Parser FD para outra empresa, sem auditoria. A 115 fecha isso por desenho.
- **Fora da 115 (achado para outra frente):** a policy `rls_unidades_tenant` (ALL para `authenticated`) mais o GRANT de UPDATE deixam um usuário membro de duas empresas mover a unidade com `PATCH /unidades` (R6). A 115 não trata tabelas. A 120 bloqueia isso como efeito colateral, pelo gatilho que chama a guarda sem EXECUTE para `authenticated` (A9). Não li isso em produção.

**Correção recomendada:** aplicar a **115 como está** (o mesmo arquivo de produção, sha256 `10b88ee30e5ff21f…`) neste banco, como `postgres`, **antes** da 120. Não é preciso código novo. Ensaio local:
- A1: aplica sem as `bonificacao_*` ("4 views e 5 funções");
- A3: é idempotente;
- A4: fecha R1 e R5;
- A5: o backend (`service_role`) continua transferindo.

**Impacto em outros serviços:**
- As 4 views e as 5 RPCs só são usadas pelo **backend**, pelo cliente único `service_role`: Dashboard, CMV, tabela comercial, Plataforma/Estrutura e Bonificação.
- Frontend: só cita os nomes em comentários; usa a chave anon só para Auth e Realtime.
- iFood, Checklist, gateway WhatsApp e workers: nenhuma referência (busca no repositório).
- ⇒ nenhum serviço perde acesso.

## 2. Relação 115 × 120 (provada nos dois sentidos, `pg/ensaio_115_120.sh`: 28 OK)
- A 120 **não depende** da 115 (B1) e **não fecha** o que é da 115 (B2, B3): sem a 115, as views continuam expostas depois do Financeiro.
- A 120 recria `remapear` com `create or replace`, que **preserva** o ACL fechado pela 115 (A7). A 115 aplicada depois **não toca** na definição (B6) e mantém as guardas e o gatilho da 120 (B7).
- As duas ordens terminam com **privilégios idênticos** em 40 funções financeiras e nos alvos da 115, e com a mesma `remapear` (=).
- **Ordem recomendada: 115 → 120 → 121 → 122.** Assim o banco de testes reproduz a ordem da produção e o T3 não mede o Financeiro sobre um furo que a produção não tem.

## 3. Pré-requisitos das 120–122 neste banco (leitura: `t3/diagnostico_prerequisitos.sql`)
- Todas as 25 colunas usadas existem: 030, 034, 053, 060 e `set_updated_at`; `remapear` (054) e `transferir` presentes.
- Ordem 17 e id `gestao_financeira` livres. CHECK de `categoria` = operação/integração. Nenhum nome financeiro em uso. Ids e nomes da allowlist livres.
- `organizacoes`/`unidades` só têm gatilho de UPDATE (`set_updated_at`); nenhum gatilho de INSERT. A semente não dispara herança de módulos.
- `postgres` pode fazer SET ROLE para `service_role`, `anon` e `authenticated` (as provas usam).
- Efeitos esperados de gatilhos de evento do Supabase:
  - `ensure_rls` liga o RLS nas tabelas novas (a 120 já liga e força);
  - `pgrst_ddl_watch` recarrega o cache do PostgREST a cada DDL, inclusive nas tabelas temporárias do embrulho. Recarga breve.
- Migrations ausentes aqui (doc 19: 072–076, 078, 081, 105, 109, 110, 112–118, 123–125) **não** são pré-requisito das 120–122.
  - Uma 123 aplicada depois já foi provada compatível nos dois sentidos (doc 21 §4).
  - O banco continua **não** espelhando a produção: o T3 prova o Financeiro, não a cadeia de produção.

## 4. Travas do T3 compartilhado (A1) — `backend/testes-seguros/t3/compartilhado/`

| Arquivo | Papel |
|---|---|
| `t3c.mjs` | executor **único** dos passos remotos: `preflight`, `m115`, `migracoes`, `semente`, `provas`, `encerrar`, `verificar`, `bloqueados` |
| `semente_compartilhado.sql` / `encerrar_compartilhado.sql` | semente `[T3-FIN]` e encerramento, rodam embrulhados |
| `transferencia_compartilhado.sql` | transferência entre as duas empresas sintéticas: sem Financeiro passa; com Financeiro, por RPC ou UPDATE direto, recusa |
| `ensaio_t3c.sh` | ensaio local do executor: **40/40 OK** |

**Travas:**
1. **Ambiente:**
   - só variáveis `T3C_*` explícitas; o executor não lê arquivo `.env` (provado: sem dotenv nem leitura);
   - recusa `NODE_OPTIONS --env-file`;
   - os processos filhos recebem um ambiente montado do zero.
2. **Identidade:**
   - recusa o ref de produção em **qualquer** variável do terminal;
   - exige exatamente `wiqqsxnysbzhcrzrrean` em `T3C_PROJECT_REF`, no host ou usuário do pooler e na URL;
   - pede `T3C_CONFIRMO=COMPARTILHADO_<ref>`, diferente do token dos scripts descartáveis;
   - pede `T3C_IDENTIDADE`, uma impressão viva do banco (oid do banco, oid do `public` e versões em `supabase_migrations`) lida no preflight e conferida antes de cada passo, dentro da própria transação.
3. **Autorização por passo:** cada passo exige sua variável (`T3C_AUTORIZO_115`, `T3C_AUTORIZO_MIGRACOES`, `T3C_AUTORIZO_SEMENTE`, `T3C_AUTORIZO_PROVAS` com `T3C_ACEITO_DADOS_PERMANENTES`, `T3C_AUTORIZO_ENCERRAMENTO`). Sem ela, só lista arquivos e sha256 e não conecta. O SQL embrulhado de um passo não roda com a autorização de outro.
4. **Allowlist:** 2 organizações e 6 unidades `00000000-0000-0000-0000-0000000f1a__`.
   - As provas SQL rodam numa transação REPEATABLE READ (a transferência, em READ COMMITTED, que a guarda exige).
   - Antes do COMMIT, o embrulho compara a impressão (contagem + md5) de **tudo o que está fora da allowlist**: 123 tabelas e `auth.users`.
   - Também exige que **toda** linha `fin_*` seja de uma organização da allowlist.
   - Qualquer diferença ⇒ ROLLBACK. Ensaio: empresa real alterada (V1), linha financeira de empresa real (V2) e Financeiro habilitado em loja real (V3) foram todos desfeitos.
   - Provas multissessão (f1, f3f4) conferem antes e depois; nesse caso não há rollback automático.
5. **Proibições:**
   - só arquivos do manifesto, commitados (sem alteração local);
   - lint recusa truncate, `session_replication_role`, reset/discard, grant/revoke, DDL fora de `pg_temp`, controle de transação, `\c`/`\!`/`\i`/`\copy`, delete fora de `fin_*`/módulos, `set role` para papel não previsto e id descartável não remapeado.
   - Bloqueados com motivo (`t3c.mjs bloqueados`): `parity_m1.mjs` (usa `replica`), `desempenho_m1.sql`, `adversarial122_concorrencia.sh`, `seed_descartavel.sql`, etapa base do `aplicar_estrutura_t3.sh`, scripts que recriam bancos, todos os `*_rollback.sql`.
6. **Originais intactos:**
   - `git diff` vazio nos scripts descartáveis;
   - `adversarial122.sql`, `seed_descartavel.sql` e `preflight_t3.mjs` continuam **recusando** um banco com empresas reais e o projeto compartilhado (O1–O4).
   - As provas só rodam aqui **adaptadas em memória**: trava substituída, ids remapeados para a allowlist e cortes **declarados**:
     - `adversarial122` sem S6a/S6b;
     - `adversarial122_complemento` sem S7v/S7w.
     - Esses casos exigem desligar os gatilhos da sessão e continuam provados no local.

**Ensaio local do fluxo inteiro** (réplica com 3 empresas, lojas e usuários reais, a 115 reaberta e um papel `postgres_t3c` não-superusuário com BYPASSRLS, como o `postgres` do Supabase):

| Passo | Resultado |
|---|---|
| preflight | 123 tabelas impressas, 115 detectada ausente |
| m115 | nenhum dado mudou |
| migracoes | catálogo 23/23; fora da allowlist só `modulos` mudou |
| semente | ok, idempotente |
| d1 | 44/44 |
| adv122 | 68/68 |
| adv122c | 3/3 |
| r1 | recusa `fin_conciliacao_divergente`, como esperado |
| transferência | 7/7 |
| f1 | 31/31 |
| encerrar | ok |
| verificar × linha de base | só `modulos` |

A F-3/F-4 (`f3f4`, PostgREST real) não roda no ensaio do executor. O próprio script passou 10/10 no modo local.

Defeito encontrado e corrigido no ensaio: o psql do Windows termina as linhas com `\r`, e o parse da impressão do preflight/verificar saía **vazio**, o que tornava a conferência detectiva sem efeito. Agora a impressão vazia ou incompleta **falha fechada** e o ensaio exige pelo menos 50 tabelas. As conferências preventivas (tabela temporária na transação) não eram afetadas.

## 5. Ordem exata das operações remotas (cada uma só com a sua autorização)
Terminal limpo, só com as variáveis do T3:
- `T3C_PSQL_CONN` = conexão do projeto de testes, passada por variável;
- `T3C_PROJECT_REF=wiqqsxnysbzhcrzrrean`;
- `T3C_CONFIRMO=COMPARTILHADO_wiqqsxnysbzhcrzrrean`;
- `T3C_EVIDENCIAS` fora do Git;
- para a F-3/F-4: `T3C_SUPABASE_URL` e `T3C_SERVICE_ROLE_KEY` do projeto de **testes**.

| # | Comando | Escreve | Autorização |
|---|---|---|---|
| 0 | janela combinada sem outras suítes; `t3c.mjs preflight` → anotar `T3C_IDENTIDADE` e `T3C_LINHA_DE_BASE` | não | — |
| 1 | `T3C_AUTORIZO_115=SIM t3c.mjs m115` | privilégios (só REVOKE) | **A0** |
| 2 | `T3C_AUTORIZO_MIGRACOES=SIM t3c.mjs migracoes`: 120 e 121 com transação própria; 122 provisória com `--single-transaction`; `lock_timeout` de 5 s em todas | esquema, `modulos`, `remapear`, gatilho em `unidades` | **A2** |
| 3 | `psql … -f t3/verificacoes_catalogo.sql` (23 × t) e `t3c.mjs verificar` (só `modulos` difere) | não | — |
| 4 | `T3C_AUTORIZO_SEMENTE=SIM t3c.mjs semente` | 2 organizações e 6 unidades `[T3-FIN]`, módulo habilitado só nelas | **A3** |
| 5 | `T3C_AUTORIZO_PROVAS=SIM T3C_ACEITO_DADOS_PERMANENTES=SIM t3c.mjs provas d1,adv122,adv122c,r1,transferencia,f1,f3f4` | linhas `fin_*` sintéticas permanentes | **A4** |
| 6 | MFA: criar 1 usuário de teste com e-mail descartável pelo Supabase Auth, cadastrar TOTP e rodar `T3_JWT=… node t3/amr_probe.mjs <rótulo>` (roteiro do doc 05 §G). O executor não escreve aqui | `auth.users`, `auth.mfa_factors` | **A5** |
| 7 | `T3C_AUTORIZO_ENCERRAMENTO=SIM t3c.mjs encerrar` e depois `t3c.mjs verificar` | módulo desabilitado; `[T3-FIN]` inativas | **A6** |

**Correção do doc 21 §6, passo 2:** 120 e 121 têm `begin/commit` próprios. `--single-transaction` vale só para a 122 provisória. O executor já faz assim.

## 6. O que permanece no banco depois do T3
- **Privilégios (115):** 4 views e 5 RPCs fechadas para PUBLIC/anon/authenticated, como em produção.
- **Esquema financeiro (inerte):**
  - 14 tabelas `fin_*`/`gestao_financeira_*` com RLS forçado e sem policy;
  - 40 funções `fin_`/`gfc_`/`gestao_financeira_`;
  - `remapear` com a guarda;
  - gatilho `trg_unidades_guarda_financeiro`;
  - CHECK de `modulos.categoria` com `financeiro`;
  - a linha `gestao_financeira` em `modulos`.
- **Dados sintéticos:**
  - 2 organizações e 6 unidades `[T3-FIN]`, inativas;
  - categorias, contas, lançamentos, referências, resoluções, períodos (inclusive meses fechados de 2027–2036) e `fin_auditoria` das provas;
  - a F-4 acrescenta cerca de 5 000 referências e 5 000 resoluções numa unidade só dela;
  - linhas de `plataforma_auditoria` das transferências entre as duas empresas sintéticas;
  - com A5: 1 usuário de teste e o fator TOTP.
- **Fica de fora:** nenhuma empresa real com o módulo, nenhuma concessão, a flag de concessões desligada. Nada que o `service_role` consiga apagar: a auditoria é imutável por desenho.

## 7. Inativação ao final (A6)
`encerrar_compartilhado.sql`, numa transação com a conferência da allowlist:
- remove as habilitações do módulo **só** das organizações e unidades `[T3-FIN]`;
- marca `ativo = false` nelas;
- aborta se sobrar habilitação do módulo em qualquer lugar ou concessão ativa.

Não faz rollback de migration (a 120 não volta neste banco: doc 21 §6). Não apaga dado financeiro. Depois, `t3c.mjs verificar` compara com a linha de base do preflight: fora da allowlist, só `modulos` pode diferir.

## 8. Regressão
Só mudaram ferramentas de teste e documentação:
- `t3/diagnostico_leitura.mjs` passou a aceitar `diagnostico_*.sql` desta pasta;
- arquivos novos em `t3/` e `pg/ensaio_115_120.sh`.

Nenhum código da aplicação, migration ou script original mudou. A bateria está na seção 4 do checkpoint (doc 22) e foi refeita: ver o resumo da entrega.
