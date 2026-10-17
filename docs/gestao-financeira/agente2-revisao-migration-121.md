# Revisão formal da Migration 121 (integrada) — Agente 2

**Objeto:** `database/migrations/121_gestao_financeira_dominio.sql` e `121_rollback.sql` da branch `integracao/gestao-financeira` (ponta `5ab87e5`; promoção `cb34577`), lidos por `git show` (somente leitura, sem merge). Também lida a `120_gestao_financeira_fundacao.sql` para a compatibilidade.
**Método:** (1) comparação linha a linha com o SQL provisório; (2) aplicação **dos arquivos integrados, exatamente como estão**, em PostgreSQL 17 temporário e local (`backend/testes-financeiro-pg/revisao_migration.sh`, exige `FIN_PG_DESCARTAVEL=1`, só loopback); (3) sondagens com `SET ROLE service_role/anon/authenticated`; (4) experimentos específicos (FORCE RLS, concorrência). Nada foi aplicado fora desse cluster.

## Veredito
**APROVADA COM CORREÇÕES.** A 121 integrada **não expõe dados entre organizações/unidades, não permite escalonamento de privilégio por RPC e não concede acesso a `anon`/`authenticated`** (evidências R1–R4). Há **1 defeito de integridade alcançável pela API (R5)** e **6 endurecimentos** — todos corrigidos no SQL provisório `122_conciliacao_periodos.provisorio.sql` e provados nos testes. Recomenda-se promover o 122 junto com a 121 **antes de qualquer homologação em ambiente remoto** (a 121 sozinha continua segura para o escopo atual: não há operação de fechamento nela).

## Diferença entre o integrado e o provisório
Idêntico, exceto: cabeçalho, `begin;`/`set local lock_timeout = '5s'`, pós-condição de segurança no fim e `commit;`. Rollback: mesma lógica com transação. (`diff` verificado.)

## Checklist do Agente 1 (§5 do documento 07), item a item
| Item | Resposta | Evidência |
|---|---|---|
| Transação | **OK.** Sem `create index concurrently` nem comandos proibidos em transação. | Aplicada integralmente (com seu `begin/commit`) em banco limpo. |
| `lock_timeout` 5 s | **Adequado.** Só pode estourar se `organizacoes`/`unidades` estiverem sob lock pesado ao criar as FKs; se estourar, a transação inteira desfaz (nada pela metade). Aplicar fora do horário de pico. | Leitura + aplicação. |
| Pós-condições | **De acordo** (RLS ligado, zero policies, sem acesso de `anon/authenticated`, sem DELETE no `service_role`). | R1/R2 refazem as mesmas verificações por privilégio **efetivo**. |
| `FORCE ROW LEVEL SECURITY` | **NÃO recomendado nas tabelas `fin_*` como estão.** Com FORCE e dono **sem** `BYPASSRLS`, o gatilho `fin_auditar` (`SECURITY DEFINER`) passa a ser barrado pela RLS e **toda escrita falha**. Sem FORCE funciona (auditoria gravada). Só adotar FORCE se a homologação provar que o dono das tabelas tem `BYPASSRLS` (no Supabase, o papel `postgres` tem) — e então acrescentar essa asserção à pós-condição. A proteção contra `anon/authenticated` já é total sem FORCE (RLS + zero policies + revokes). | Experimento reproduzível: dono `dono_teste` (sem bypass): sem FORCE → 1 linha de auditoria; com FORCE → insert falha em `fin_auditar()`. |
| Idempotência | **Segura, inclusive com dados.** Só `create … if not exists`, `create or replace`, `drop trigger if exists`; nenhum comando altera dados; `unique`/checks fazem parte do `create table` (pulados se a tabela existe); `on conflict` só dentro da RPC de importação. | Reaplicação com dados committados: contagens idênticas antes/depois (`12/4/3/39`). |
| Rollback | **Política correta** (recusa se houver dados). `fin_auditoria` cai junto — só é alcançável quando todas as tabelas de domínio estão vazias (o `service_role` não tem DELETE), mas **exporte a auditoria antes** em qualquer banco que tenha sido usado. **Ordem:** 122 → 121 → 120. | Rollback recusado com dados; banco vazio: 122/121 sobem, descem e reaplicam. |
| `service_role` | **Suficiente** para todas as rotas/RPCs: `select,insert,update` nas 7 tabelas e só `select` em `fin_auditoria` (a auditoria é gravada pelo gatilho `SECURITY DEFINER`, não pelo backend). Nenhuma rota precisa de `delete`; o único DELETE do domínio é a função de desvínculo. Informativo: a 120 concede `usage,select on all sequences` ao `service_role`; se reaplicada **depois** da 121, alcança `fin_auditoria_id_seq` (sem efeito sobre dados). | R2, R3a–c: DELETE/TRUNCATE e INSERT em auditoria negados como `service_role` de verdade. |
| `SECURITY DEFINER` e `search_path` | **Correto.** Só `fin_auditar` e `fin_desvincular_transferencia`, ambas com `set search_path = public, pg_temp` (`pg_temp` por último). `fin_auditar` **não é chamável** diretamente. Endurecimento opcional: qualificar nomes com schema. | R3d (chamada direta falha); R4 (desvínculo só atua no par do próprio tenant: org e unidade erradas → `false`, par intacto). |
| RPCs `SECURITY INVOKER` | **Correto**: `fin_criar_transferencia`, `fin_vincular_transferencia`, `fin_confirmar_importacao` rodam com os privilégios do `service_role` (nenhum escalonamento). `EXECUTE` só para `service_role`. | R1. |
| `p_org/p_unidade/p_usuario` nunca do cliente | **Confirmado.** Vêm de `contextoDe(req)` (`req.financeiro` + `req.user.id`); só `contexto.js` lê `req.*`; todos os `p_*` das RPCs recebem `ctx.*`; nenhuma leitura de organização/unidade em body/query/params/headers. Impostos também no banco: gatilhos conferem que conta/categoria/unidade pertencem ao mesmo tenant. | `backend/test/financeiro/escopo-estatico.test.js` (3 testes) + `dominio.test.js` (corpo malicioso ignorado). Resíduo: `p_usuario` é um UUID aceito pela função; só o backend (único com EXECUTE) o informa. |
| Funções-gatilho com EXECUTE para PUBLIC | **Inofensivo, mas revogar por higiene** (paridade com a 120). Nenhuma é chamável como RPC. | 122 revoga; sondagem 5a. |

## Compatibilidade com a 120
Sem objetos em comum (120: `gfc_*`, `gestao_financeira_concessoes*`, `modulos`; 121: `fin_*`). Ordem 120 → 121 aplicada e 121 reaplicada sobre a 120; a suíte do domínio (`10_dominio.test.sql`) passa sobre a 121 integrada. A 121 não referencia a 120 (acesso é decidido no backend).

## Achados e correções (todos no `proposta-122/122_conciliacao_periodos.provisorio.sql`)
| # | Severidade | Achado na 121 integrada | Correção / prova |
|---|---|---|---|
| R5 | **Média** (alcançável pela API) | Perna de transferência **vinculada** podia trocar de **categoria** (`PATCH /lancamentos/:id` com `categoriaId`) saindo de "transferência" e deixando o par inconsistente. Reproduzido na 121 integrada. | `fin_lancamentos_guarda` passa a recusar mudança de valor/sentido/conta/data/**categoria** em perna vinculada. Sondagem R5 passa com o 122; `25_cancelamento_par.test.sql` bloco 3c. |
| R6 | Baixa | `fin_lancamentos.importacao_id` sem FK (podia citar importação de outro tenant). | FK `fin_lancamentos_importacao_fk` (validada). |
| R7 | Baixa | Guarda de período só lê `status = 'fechado'` (sem trava): corrida com o fechamento. (Na 121 não existe fechar; passa a importar com o 122.) | `fin_periodo_travar_e_checar` (linha do período + `FOR SHARE`) e `fin_fechar_periodo` (`FOR UPDATE` + impressão digital). Concorrência real com 2 sessões em `30_concorrencia.sh`. |
| R8 | Baixa | `fin_desvincular_transferencia` (DEFINER) sem motivo e sem tratar par cancelado. | `fin_desvincular_transferencia_motivada` (motivo ≥ 10 caracteres, só par ativo, pernas ficam ativas e pendentes, motivo nas notas). O desvínculo antigo perde o EXECUTE do `service_role`. |
| R9 | Baixa | Funções-gatilho executáveis por PUBLIC. | Revogadas. |
| R10 | Baixa | Sequência da auditoria sem revoke (default privileges do Supabase podem concedê-la a `anon/authenticated`). | `revoke` explícito (sondagem 5b). **Verificar no Supabase de homologação.** |

## Itens que dependem de decisão/ambiente (não resolvíveis aqui)
1. Verificar no Supabase **real e descartável** (BL-02/BL-04): `service_role` com `BYPASSRLS`; dono das tabelas/funções (privilégios para `fin_desvincular_*`, `fin_auditar`); default privileges de sequências.
2. Decidir sobre FORCE RLS conforme a evidência acima.
3. Promover o 122 (numeração a critério do Agente 1) **depois** de revisão equivalente a esta.
