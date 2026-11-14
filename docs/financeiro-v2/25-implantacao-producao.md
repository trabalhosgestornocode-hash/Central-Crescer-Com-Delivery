# Financeiro v2 — 25. Implantação em produção: compatibilidade, inspeção real, pacote de instalação e aprovações

Data: 14/11/2026. Branch local `feat/financeiro-v2-producao` (de `0a99637`). **Situação: NÃO PUBLICADO** — nada foi
alterado no projeto Supabase; nenhuma rota nova; nenhum deploy.

## 1. Etapa A — compatibilidade definitiva (feito, local)

- **Aplicador** (`backend/scripts/fv2/ambiente.mjs`): aplica 0001–0021 no schema dedicado `financeiro_v2` com as
  adaptações A1–A4 (doc 24 § 11). Os arquivos 0001–0021 **não mudam**: o registro guarda o hash do arquivo **e** o hash
  do texto aplicado; arquivo editado depois de aplicado continua sendo recusado.
- **Banco-modelo dos testes migrado por papel NÃO superusuário** (`fv2_teste_migrador`: CREATEROLE + BYPASSRLS, como o
  `postgres` do Supabase). A suíte PostgreSQL inteira roda contra o schema dedicado.
- Duas falhas reais apareceram e foram tratadas: (1) restauração de backup precisa do `search_path` do módulo (em
  produção ele fica nos papéis de login, que não vão no dump); (2) o guardião passa a ter **uma** participação ADMIN
  implícita (PostgreSQL 16+, sem SET/INHERIT) do migrador — o teste agora exige "nenhuma participação utilizável" e
  "só o migrador, só ADMIN" (decisão D-24-1).

## 2. Etapa B — inspeção SÓ LEITURA do projeto "Crescer Com Delivery" (feito; só metadados)

| Item | Resultado |
|---|---|
| PostgreSQL | 17.6 |
| Papel de migração `postgres` | não superusuário; CREATEROLE; BYPASSRLS; `createrole_self_grant` vazio — **igual à simulação** |
| `postgres` herda | `pg_read_all_data` (lê qualquer tabela), anon/authenticated/service_role/authenticator (ADMIN) |
| Credenciais comuns (`service_role`, `authenticator`, `anon`, `authenticated`) | **não** herdam `pg_read_all_data` nem `pg_write_all_data` |
| Outros com `pg_read_all_data` | `supabase_etl_admin`, `supabase_read_only_user` (internos do Supabase) |
| Privilégios padrão | só por schema (`public`, `storage`, `graphql*`, `auth`, `realtime`, `extensions`); **nenhum global** → o schema novo não herda nada |
| Conflitos | schema `financeiro_v2`: não existe; papéis `fv2_*`: nenhum |
| Extensões | pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp (o v2 não exige nenhuma) |
| Pré-carregadas | pgaudit, pg_cron, pg_net, pgsodium, auto_explain… (pgaudit disponível para auditoria) |
| `authenticator` | `safeupdate` e `supautils` na sessão, tempo limite 8 s (o v2 não passa pelo authenticator) |
| Conexões | **máx. 60; 25 em uso** na leitura → pool do v2 precisa ser pequeno (proposta: app 4, autoridade 2) |
| Banco | 407 MB; `track_counts` e `autovacuum` ligados |
| Storage | 3 buckets, todos privados (nenhum do v2) |
| Legado | 29 tabelas `fin_*`/`gestao_financeira_*` presentes; gatilho `trg_unidades_guarda_financeiro` ativo; módulo `gestao_financeira` cadastrado; 10 concessões do legado |
| MFA (Auth) | **1 fator TOTP verificado**; 14 sessões `aal2` com prova `totp` → o provedor emite a evidência do segundo fator |
| Backend atual | fala com o banco **só** pela API do Supabase (`service_role`); não há conexão PostgreSQL direta |
| Foto do sistema atual (`inventario.sql`) | **1.794 itens, sha256 `36bfe8692c47…`** (referência "antes") |
| Backup/PITR | **não visível por SQL** — confirmar no painel (Database → Backups) |

## 3. Pacote de instalação (feito, local; NÃO aplicado)

`database/financeiro-v2/producao/` (gerado por `backend/scripts/fv2/pacoteProducao.mjs`, conferido por teste):
- `instalar.sql` — uma transação; pré-condições que abortam (schema/papéis já existentes, executor superusuário ou sem
  CREATEROLE); A1–A4; 21 migrações; registro com hashes; **pós-condições que abortam** (RLS, nenhum acesso de
  anon/authenticated/service_role/authenticator, funções protegidas do guardião, guardião sem participação utilizável,
  nenhum papel com login, nada fora do schema).
- `inventario.sql` — foto sha256 do sistema atual (só leitura), antes e depois.
- `desativar.sql` — reversão não destrutiva (corta login e uso; dados e objetos ficam).

Validação no cluster que reproduz o projeto real (sonda E4): instala; foto do sistema atual **idêntica** antes/depois;
reinstalar é **recusado sem efeito**; credenciais comuns sem acesso; desativar corta o acesso e preserva tudo.

## 4. O que ainda não existe (desenvolvimento) e o que depende de pessoas

| Item | Situação |
|---|---|
| **Etapa C — rotas HTTP do v2 no backend** (sessão da plataforma → adaptador → núcleo → PostgreSQL) | **não implementado** (só a demonstração local). Próximo bloco de desenvolvimento |
| Gateway de autoridade (emite sessões de banco, provisiona, libera unidade) | código existe (07B/09/09B); **falta decidir onde roda** (A-3) |
| Verificador real de MFA | a implementar junto da Etapa C, sobre o Auth do projeto; prova com login real de quem tem TOTP |
| Cofre | sem antimalware efetivo → **upload e abertura de arquivos ficam desligados** |
| Matriz 24a | não aprovada → **homologação e reabertura ficam bloqueadas** |
| Papéis de login + senhas + variáveis no Render | ação humana (senha nunca passa por mim nem pelo Git) |
| Primeiro administrador financeiro do Açaí no Grau Saci | provisionamento com MFA real, por pessoa indicada |

## 5. Aprovações consolidadas pedidas (doc para referência; a resposta vem em palavras próprias)

- **A-1 Instalar** `instalar.sql` (sha256 no relatório) no projeto `uqybgauuxcrqzquultfu` pelo `apply_migration`
  (como `postgres`), com foto `inventario.sql` antes e depois. Resultado: **instalado mas desativado** (sem login, sem
  rotas). Pré-requisito: backup confirmado no painel.
- **A-2 Aceitar o limite de confiança D-24-1**: `postgres`, `supabase_admin` e o editor SQL do painel leem os dados do
  v2 (como já leem os da plataforma); ADMIN implícito do `postgres` no guardião.
- **A-3 Onde roda o gateway**: (a) serviço separado no Render (isolamento de processo; **custo** do plano a confirmar)
  ou (b) dentro do backend atual com credencial de banco própria (sem custo; isolamento só de credencial).
- **A-4 Credenciais (você executa)**: criar `fv2_app_login` e `fv2_autoridade_login` com senha no editor SQL e cadastrar
  as URLs no Render (instruções exatas serão entregues sem senha).
- **A-5 Pessoa** que será a primeira administradora financeira do Açaí no Grau Saci (precisa ter TOTP).
- Depois da Etapa C pronta e testada: **push, merge e deploy** (pedido separado, com commit e serviço nomeados).
