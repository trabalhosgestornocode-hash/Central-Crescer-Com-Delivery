# 19 — Diagnóstico SOMENTE LEITURA do Supabase de testes existente (T3 adaptado)

Data: 2026-10-19 · Decisão do usuário: usar o projeto de testes **existente** (não criar projeto descartável). Autorizado **somente leitura**. Nada foi escrito: só `GET`/`HEAD` na API REST com a configuração já existente; nenhuma credencial exibida. **Sem migrations, inserts, updates, deletes, resets, rollbacks, push, PR, merge ou deploy.**

## 1. Identidade confirmada
| Evidência | Valor |
|---|---|
| Origem da configuração | `backend/.env.test-integracao` (a mesma de `npm run dev:teste`, `test:integracao` e dos scripts iFood de homologação) — lida só em memória; chaves não exibidas |
| Ref do projeto | **`wiqqsxnysbzhcrzrrean`** ("teste-multiempresarial") |
| Produção | `uqybgauuxcrqzquultfu` — **diferente**; o script aborta se o ref for o de produção ou qualquer outro que não o de teste |
| Coerência | o mesmo ref aparece em `.env.test` e `.env.test-http` (`TEST_SUPABASE_URL`), na constante `PROJETO_TESTE_REF` (`backend/src/modules/ifood/ifood.ambienteTeste.js`) e em `docs/ifood-homologacao-ambiente.md` |
| Respostas | PostgREST 14.5 (OpenAPI 200); Auth `/settings` 200 (só e-mail como provedor; cadastro **aberto**; autoconfirmação desligada) |
| Limitação | **não há conexão SQL direta configurada** (nenhum `DATABASE_TESTE_URL`): catálogo de privilégios, policies, donos, `pg_proc` e a tabela de migrations **não puderam ser lidos** |

## 2. Estrutura e migrations (inferidas pelos objetos expostos)
- 114 tabelas e 63 RPCs expostas; 49 tabelas com dados. Volumes: `plataforma_auditoria` 27 010, `parser_fd_auditoria` 72, `contatos_whatsapp` 50, `ifood_eventos` 47, `organizacoes` 17, `unidades` 14 (1 com `eh_teste = true`), `perfis` 19, `ifood_pedidos` 10, `ifood_credenciais` 3, `ifood_conexoes` 1.
- **Financeiro ausente**: nenhum objeto `fin_*`, `gestao_financeira_*` ou `gfc_*`.
- Catálogo `modulos`: 16 módulos (ordens 1–16). **Sem** `checklist_operacional` (ordem 18) e sem `gestao_financeira` (17).
- **Drift em relação à `main`** (por presença de tabelas/colunas): aplicadas 060–068, 079, 080, 082–090, 096–104, 106, 108; **não aplicadas** 072–076, 078, 081, 105, 109, 110, 116, 117, 118, **123** (sem a linha do Checklist no catálogo), **124** (sem `finalidade/ambiente` em `ifood_conexoes`); várias outras (062, 063, 065, 071, 077, 092–095, 107, 112–115, 119, 125) não deixam sinal visível pela API — só o SQL confirma. O banco de testes **não espelha** a produção.

## 3. Dependências dos demais módulos nesse banco
- Backend de desenvolvimento contra o teste (`npm run dev:teste`) e os scripts de homologação iFood (`dev:ifood-homolog`, `dev:ifood-centralized-test`, `ifood:*-e2e`, `worker:ifood:centralized-test`).
- Suítes de integração/isolamento (`test:integracao`, `test:isolation*`, `test:estrutura`, `test:exclusao-empresa`, `isolamento-configuracoes-http`, `sessao-heranca-integracao`, `realtime-migration-080-e2e`, `criar-empresa-heranca-modulos`).
- Dados vivos de iFood (eventos, pedidos, credenciais, sessões OAuth, lease do poller), WhatsApp/comunicação, bonificação, parser FD, auditoria da plataforma.
- RPC `rls_auto_enable` existe no projeto e **não está nas migrations do repositório** (provável recurso do painel que liga RLS em tabelas novas) — precisa de leitura SQL.

## 4. Compatibilidade das 120, 121 e 122 com este banco
- Tabelas-base exigidas existem com as colunas usadas (`organizacoes`, `unidades`, `modulos`, `organizacao_modulos`, `unidade_modulos`, `perfis_operacionais`, `usuarios_organizacoes`, `usuarios_unidades`).
- Fora do próprio namespace, as três só fazem: **(a)** recriar a CHECK de `modulos.categoria` acrescentando `financeiro` (mudança **compartilhada**, aditiva, com lock curto) e **(b)** inserir a linha `gestao_financeira` (ordem 17) no catálogo — o módulo nasce **desabilitado**; **(c)** usam a função compartilhada `set_updated_at` (só leitura; existência não verificável sem SQL).
- **ACHADO BLOQUEANTE (vale também para produção):** a função compartilhada `remapear_organizacao_em_tabelas_de_unidade` (054, *invoker*, chamada por `transferir_unidade_organizacao` e `promover_unidade_para_empresa`) percorre **todas** as tabelas do `public` que têm `organizacao_id` e `unidade_id` e faz `UPDATE` em cada uma. Depois das 120–122 ela passa a incluir as tabelas financeiras; o `service_role` **não tem** `UPDATE` em `fin_auditoria` (por desenho), e o PostgreSQL checa o privilégio mesmo quando nenhuma linha é afetada. **Reproduzido no PostgreSQL local**: com as migrations financeiras, `remapear…` como `service_role` falha com `permission denied for table fin_auditoria` para uma unidade **sem** dado financeiro; sem as migrations, a mesma chamada retorna `{}`. Consequência: **transferir ou promover qualquer unidade quebraria** (no banco de testes, quebraria `test:estrutura`; em produção, a Estrutura Organizacional). Mesmo com privilégio, uma unidade com dados financeiros falharia nos gatilhos de imutabilidade. **Correção exige decisão** (altera função compartilhada e a regra de negócio): (i) excluir `fin_*`/`gestao_financeira_*` da varredura e **recusar** mover unidade com histórico financeiro (recomendado: o histórico financeiro não troca de empresa), ou (ii) definir uma rotina financeira própria de transferência.
- `excluir_organizacao_definitivamente` (055) apaga a organização: com dados financeiros, as FKs `ON DELETE RESTRICT` das `fin_*` impedem a exclusão (comportamento seguro, mas muda o resultado da função para empresas com financeiro).

## 5. Riscos de executar 120, 121 e 122 neste banco
1. **Quebra da transferência/promoção de unidades** (achado acima) — afeta outras frentes que testam Estrutura Organizacional. **Bloqueante sem a correção.**
2. Mudança compartilhada em `modulos` (CHECK + 1 linha visível no catálogo do SuperAdmin de teste).
3. Irreversibilidade prática: os rollbacks da 121/122 **recusam** quando há dados financeiros; o `service_role` não apaga linhas financeiras (por desenho) ⇒ depois de qualquer teste com dados, o esquema financeiro fica no banco de testes, salvo limpeza supervisionada pelo dono do banco.
4. O banco não espelha a produção (drift) ⇒ o T3 aqui prova o Financeiro, **não** a sequência de migrations da produção.
5. Papéis reais (dono das tabelas, `service_role`, `authenticator` com `safeupdate`) diferem do simulado — é justamente o que se quer provar, mas precisa de SQL de leitura.

## 6. Testes executáveis só em leitura (Grupo A)
- **Já feitos via REST:** identidade; ausência do Financeiro; catálogo de módulos; colunas das tabelas-base; volumes; drift de migrations por objeto; configurações de Auth.
- **Exigem conexão SQL de leitura (sessão `default_transaction_read_only=on`):** `supabase_migrations.schema_migrations`; donos, `SECURITY DEFINER`/`search_path`, privilégios efetivos de `anon/authenticated/service_role` e `authenticator`; policies; `set_updated_at`; definição de `rls_auto_enable`/gatilhos de evento; `pg_default_acl`; versão do Postgres.

## 7. Testes que exigem escrita isolada (Grupo B — só com autorização específica e depois do isolamento)
Aplicar 120 → 121 → 122; catálogo `verificacoes_catalogo.sql` (leitura, mas depende das migrations); semente sintética; F-3/F-4 (`f3_f4_e2e.mjs`), paridade (`parity_m1.mjs`), adversariais S0–S12, F-1 concorrência, fechamento/M1, auditoria; PostgREST/anon com os objetos novos; criação do **usuário de teste com TOTP** (MFA AAL2 + `amr_probe.mjs`). Os scripts atuais têm uma trava que **recusa** este banco (há 16 organizações fora do padrão de teste): por desenho, eles não rodam aqui sem uma adaptação explícita para "banco compartilhado" (allowlist de ids sintéticos).

## 8. Proibidos neste ambiente (Grupo C)
Rollback da 120 (mexe em `modulos`, compartilhado) e rollbacks com dados; qualquer limpeza global/`truncate`/reset; `desempenho_m1.sql` com 300 mil linhas e uso de `session_replication_role = replica` em massa; alterar privilégios/default privileges/RLS compartilhados; tocar organizações, unidades, perfis, conexões ou credenciais iFood existentes; habilitar o módulo financeiro para empresas reais de teste; ligar `FINANCEIRO_CONCESSOES_HABILITADAS`; exceção de fechamento.

## 9. Estratégia de isolamento recomendada
- **Schema separado: não recomendado** — o código usa o `public` via PostgREST; mudar exigiria alterar a aplicação.
- **Isolamento por namespace (viável):** todos os objetos financeiros são `fin_*`/`gestao_financeira_*`; fora disso só a CHECK/linha de `modulos` e — **depois de corrigida** — a varredura genérica de `remapear…`.
- **Dados:** uma organização e duas unidades **sintéticas exclusivas** (ids de um prefixo próprio, nome `[T3-FIN] …`), nenhum vínculo com usuários existentes, nada habilitado fora delas; nenhum DELETE/limpeza global.
- **Reversibilidade:** só antes de gravar dados (rollback 122 → 121; a 120 **não** volta, por tocar `modulos`). Depois dos testes, o esquema financeiro **permanece** no banco de testes (inerte) — precisa ser aceito explicitamente, ou planejar limpeza supervisionada das linhas sintéticas pelo dono antes do rollback.
- **Trava dos scripts:** trocar a regra "nenhuma organização real" por uma allowlist das organizações sintéticas `[T3-FIN]` e recusar qualquer escrita fora delas (mudança pequena nos scripts, a fazer antes do Grupo B).
- **MFA:** criar **um** usuário exclusivo de teste (e-mail descartável), sem vínculo com contas existentes; cadastrar TOTP pelo próprio Supabase Auth; usar `amr_probe.mjs` com o JWT em variável de ambiente; não alterar nenhuma conta existente; flag de concessões continua desligada.

## 10. Autorizações necessárias para continuar
1. **Decidir a correção do achado de `remapear_organizacao_em_tabelas_de_unidade`** (bloqueante para aplicar 120–122 em qualquer banco compartilhado e para produção).
2. Fornecer, por variável de ambiente, uma **conexão SQL de leitura** ao banco de testes (ex.: `DATABASE_TESTE_URL`) para completar o Grupo A (catálogo, policies, migrations aplicadas).
3. Aceitar que o esquema financeiro e os dados sintéticos **permanecerão** no banco de testes após o T3 (ou autorizar limpeza supervisionada).
4. Autorizar, em etapas: adaptação das travas para "banco compartilhado"; aplicação das 120 → 121 → 122; semente sintética; criação do usuário de teste com TOTP.
5. Confirmar uma janela sem outros testes rodando no banco (a CHECK de `modulos` toma lock curto; as suítes de outras frentes não devem rodar durante a aplicação).
