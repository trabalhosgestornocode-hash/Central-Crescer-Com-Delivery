# 24 — Fechamento final e preparação do PR (`final/financeiro` → `main`)

Data: 2026-10-19 · Executor único: Agente 2. **Sem** push, PR, merge, deploy, migration de produção ou concessão real.
**Não há homologação independente:** implementação, T3 e verificação foram feitos pelo mesmo executor.

## 1. Base
- `origin/main` = `3545968` (conferida com `git fetch` nesta data); `git merge-tree` com a branch: **limpo**.
- Branch: `final/financeiro`, 66 commits à frente da `main`, 208 arquivos, +21 828 / −20.
- Se a `main` andar antes do merge: refazer `merge-tree` e a bateria da §6.

## 2. Migrations do PR (todas novas; nenhuma existente é alterada)
| Arquivo | Papel | Rollback |
|---|---|---|
| `120_gestao_financeira_fundacao.sql` | módulo `gestao_financeira` (nasce desabilitado), concessões, auditoria, guarda em `remapear` e gatilho em `unidades` | `120_rollback.sql` (por último) |
| `121_gestao_financeira_dominio.sql` | domínio `fin_*` backend-only, RLS sem policies | `121_rollback.sql` (recusa com dados) |
| `122_conciliacao_periodos.sql` | conciliação autoritativa (M1), períodos/fechamento (F-1/F-2), D-1, O-1, F-A/F-B | `122_rollback.sql` (recusa com dados; auto-restaura a 121) |

**Promoção da 122 (nesta etapa):** o corpo é **byte a byte** o da proposta aplicada no T3 (`sha256 d2d0f2dc402cb278…`); só o cabeçalho mudou e entrou o envelope `begin` / `set local lock_timeout = '5s'` / `commit`, como na 120 e na 121. Prova local: `pg_dump --schema-only` **idêntico** (22 271 linhas) entre a provisória aplicada como no T3 (`--single-transaction`) e a promovida; catálogo 23/23 nas duas; reaplicação idempotente. Numeração: 120–122 livres na `main` (que tem 119 e 123–125); o único identificador repetido do diretório (019) é anterior e da `main`. A 122b fica em `proposta-122/` como histórico (já incorporada à 122).

**Ordem:** 115 (já em produção desde 10/10) → 120 → 121 → 122, depois das 123–125 que a produção já tem (provado nos dois sentidos).

## 3. Instruções de deploy (cada passo com autorização própria)
1. Merge do PR revisado.
2. Produção: confirmar backup/PITR → janela → aplicar como `postgres`, `-v ON_ERROR_STOP=1`: `120` → `121` → `122` (cada uma com `begin/commit` próprio; **sem** `--single-transaction`).
3. `backend/testes-seguros/t3/verificacoes_catalogo.sql` → 23 linhas `t`; `modulos` ganhou só a linha 17.
4. Deploy da aplicação com `FINANCEIRO_CONCESSOES_HABILITADAS` **ausente**. Conferir: demais módulos normais; rotas `/api/v1/gestao-financeira/*` respondem 403.
5. Piloto (outra autorização): habilitar o módulo em **uma** unidade, ligar a flag, conceder a 1–2 perfis com MFA, acompanhar uma competência.

## 4. Rollback da aplicação
Voltar ao deploy anterior no Render. O esquema financeiro fica inerte (módulo desabilitado, sem concessões, nenhuma rota de outro módulo depende dele). Acesso: desligar a flag e revogar concessões (doc 03).

## 5. Contingência do banco
- **Sem dados financeiros:** `122_rollback.sql` → `121_rollback.sql` → `120_rollback.sql` (cada um recusa se houver dados).
- **Com dados:** não há rollback de banco; reverte-se só a aplicação. Descarte de dados só supervisionado, com backup.
- Falha no meio de uma migration: a transação desfaz tudo (`lock_timeout` 5 s evita espera longa por lock); corrigir a causa e reaplicar (todas são idempotentes).

## 6. Evidências
**T3 compartilhado** (`wiqqsxnysbzhcrzrrean`, 2026-10-19; evidências fora do Git): 115 aplicada (0/9 alvos expostos); 120–122 com catálogo 23/23; D-1 44/44; adversariais 68 + 3 (cortes S6/S7 só locais); R-1 recusada pelo banco; transferência 7/7; F-1 31/31; F-3/F-4 pelo PostgREST real 10/10 (paginação > 5 000); `anon`/`authenticated` AAL2 recusados (401/403) nas tabelas financeiras e nas views da 115; MFA TOTP real: aal1 nega, TOTP errado recusado, aal2 permite, refresh após 648 s **nega**, novo TOTP permite. Encerrado: módulo desabilitado, 0 concessões, semente `[T3-FIN]` inativa, usuário sintético banido sem fator; fora da allowlist só `modulos` (+1) e `auth.users` (+1, o sintético) diferem da linha de base.

**Bateria local final (sobre `d9ff1db`):** ver §9.

## 7. Riscos residuais
1. **Sem revisão independente** de código, migrations e T3.
2. **Reuso de TOTP no Supabase Auth:** o GoTrue aceitou o mesmo código duas vezes na mesma janela de 30 s. Mitigação existente: o backend exige o carimbo do 2º fator com menos de 10 min; quem reusa precisa ter o código. Não há correção do lado da aplicação.
3. Importação/exportação provadas só localmente (não no banco compartilhado).
4. A paridade JS×SQL no compartilhado veio pela F-3 (a `parity_m1` exige `session_replication_role`).
5. Pré-existentes da `main` (fora do Financeiro): promoção de unidade quebrada (42P10); 3 testes de backend e as falhas de navegador listadas na §9.
6. Ambiente de teste: a F-3/F-4 precisa de Node ≥ 22 (o `supabase-js` 2.109 cria o cliente Realtime e exige WebSocket nativo). **Não muda com este PR:** a `main` já trava o 2.109 no `package-lock.json` e roda em produção; só o Node 20 local da máquina de testes falha (rodado com o Node 24 do `fnm`).

## 8. Alterações visuais (resumo)
- Shell: setor **Financeiro** no alternador da barra superior e menu com as 12 telas; sombra da gaveta fechada não vaza no celular; contraste do seletor de unidade ≥ 4,5:1 no escuro.
- 12 telas do Financeiro (Visão Geral, Fluxo de Caixa, Contas, DRE, Indicadores, Categorias, Plano de Contas, Importação, Conciliação, Períodos, Relatórios, Configurações) com acabamento premium, claro/escuro, celular, tabelas em cartões, gráficos SVG que redesenham ao redimensionar.
- SuperAdmin: tela **Acesso Financeiro** (concessões e auditoria) com escritas bloqueadas pela flag.
- Nenhuma tela de outro módulo foi redesenhada.

## 9. Bateria final (local, dados sintéticos, sobre a 122 promovida)
| Suíte | Resultado |
|---|---|
| Equivalência 122 provisória (modo T3) × promovida | `pg_dump -s` idêntico; catálogo 23/23 nas duas; reaplicação idempotente |
| `sim_supabase` / catálogo | 37 OK / 23/23 |
| Adversariais 122 + complemento + D-1 | 70 + 5 + 44, 0 falha |
| R-1 / corrida M1 / F-1 | divergência recusada pelo banco / exit 0 / todas OK |
| Paridade JS×SQL | 631/631 |
| Ciclo 120/121/122 / transferência de unidades | 18/18 / 73/73 |
| `testes-financeiro-pg/run.sh` (SQL, B7/B8, cancelamento, rollback em banco vazio) | todos passaram |
| Ensaio 115×120 / ensaio do `t3c` | 26 OK + 1 informativo / 40/40 |
| Backend T1 completo (executor isolado) | 5 511 testes; as únicas falhas restantes são as 3 pré-existentes da `main` (`performance-calc`, `sessao-perfil` ×2). Os manifestos 088/103, que falharam ao ver a 122 nova, foram atualizados → 194/194 nas suítes de migrations + financeiro |
| Gateway WhatsApp | 1 075 / 1 075 |
| Frontend + navegador real (iFood, Checklist, Financeiro, Parser FD, Performance) | 1 659 testes, 1 654 ok; as 5 falhas são as pré-existentes da `main` (iFood "pedidos sem Financial" ×4, Parser FD "dia único") |
| QA premium (12 telas × 5 modos) | 480/480, 0 erro de página |
| Jornada E2E (login → unidade → setor → telas; permissões por nível; importação/exportação CSV com download real) | 118/118 |
| QA integrado / F-2 / navegação / admin | 56/56 · 30/30 · 39/39 (1 erro de console = 403 esperado de cenário sem permissão) · 23/23 |

**Importação/exportação:** provadas com dados sintéticos pela jornada (envio oferecido a gestor/operador, recusado a leitura; CSV com BOM e `;`), pelo teste de navegador do Financeiro (planilha XLSX real) e pelos testes do domínio (chaves idempotentes, pendências). Não foram exercitadas no banco compartilhado.
**iFood/Checklist/WhatsApp:** testes de fumaça locais acima; nenhum teste contra serviço externo (iFood, Meta/WhatsApp) — **não comprovado** contra os serviços reais nesta etapa.

**Segurança no banco de testes (só leitura, após o T3):** catálogo 23/23; módulo desabilitado em todas as empresas e unidades; 0 concessões ativas; semente `[T3-FIN]` inativa; usuário sintético banido e sem fator; 23 usuários e 17 organizações preexistentes sem alteração; fora da allowlist só `modulos` (+1) e `auth.users` (+1) diferem da linha de base. Flag `FINANCEIRO_CONCESSOES_HABILITADAS` ausente (o código só abre com `"true"`); exceção de fechamento e reabertura sem EXECUTE para a aplicação.
