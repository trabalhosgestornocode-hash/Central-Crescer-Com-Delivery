# 16 — Homologação remota de 132–135 no Supabase de TESTE (30/10/2026)

Projeto `wiqqsxnysbzhcrzrrean` ("teste-multiempresarial", PostgreSQL 17.6, plano Pro). Produção (`uqybgauuxcrqzquultfu`) **não** foi tocada.
Execução pelo SQL Editor do painel, no navegador já autenticado, colando os arquivos pela área de transferência (sem redigitação) e
conferindo o SHA-256 do conteúdo do editor antes de cada execução. Validações por consultas só leitura entre as etapas.

## Pacotes

| Arquivo | SHA-256 | Origem |
|---|---|---|
| `EDITOR_aplicar.sql` (84.940 B) | `b22f0d01f50c86bc96d2f51ae3e6725259ffc430e4d8192c9946df19e532e6d4` | 132→135 do commit `d30a830` (PR #55), uma transação |
| `EDITOR_reverter.sql` (13.481 B) | `a119400b2cd1302a0a85dfdf314012dee047757c00ebfb962f642cb434bd8112` | 135_rollback→132_rollback, uma transação |
| `EDITOR_136_aplicar.sql` | `a226a4ae6f54c43e8ebbf175098989360261f0bb196cac14c0b21e2002edb2cf` | 136 (achado desta homologação) — **não aplicado** |
| `EDITOR_136_reverter.sql` | `b3f51e69627822a3d544fc61bcb78ba053fc0c3307f1e141fe03a65bdce8198a` | rollback da 136 — **não aplicado** |

Arquivos e `SHA256SUMS` em `evidencias/homologacao-teste/`.

## Matriz

| Etapa | Verificação | Resultado |
|---|---|---|
| Pré-voo | identidade, isolamento (projeto ≠ produção), backup (Pro), atividade de outras frentes (0 em 6 h; WhatsApp DISCONNECTED; fila 0) | OK |
| Pré-voo | impressão digital (colunas, funções+ACL, gatilhos, políticas, ACL/RLS, config, dados tocados) registrada | OK |
| 1 Aplicar | execução numa transação | OK ("Success") |
| 1 Aplicar | RLS nas 7 tabelas; anon/authenticated sem tabela e sem EXECUTE (24 funções novas); imutáveis sem UPDATE/DELETE | OK |
| 1 Aplicar | D-1 equivalente em todas as 13 unidades ativas; resolvedor, cota e transferência intactos; legados, unidades, fila e políticas intactos; M3 desligada; snapshot/escopos vazios; categorias novas inativas | OK |
| 1 Aplicar | hash do agendamento = `7b7c0a59…` | **NÃO** — `79e2e866…`: o editor (Windows) enviou CR LF; sem os `\r` o hash é exatamente `7b7c0a59…` (lógica idêntica). Corrigido nas etapas 2 e 3 forçando LF no editor |
| 1 Aplicar | PostgREST (anon, JWT): 7 tabelas → 401/`42501`; RPCs → `PGRST202`; controle → `PGRST205` | OK |
| 2 Reverter | execução numa transação (LF) | OK |
| 2 Reverter | impressão digital **idêntica** à de antes (15/15: colunas, funções+ACL, gatilhos, políticas, ACL/RLS, config, categorias, destinatário×categoria, unidades, contatos, mensagens, migrations, agendamento `f37bf6e1…` exato) | OK |
| 3 Reaplicar | execução numa transação (LF) | OK |
| 3 Reaplicar | 23 itens (os da etapa 1 + hash exato `7b7c0a59…`, nenhum `\r` em função, cota do D-1 nula, termo v1, transferência não enxerga as tabelas novas) | OK |
| 3 Reaplicar | 17 testes funcionais com dados sintéticos num bloco que termina em erro proposital (tudo desfeito): escopo de outra empresa, legado só D-1, troca de unidade, snapshot imutável (UPDATE/DELETE), CONCEDIDO sem prova, livro-razão imutável, reativar revogado, fuso inválido/válido, convite > 72 h, convite com unidade de outra empresa, authenticated lendo o livro-razão, anon executando o resolvedor, D-1 igual com destinatário sintético, M3 desligada | 17/17 OK; resíduo verificado: 0 linhas |
| 3 Reaplicar | PostgREST final (mesmos itens + 7 RPCs) | OK |

## Achado novo: escrita direta em `unidades` (corrigido na branch pela 136)

`rls_unidades_tenant` (ALL, `authenticated`, própria empresa) — **igual em produção, pré-existente** — deixa qualquer membro logado
atualizar `unidades` direto pelo PostgREST. Para as colunas da 132 (fuso/horário), que decidem a competência do fechamento após o corte,
a migration **136** recusa a escrita por `anon`/`authenticated` (backend e migrations seguem gravando). Provado no PostgreSQL descartável
(84/84). A exposição das DEMAIS colunas de `unidades` é anterior a esta frente e fica registrada para a frente responsável.

## Estado do Supabase de teste ao fim da 1ª rodada (substituído pela seção da 136 abaixo)

132–135 aplicadas (sem `\r`), 136 **não** aplicada. Seleção por unidade desligada, snapshot/escopos/convites/desafios/consentimentos vazios,
9 categorias (só `pendencia_d1` ativa), nenhuma unidade com fuso. 17 migrations registradas no histórico (a aplicação foi pelo editor,
que não registra em `schema_migrations`). Impressão digital: colunas `d34b254e…`, funções+ACL `d80ccc6b…`, gatilhos `fc079cd9…`,
ACL/RLS `fa4f73de…`; 139 tabelas, 146 funções.

## Homologação da 136 no Supabase de TESTE (30/10/2026, 2ª rodada)

Aplicada **só a 136**, sobre 132–135 já homologadas. Produção (`uqybgauuxcrqzquultfu`) não foi tocada.

**Como:** `psql -v ON_ERROR_STOP=1 -f EDITOR_136_aplicar.sql` pela conexão direta do projeto de teste (`DATABASE_TESTE_URL`), por um
invólucro que só aceita o host `db.wiqqsxnysbzhcrzrrean.supabase.co` e recusa o ref de produção. Antes de executar: SHA-256 do arquivo
`a226a4ae…` (= blob do commit `bce1875`) e **0** `\r`. Uma transação (`BEGIN … COMMIT`), 17:43:58Z.

**Pré-voo** (`backend/testes-seguros/supabase-teste/prevoo_136.sql`, sessão só leitura): PostgreSQL 17.6, nenhuma outra sessão ativa,
0 mensagens em 6 h, 136 ainda não aplicada, colunas `d34b254e…` e ACL/RLS `fa4f73de…` **idênticas** às do fim da 1ª rodada,
`validar_pos_132_135.sql` 14/14. Backup: diário do plano Pro.

### Matriz da 136

| # | Verificação | Como | Resultado |
|---|---|---|---|
| 1 | Membro logado não grava fuso/horário (UPDATE, INSERT, escondido junto com outra coluna) | SQL (SET ROLE + JWT) e **PostgREST real** | OK — `42501 unidades: fuso e horário só mudam pelo backend` (HTTP 403) |
| 1 | anon não lê nem grava `unidades` | SQL e PostgREST real (chave publicável) | OK — 0 linhas / recusado |
| 2 | Backend (service_role) grava fuso e horário | SQL e PostgREST | OK |
| 3 | Demais colunas com a permissão anterior (membro grava `nome` da própria unidade; validação da 132 recusa fuso/dia inválidos) | SQL e PostgREST | OK — 1 linha; `22023` |
| 3 | Fuso enviado sem mudança não é bloqueado | SQL e PostgREST | OK |
| 4 | Transferência de unidade (`transferir_unidade_organizacao`, service_role) | SQL (desfeito) e PostgREST (massa descartável) | OK — fuso e horário preservados; membro não executa a RPC |
| 5 | Isolamento: membro não lê nem grava unidade de outra empresa | SQL e PostgREST | OK — 0 linhas |
| 5 | Tabelas e RPCs novas de 132–135 fechadas para authenticated | PostgREST | OK |
| 6 | D-1 idêntico | `validar_pos_132_135.sql` | OK — equivalente em todas as unidades; agendamento/resolvedor/cota com o hash de referência |
| 7 | M3 desligada | idem | OK |
| 8 | Compatível com 132–135 | validação 14/14 + impressão digital | OK — só o corpo de `unidades_validar_fuso_horario` mudou: md5 `10a2368a…` = o do PostgreSQL descartável; sem `\r`; EXECUTE só do dono |
| 9 | Nenhum dado alterado | hashes antes/depois | OK — unidades (30), vínculos, mensagens (3), configurações iguais |

SQL: `funcional_136.sql` — 16 verificações num bloco que termina em erro proposital (nada fica gravado), autosselecionando uma unidade
de empresa com membro ativo e uma de outra empresa. PostgREST: `backend/test/isolamento-unidades-fuso-136-http.test.js` — 15/15, no
padrão de `isolamento-tenant.test.js` (service_role só no setup e nos 2 itens "backend"; anon com a chave publicável; membro com JWT
real de login). **Resíduo:** nenhum (empresas, unidades, usuários e perfis do teste removidos; hashes iguais), exceto 1 linha em
`plataforma_auditoria` (`unidade.transferida_entre_empresas`) — trilha append-only da transferência do teste, mantida de propósito.

Evidências em `evidencias/homologacao-teste/136-*` (pré-voo antes/depois/pós-HTTP, validação 132–135 antes/depois, saída do SQL
funcional e do PostgREST). Os resultados dos dois caminhos (SQL direto e HTTP) coincidem item a item.

### Histórico de migrations

Pela aplicação direta (editor/psql), **nenhuma** das 132–136 está em `supabase_migrations.schema_migrations` do teste (continuam 17
linhas; as últimas são 129 e 130). Correção na branch: `gerar_pacote.mjs` agora registra cada migration NA MESMA transação (formato
das já registradas: `version` = carimbo UTC, `name` = arquivo sem `.sql`, `statements` = conteúdo original) e começa recusando se
alguma já estiver registrada; o pacote de reversão remove o registro. O formato foi aceito pela tabela real do teste numa transação
desfeita (2 linhas fictícias → 0 depois do ROLLBACK). Registrar 132–136 no histórico do TESTE é passo separado, não autorizado aqui.

### Estado exato do Supabase de teste ao fim

132–136 aplicadas (sem `\r`), **não** registradas no histórico. Seleção por unidade desligada, nenhuma unidade com fuso. Impressão
digital (consulta de `prevoo_136.sql`): colunas `d34b254e…`, ACL/RLS `fa4f73de…`, políticas `a490b04c…`, funções exceto a 136
`44d40872…`; 134 tabelas (r/p), 146 funções.

## Reconciliação do histórico da 136 no teste (execuções registradas)

Duas execuções do MESMO arquivo (`EDITOR_136_aplicar.sql`, SHA-256 `a226a4ae…`), ambas só no teste:

1. **17:43:58Z — 1ª aplicação**, por `psql` (2ª rodada, seção acima; evidências `136-*`). Pré-voo dessa rodada: 136 ainda não aplicada.
2. **~20:05Z — reaplicação idempotente** pelo SQL Editor (`create or replace`, mesmo conteúdo). Antes dela a função já tinha o hash `10a2368a…`, e continuou igual depois.

Evidência cruzada: o resumo geral das funções do teste mudou entre 17:15Z (`d80ccc6b…`, 136 ausente) e 20:01Z (`9147dcf9…`), compatível com a 1ª aplicação. O evento `unidade.transferida_entre_empresas` de **17:50Z** é o teste de transferência da própria 2ª rodada (massa descartável; a linha de auditoria foi mantida de propósito). **Correção:** a seção abaixo o descreve como "atividade de outra frente" — isso estava errado; não há evidência de atividade de outra frente nessa janela. Nenhum dado de `schema_migrations` do teste foi escrito (continuam 17 linhas, 0 de 132–136).

## Execução 2 da 136 (SQL Editor) (30/10/2026, após o push de `bce1875`)

- Pré-voo: projeto `wiqqsxnysbzhcrzrrean`; D-1, resolvedor, cota, transferência e `claim` com hashes iguais aos de antes; M3 desligada; 17 migrations registradas.
  O evento `unidade.transferida_entre_empresas` de 17:50 UTC pertence à 2ª rodada (ver reconciliação acima).
- `EDITOR_136_aplicar.sql` (SHA-256 `a226a4ae…`, conferido no editor, LF, sem `\r`) executado com "Success". O hash da função de gatilho era **igual antes e depois** (`10a2368a…`):
  a 136 já estava presente (1ª aplicação às 17:43:58Z, ver reconciliação) — esta foi uma re-aplicação idempotente por `create or replace`.
- Testes funcionais (bloco desfeito): `authenticated` e `anon` recusados ao gravar fuso/horário (UPDATE e INSERT, `42501`); `authenticated` segue alterando outras colunas;
  sem mudar o valor o UPDATE passa; `service_role` grava; fuso e horário inválidos recusados (`22023`); `anon` não executa o resolvedor nem a função do gatilho; D-1 igual; M3 desligada.
- Estado final: 0 unidades com fuso, 0 resíduo, RLS de `unidades` ligada, política `rls_unidades_tenant` inalterada, legados e contatos com os mesmos hashes, PostgREST (anon) sem exposição (`postgrest-136.txt`).
- Limite: a exposição das demais colunas de `unidades` pela política existente continua (pré-existente, produção igual).

## Sequência consolidada de implantação 132–136 em PRODUÇÃO (não executada; cada passo exige autorização própria)

1. **Pré-condições:** PR #55 revisado; `main` ainda em `9da8210` (senão reconferir numeração); fila ativa do D-1 conferida; fora do horário de agendamento do D-1.
2. **Capturar a impressão digital de produção** (colunas, funções+ACL, gatilhos, políticas, ACL/RLS, config; dados: `comunicacao_destinatario_categorias`, `comunicacao_contatos_empresa`, `contatos_whatsapp`, `unidades`, mensagens). Referências já lidas: 5 hashes de funções do D-1/transferência iguais aos da main; 41 destinatários D-1; 53 unidades; migrations até 131.
3. **Aplicar 132 → 133 → 134 → 135 → 136**, preferindo `apply_migration` (registra no histórico). Se usar o SQL Editor: forçar LF (`model.setEOL(0)`), colar o arquivo do MESMO commit e conferir o SHA-256 antes de executar. Uma transação por pacote, sem as linhas begin/commit quando via `apply_migration`.
4. **Validar** (só leitura): `validar_pos_132_135.sql` (agendamento `7b7c0a59…` exato, resolvedor/cota/transferência intactos, RLS 7/7, anon/authenticated sem tabela e sem EXECUTE, D-1 equivalente em TODAS as unidades, legados e fila intocados, M3 ausente) + `validar_postgrest.mjs` com a chave pública + checagens da 136 (gatilho `10a2368a…`, anon/authenticated recusados em fuso/horário).
5. **Critério de parada:** qualquer item ≠ OK → reverter com os rollbacks na ordem 136→132 (ensaiados) e parar.
6. **Merge do PR #55** (dispara o deploy). Conferir `/health` e os arquivos novos.
7. **Variáveis (opcional):** `APP_URL_PUBLICA`, `NOTIFICACOES_SEGREDO_MESTRE`. Nunca em produção: `NOTIFICACOES_OTP_TRANSPORTE`, `NOTIFICACOES_AMBIENTE_ISOLADO`, `NOTIFICACOES_M3_ATIVACAO_HABILITADA`.
8. **24 h de observação** do D-1; depois, separadamente: SMTP + `USUARIOS_CONVITE_EMAIL`, corte do fuso, provedor oficial/termos, M3.
