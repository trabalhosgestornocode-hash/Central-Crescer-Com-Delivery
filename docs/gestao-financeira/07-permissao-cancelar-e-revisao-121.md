# A7.1 — Permissão `gestao_financeira.cancelar` e revisão solicitada da migration 121

## 1. Decisão e matriz (vigente na branch `integracao/gestao-financeira`)
`gestao_financeira.cancelar` é independente de `gestao_financeira.excluir`. Cancelar = transição lógica de status, com motivo, auditada, que não apaga nada.

| Permissão | Leitura | Operador | Gestor |
|---|:-:|:-:|:-:|
| `gestao_financeira.ver` | ✔ | ✔ | ✔ |
| `gestao_financeira.lancar` | | ✔ | ✔ |
| `gestao_financeira.editar` | | ✔ | ✔ |
| `gestao_financeira.conciliar` | | | ✔ |
| `gestao_financeira.cancelar` | | | ✔ |
| `gestao_financeira.configurar` | | | ✔ |
| `gestao_financeira.fechar` | | | ✔ (rotas de fechamento ainda não existem) |
| `gestao_financeira.reabrir` | | | **nenhum nível** (aguarda homologação específica) |
| `gestao_financeira.excluir` | | | **nenhum nível** (não há exclusão física) |

Fonte única: `backend/src/shared/gestaoFinanceira.permissoes.js`. **Não** foi adicionada ao `PERMISSOES` operacional (que `organization_admin` herda). **Migration 120: nenhuma alteração** — `nivel` só guarda `leitura|operador|gestor`; as permissões de cada nível são derivadas no código, então não há catálogo em SQL. A 121 também não foi alterada.

## 2. Alterações mínimas em arquivos do Agente 2 (a ADOTAR na branch dele; só o NOME da permissão exigida)
| Arquivo | Mudança |
|---|---|
| `backend/src/modules/gestao-financeira/dominio/contexto.js` | `ACAO.CANCELAR = "gestao_financeira.cancelar"` |
| `.../dominio/rotas.js` | `POST /lancamentos/:id/cancelar` passa de `ACAO.EXCLUIR` para `ACAO.CANCELAR` |
| `backend/test/financeiro/dominio.test.js` | a asserção da rota espera `gestao_financeira.cancelar` |
| `backend/test/financeiro/fluxoCompleto.test.js` | lista de permissões do teste: `cancelar` no lugar de `excluir` |
| `frontend/src/financeiro/modelo.js` | `ACAO.CANCELAR` |
| `frontend/src/financeiro/fluxo-de-caixa.js` | o botão "Cancelar" depende de `ACAO.CANCELAR` |
O serviço (`cancelarLancamento`) **não foi reescrito**. Se o Agente 2 aplicar o mesmo texto na branch dele, o merge fica sem conflito.

## 3. Comportamento comprovado
**HTTP (gate + domínio reais, repositório em memória; `test/gestao-financeira-cancelamento.test.js`, 19 testes):** leitura e operador → 403 `FINANCEIRO_PERMISSAO_INSUFICIENTE` (lançamento intacto); gestor + motivo → `cancelado`, motivo registrado, auditoria antes/depois, nada excluído; sem motivo (ausente/vazio/espaços) → 400; período fechado → recusado; impersonação → 403; sem concessão → 403; revogada entre duas chamadas → a segunda é negada; concessão de outra empresa/unidade → 403; id de outra unidade/empresa → não encontrado; cancelar duas vezes é idempotente (sem auditoria duplicada); nenhuma rota DELETE existe; nenhum nível concede `excluir`/`reabrir`.
**Banco real (PostgreSQL 17 local descartável, migrations 120+121):** cancelamento em mês aberto grava `fin_auditoria` com `antes=realizado`/`depois=cancelado` e o ator; em **mês fechado** o banco recusa (`fin_periodo_fechado`); em **perna de transferência vinculada** o banco recusa (`fin_transferencia_vinculada`) e as duas pernas permanecem `realizado`; `service_role` não tem DELETE; `anon`/`authenticated` sem acesso; nenhuma linha foi excluída.

## 4. Dependências do Agente 2
1. **Cancelamento atômico de transferência pareada: NÃO implementado.** Hoje o banco só permite cancelar uma perna depois de `desvincular` (exige `conciliar`, que o gestor tem) — dois passos, cada um atômico, mas não "as duas pernas juntas". Pede-se uma RPC (ex.: `fin_cancelar_transferencia`) que desvincule e cancele as duas pernas na mesma transação, com motivo e auditoria, exigindo `cancelar`. Sem isso o cancelamento de transferência fica deliberadamente manual.
2. Adotar os renomes da seção 2.
3. Decidir a mensagem de erro amigável para `fin_periodo_fechado` / `fin_transferencia_vinculada` na tela (hoje é erro genérico da API).
4. Fechar/reabrir período (rotas) — pendentes; `fechar` está na matriz do gestor, `reabrir` fora.

## 5. SOLICITAÇÃO DE REVISÃO — Migration 121 — **STATUS: PENDENTE. NÃO APROVADA.**
Não há sessão do Agente 2 acessível neste momento (verificado), então o pedido segue por este documento. **A ausência de resposta não conta como aprovação.**
O que o integrador alterou (corpo do SQL do Agente 2 permanece igual): `begin;`/`commit;`, `set local lock_timeout = '5s'`, cabeçalho, pós-condição de segurança no final, e a mesma transação no rollback. Arquivos: `database/migrations/121_gestao_financeira_dominio.sql`, `121_rollback.sql`.

Peço ao Agente 2 que revise e responda item a item:
- [ ] **Transação**: o corpo é seguro dentro de uma única transação (não há `create index concurrently` nem comandos proibidos em transação)?
- [ ] **`lock_timeout`**: 5 s é adequado para tabelas novas (e para um banco já existente com `organizacoes`/`unidades`)?
- [ ] **Pós-condições**: concordam com RLS ligado, zero policies, sem acesso de `anon/authenticated`, sem DELETE no `service_role` — e o `force row level security` (a 120 usa; a 121 não) é desejado ou não?
- [ ] **Idempotência**: reaplicar a 121 é seguro (testado aqui: sim, em banco vazio)? Há risco com dados existentes (ex.: `unique` novos, `on conflict`)?
- [ ] **Rollback**: recusar quando há dados em qualquer tabela é a política certa? A trilha `fin_auditoria` é descartada junto — exportar antes?
- [ ] **`service_role`**: `select,insert,update` em 7 tabelas e só `select` em `fin_auditoria` bastam para todas as rotas/RPCs? Alguma rota precisa de `delete` por outro caminho?
- [ ] **Funções SQL**: `fin_auditar` e `fin_desvincular_transferencia` são `SECURITY DEFINER` com `search_path` fixo — o dono é quem aplica a migration (precisa de INSERT em `fin_auditoria` e DELETE em `fin_transferencias`); as demais RPCs são `SECURITY INVOKER`, executadas pelo `service_role`. Está correto? As RPCs confiam em `p_org/p_unidade/p_usuario` vindos do backend — confirmar que o backend NUNCA os repassa do cliente (hoje vêm de `contextoDe(req)`).
- [ ] **Funções-gatilho** (`fin_*` que retornam `trigger`) ficam com EXECUTE para PUBLIC: aceitável por não serem chamáveis como RPC, ou revogar por higiene?
Observação preliminar do integrador (NÃO é aprovação): nada no ciclo local falhou; o que falta é o olhar do dono do domínio e o T3.

## 6. Riscos residuais
Cancelamento de transferência pareada não atômico (item 4.1); mensagens de erro genéricas na tela; matriz ainda de "primeira versão"; `fechar` concedido ao gestor sem rotas que o usem; tudo validado só em banco local descartável e em memória; flag de concessões desligada; nada aplicado em produção.
