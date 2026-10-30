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

## Estado exato do Supabase de teste ao fim

132–135 aplicadas (sem `\r`), 136 **não** aplicada. Seleção por unidade desligada, snapshot/escopos/convites/desafios/consentimentos vazios,
9 categorias (só `pendencia_d1` ativa), nenhuma unidade com fuso. 17 migrations registradas no histórico (a aplicação foi pelo editor,
que não registra em `schema_migrations`). Impressão digital: colunas `d34b254e…`, funções+ACL `d80ccc6b…`, gatilhos `fc079cd9…`,
ACL/RLS `fa4f73de…`; 139 tabelas, 146 funções.
