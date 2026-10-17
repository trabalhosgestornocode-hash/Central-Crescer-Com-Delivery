# Integração A7 — branch `integracao/gestao-financeira` (local, não publicada)

## Hashes integrados (exatos)
| Origem | Commit | Observação |
|---|---|---|
| base | `8d32196` (origin/main) | `main` não foi alterada |
| Agente 1 | `9ad63da` (`feat/financeiro-agente1-fundacao`) | merge `69dd7e0` |
| Agente 2 | `1f7c713` (`feat/financeiro-agente2-dominio`) | merge `10f0f81`; renome `exigirPermissao`→`autorizar` (mudança só nominal, auditada) |
| Integração | `cf5dfe5` | `gestaoFinanceiraRouter.use(dominioRouter)` + testes HTTP/estruturais |
| Integração | `cb34577` | SQL provisório do Agente 2 promovido a migration **121** (+ rollback) |
| Integração | `4aaa392` | QA visual integrado (gate e domínio reais) |
As branches originais permanecem intactas. Fora do commit do Agente 2 há arquivos não rastreados no worktree dele (`frontend/test/financeiro.browser.test.js`); **não** foram integrados.

## Contratos confirmados (v1.1)
- Envelope `{data}`; erros `{error, details:{codigo}}`; `req.financeiro = {nivel, permissoes, somenteFinanceiro, organizacaoId, unidadeId}`.
- O domínio usa `autorizarAcaoFinanceira` por rota; o gate à frente é `requireFinanceiro()` em `routes.js` (depois de `requireContexto` e `restringirPerfilExibicao`).
- Páginas: `render(container, ctx)`, `ctx = {rota, nivel, permissoes, sessao}`; as 8 páginas do Agente 2 usam `ctx.permissoes`.
- Nenhum helper com bypass de impersonação (`requirePermissao/requireModulo/requirePapel/requireAlgumaPermissao`) é usado no módulo (teste estrutural).

## Migrations (ordem)
1. **120** fundação (módulo, concessões, auditoria). 2. **121** domínio `fin_*`. Rollback inverso: 121 → 120.
Validado SÓ em PostgreSQL 17 local descartável (cluster criado para isto, com marcador): 120 e 121 aplicam, são idempotentes, aplicam em qualquer ordem entre si, rollback da 121 recusa com dados, rollback e reaplicação OK, RLS ligado, zero policies, `anon/authenticated` sem acesso, `service_role` sem DELETE, RPCs sem EXECUTE para anon/authenticated, módulo continua desabilitado. Suíte SQL do Agente 2 (`backend/testes-financeiro-pg/run.sh`) OK. Nada aplicado em banco remoto.
Revisão: o corpo da 121 é do Agente 2, inalterado; o integrador acrescentou transação, `lock_timeout` e pós-condição. **Pede revisão do Agente 2.**

## Testes (T1, ambiente fictício; sem `npm test`)
| Suíte | Resultado |
|---|---|
| Backend completo sob T1 | 5335 testes · 5306 ok · 4 falhas conhecidas · 25 pulados · **0 violações de isolamento** |
| Frontend completo | 1538 · 1527 ok · 0 falhas · 11 pulados |
| Provas do T1 | 32/32 |
| Gate real × domínio real (HTTP) | 9/9 |
| Proteção estrutural de TODAS as rotas | 5/5 (≥20 rotas reais: sem concessão → 403; leitura → só GET) |
| SQL: ciclo 120+121 e suíte do Agente 2 | OK |

**Falhas = as já classificadas (`04-classificacao-falhas-de-teste.md`), sem regressão nova:** `periodo-misto` (crash intermitente 0xC0000005 do Node; passa 40/40 isolado), Novos Clientes (pendência de negócio da Central de Performance, intocada), `selecionarPerfil` ×2 (precisa de Supabase real → T3). O conflito do identificador `exigirPermissao` **não ocorre mais**.

## QA das telas (Chrome local, gate e domínio reais, dados sintéticos): 44/44
Cobertura: 12 itens do menu (8 implementadas + 4 "Em construção"), mobile (sem rolagem horizontal), tema escuro, nível leitura (sem botões de escrita; importação informa falta de permissão), troca de unidade (recalcula setores; unidade sem dados mostra estado vazio explícito), erro de API (mensagem, sem quebrar), alternador de setor, revogação imediata, URL direta por cenário (operacional, nenhum, impersonação, exibição → 403; financeiro/ambos → 200; revogado → 403).

## Concluído × incompleto
**Concluído:** acesso (gate, concessões, setores, SuperAdmin bloqueado por flag), Visão Geral, Fluxo de Caixa, Contas Financeiras, DRE Gerencial, Indicadores, Análise de Categorias, Plano de Contas, Importação (prévia→pares→confirmação, API e tela).
**Incompleto / inexistente:** Conciliação, Períodos (fechar/reabrir: não há rotas), Relatórios, Configurações Financeiras ("Em construção", sem fingir).
**Achados para decisão:**
1. `POST /lancamentos/:id/cancelar` exige `gestao_financeira.excluir`, que **nenhum nível** concede (matriz provisória) → cancelar lançamento é inalcançável até a matriz final. Idem `reabrir`.
2. Regime de caixa explícito nas telas (DRE gerencial de caixa, não contábil) — correto, mas precisa de validação do dono do negócio.
3. A importação **não** foi exercitada com a planilha real (proibido): só com planilhas sintéticas.

## Pendências T2/T3/MFA
T3 (Supabase descartável: MFA AAL2 + 2º fator ≤10 min, RLS via REST, advisors) conforme `05-checklist-homologacao-t3-mfa.md`; T2 formal (psql) fora do T1; Node 24 não exercitado; flag `FINANCEIRO_CONCESSOES_HABILITADAS` desligada.

## Riscos residuais
Isolamento do T1 é em processo (não é sandbox de SO); `periodo-misto` pode falhar por crash do Node; migrations nunca aplicadas fora do banco descartável local; o repositório é público (nenhuma planilha/extrato rastreado — verificado); matriz de permissões ainda provisória.

## Checklist de homologação final (nada abaixo foi feito)
- [ ] Agente 2 revisa a 121 promovida e o renome; decide cancelamento/`excluir`.
- [ ] Dono do negócio valida regime de caixa e indicadores com dados reais **em ambiente descartável**.
- [ ] T3 completo (checklist 05) e aprovação escrita; só então pensar em ligar a flag.
- [ ] Aplicar 120→121 em Supabase **descartável**; rodar integração/RLS via REST.
- [ ] Smoke manual do Dashboard Operacional.
- [ ] Autorização explícita para push/PR; revisão do PR; deploy e migration em produção só com autorização separada.
