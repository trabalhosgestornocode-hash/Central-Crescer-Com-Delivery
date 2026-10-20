# 16 — Matriz dos conflitos com a `main` (ensaio, SEM merge na branch financeira)

Data: 2026-10-18 · `origin/main` @ `3545968` (PR #48, iFood multi-conexão; antes: PR #47, Checklist universal) · `integracao/gestao-financeira` @ `1d7bcfc` (+ checkpoint). Divergência: **50 commits à frente, 9 atrás** (base comum: `8d32196`; a main alterou 81 arquivos).
**Nada foi incorporado à branch financeira.** O ensaio foi feito (a) com `git merge-tree --write-tree` (não toca em nada) e (b) numa **worktree descartável** (fora do repositório, removida ao final), com os 4 conflitos resolvidos conforme a coluna "Resolução" e a suíte completa executada.

## 1. Migrations (verificado em `origin/main`)
Ocupadas na main: 110, 112–119, **123** (Checklist Operacional, ordem de módulo 18), **124** e **125** (iFood: finalidade por conexão e remoção do índice "uma conexão por unidade"). **120, 121 e 122 estão livres** (a própria main registra nos comentários dos testes: *"a trilha financeira ocupa 120–122 (ainda não integrada à main)"*). Sem colisão de número. As do Financeiro entram "fora de ordem" (abaixo de 123–125 já existentes): seguro porque nenhuma 123–125 toca `fin_*`/`gestao_financeira_*`; a 123 insere módulo com categoria `operacao` (válida antes e depois da 120, que só **amplia** a constraint para incluir `financeiro`). **Confirmar no T3** (doc 14, 3.A.5) e com quem faz o deploy se as migrations são controladas por nome.

## 2. Matriz dos 4 conflitos de conteúdo
| # | Arquivo | Mudança da `main` | Mudança financeira | Resolução recomendada | Testes que comprovam |
|---|---|---|---|---|---|
| 1 | `backend/src/routes.js` | (a) importa `requireAlgumModulo`; (b) a rota `/checklist-operacional` passa a `requireAlgumModulo(MODULOS.CHECKLIST_OPERACIONAL, MODULOS.IFOOD)` (transição da sessão de até 8 h) | importa `requireFinanceiro` e `gestaoFinanceiraRouter`; registra `tenant.use("/gestao-financeira", requireFinanceiro(), gestaoFinanceiraRouter)` com o aviso de **não** usar `requireModulo/requirePermissao` (bypass de impersonação) | **União**: import = `{ requireContexto, exigirSenhaDefinitiva, requireModulo, requireAlgumModulo }` + os dois imports financeiros; manter o bloco do Checklist **da main** e acrescentar o bloco do Dashboard Financeiro logo depois (nada do bloco financeiro usa `requireAlgumModulo`) | `gestao-financeira-rotas-protegidas.test.js` (matriz de rotas), `gestao-financeira-gate.test.js`, `gestao-financeira-a8-integrado.test.js` (gate real), testes de Checklist da main (`checklist-operacional-*.test.js`), `comunicacao-arquitetura-agendamento.test.js` |
| 2 | `backend/src/shared/modulos.js` | adiciona `CHECKLIST_OPERACIONAL: "checklist_operacional"` e a entrada `{ categoria: "operacao", ordem: 18 }` | adiciona `GESTAO_FINANCEIRA: "gestao_financeira"` e a entrada `{ categoria: "financeiro", ordem: 17 }` (categoria nova autorizada pela 120) | **União** das duas constantes e das duas entradas (Financeiro 17, Checklist 18 — a main já reservou a 17 para o Financeiro) | `backend/test/modulos.test.js`, `criar-empresa-heranca-modulos.test.js`; no banco: `verificacoes_catalogo.sql` nº 21 (categoria `financeiro` aceita; ordem 17 só do Financeiro; 18 do Checklist) |
| 3 | `backend/test/comunicacao-arquitetura-agendamento.test.js` | lista de migrations permitidas + `123_*`, `123_rollback`, `124_*`, `124_rollback`, `125_*`, `125_rollback` | lista permitida + `120_*`, `120_rollback`, `121_*`, `121_rollback` (a 122 **não** entra enquanto não for promovida) | **União** das listas (120, 121 e 123–125); quando a 122 for promovida, acrescentá-la em commit próprio | o próprio teste (guarda de migrations da mensageria) |
| 4 | `backend/test/ifood-migration-103.test.js` | idem (lista de migrations permitidas com 123–125) | idem (120–121) | **União**, como o nº 3 | o próprio teste |

## 3. Arquivos que a main e a integração alteraram e o Git juntou sozinho (conferidos)
| Arquivo | Main | Financeira | Risco | Conferência |
|---|---|---|---|---|
| `backend/src/middlewares/auth.js` | `requireAlgumModulo` (+12/−2) | `mfaEm`/`carimboDeSegundoFator` no usuário (+6/−3) | baixo (regiões distintas) | `gestao-financeira-gate`/`-concessoes`; T1 completo |
| `frontend/src/app.js` | 1 linha | integração do alternador de setor e do menu financeiro (+121) | médio (arquivo central) | testes de frontend, navegador real, QA visual |
| `frontend/src/config.js` | rotas/flags do Checklist (4 linhas) | +2 linhas | baixo | idem |
| `frontend/src/router.js` | `moduloTransicao` (1 linha) | rotas `fin-*` (+16/−3) | médio | idem; `financeiro.browser.test.js` |

## 4. Resultado do ensaio (worktree descartável, merge de `origin/main` + 4 resoluções acima)
| Suíte | Resultado |
|---|---|
| Backend T1 completo (`executar.mjs`, ambiente fictício) | **5 485 testes · 5 455 ok · 3 falhas conhecidas** (Novos Clientes; `selecionarPerfil` ×2) · 25 pulados · 0 violações de isolamento |
| Domínio + HTTP integrado (`test/financeiro` + `test/gestao-financeira-*`) | **235/235** |
| Frontend (`frontend/test`) | **1 553 ok** · 0 falhas · 11 pulados (navegador) — 23 testes a mais que a integração (vêm da main) |
| Navegador real (`financeiro.browser.test.js`) | **17/17** |
| QA visual integrado (Chrome real) | **56/56** |
| QA da F-2 (desktop, celular, escuro; 409 real) | **30/30** |
Observação de ambiente: 2 arquivos (`whatsapp-retry-allowlist.test.js`, `whatsapp-retry-cache-routes.test.js`) falharam **só** por `Cannot find package 'baileys'` — a worktree nova não tinha `gateway-whatsapp/node_modules` (artefato do ensaio, não do merge); com a dependência ligada, **28/28**. Os `node_modules` foram ligados por junction (removida antes de apagar a worktree).

## 5. Procedimento recomendado para o merge real (em checkpoint próprio, com autorização)
1. Congelar o escopo; `git fetch`; conferir de novo os números de migration em `origin/main` (outra frente pode ter tomado 120–122).
2. `git merge --no-ff origin/main` na `integracao/gestao-financeira`; resolver os 4 conflitos como na matriz (união; nada de descartar lado nenhum).
3. Rodar T1 completo, domínio+HTTP, frontend, navegador real e QA visual (tabela do §4); rodar `verificacoes_catalogo.sql` e `f1_concorrencia.sh` no PG descartável.
4. Só então abrir PR (autorização à parte). **Não** aplicar nenhuma migration no merge; a 122 continua em `proposta-122/` até o T3 e a revisão independente.
5. Ordem de entrada na produção: aplicar 120 → 121 → 122 (após T3) em janela própria, módulo `gestao_financeira` **desabilitado**; nada de concessões.
