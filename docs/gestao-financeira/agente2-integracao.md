# Agente 2 — Contrato de integração (B3–B6)

Saneado: sem dados reais. Complementa `00-contrato-agente1-agente2.md` (v1). Nada aqui altera arquivos exclusivos do Agente 1.

## 1. O que o Agente 1 precisa aplicar na integração

| # | Arquivo (A1) | Mudança | Por quê |
|---|---|---|---|
| 1 | `modules/gestao-financeira/index.js` | `import { dominioRouter } from "./dominio/index.js"` e `gestaoFinanceiraRouter.use(dominioRouter)` | `dominio/index.js` já exporta `dominioRouter = criarDominioRouter({ autorizar: autorizarAcaoFinanceira })` |
| 2 | `app.js` | `app.use("/api/v1/gestao-financeira/importacoes/previa", express.json({ limit: "8mb" }))` **antes** do `express.json()` global | A prévia envia o .xlsx em base64 (até 5 MB → ~6,7 MB). Com o limite global de 1 MB, só planilhas ≲ 700 KB passam |
| 3 | `GET /gestao-financeira/status` | O roteador do front lê `(await http.get(...)).data`; o handler atual responde sem o envelope `{ data }` | Conferir na integração (as páginas do Agente 2 usam sempre `{ data }`) |
| 4 | `shared/gestaoFinanceira.permissoes.js` | A matriz `gestor` **não inclui `excluir` nem `reabrir`** | Cancelar lançamento exige `excluir` (rota `POST /lancamentos/:id/cancelar`); enquanto a matriz não for validada ninguém cancela pela UI |
| 5 | `database/migrations/` | Numerar e mover `docs/gestao-financeira/sql-provisorio/121_*.provisorio.sql` e `121_rollback.provisorio.sql` | Só depois de homologação em PostgreSQL descartável (ver §5) |
| 6 | `frontend/src/config.js` / menu | Itens `conciliacao`, `periodos`, `relatorios`, `configuracoes` seguem "Em construção" (não entregues; ver §4) | Nada a fazer: o roteador já mostra o estado honesto |

Ordem de montagem: `tenant.use("/gestao-financeira", requireFinanceiro(), gestaoFinanceiraRouter)` (já definido por A1) → o domínio herda `req.financeiro` e `req.user`.

## 2. Autorização por rota (ação mínima)

Todas as rotas passam por `autorizar(acao)` injetado (nenhuma rota existe sem gate — há teste que prova isso).

| Ação | Rotas |
|---|---|
| `ver` | todos os `GET` (plano-contas, contas, contas/:id/extrato, aberturas, lancamentos, transferencias, relatorios/*, importacoes, importacoes/:id) |
| `lancar` | `POST /lancamentos`, `POST /transferencias`, `POST /importacoes/previa`, `POST /importacoes/:id/cancelar` |
| `editar` | `PATCH /lancamentos/:id`, `GET /auditoria` |
| `conciliar` | `POST /transferencias/vincular`, `POST /transferencias/:id/desvincular`, `POST /importacoes/:id/pares`, `POST /importacoes/:id/alteracoes` |
| `configurar` | plano de contas (POST/PATCH), contas (POST/PATCH), `PUT /aberturas`, **`POST /importacoes/:id/confirmar`** |
| `excluir` | `POST /lancamentos/:id/cancelar` |
| `fechar` / `reabrir` | reservadas para B8 (períodos); ainda sem rotas |

Contexto: `organizacaoId`/`unidadeId` vêm **só** de `req.financeiro`; o autor de `req.user.id`. Corpo/query com ids de tenant são ignorados.

## 3. Contratos de API (`/api/v1/gestao-financeira`, respostas `{ data }`)

Dinheiro **sempre em centavos inteiros** (entrada aceita string pt-BR/en com até 2 casas). Datas `AAAA-MM-DD`.

- `GET /relatorios/visao-geral?de&ate` → `{ regime, periodo, vazio, indicadores{…centavos/bps…, ponteResultadoCaixa}, saldosPorConta{contas[], totalCentavos|null, parcial, conciliado:false}, aberturasDesconhecidas[], saldoFinalParcial, pendencias, alertas[], serie[], movimentoPorConta[] }`
- `GET /relatorios/dre?de&ate[&compararDe&compararAte]` → `{ regime, avisos[], parcial, linhas[{id,rotulo,tipo,centavos|bps,percentualReceitaBps,formula,detalhes[]}], comparacao }`
- `GET /relatorios/indicadores`, `/categorias`, `/integridade`
- `POST /importacoes/previa { nomeArquivo, conteudoBase64 }` → prévia (resumo, erros, lancamentos, pares, ausentes) **sem gravar**
- `POST /importacoes/:id/pares { confirmar[], rejeitar[], confirmarAltaConfianca }` · `POST /importacoes/:id/alteracoes { chaves[] }` · `POST /importacoes/:id/confirmar { confirmo:true }`
- Erros: `{ error, details:{ codigo } }` (ex.: `RECLASSIFICACAO_SEM_MOTIVO`, `PENDENCIA_SEM_JUSTIFICATIVA`, `PREVIA_COM_ERROS`, `TOTAIS_NAO_CONFEREM`, `FIN_PERIODO_FECHADO`).

## 4. Telas (contrato de montagem)

Arquivos em `frontend/src/financeiro/<pagina>.js`, cada um exporta `render(container, ctx)` (`ctx.permissoes` vem do `/status`; botões de escrita só aparecem com a permissão — o servidor decide de verdade).

| `pagina` (menu A1) | Estado |
|---|---|
| `visao-geral`, `fluxo-de-caixa`, `contas`, `dre`, `indicadores`, `categorias`, `plano-de-contas`, `importacao` | **entregues** |
| `conciliacao`, `periodos`, `relatorios`, `configuracoes` | não entregues (B7 conciliação, B8 períodos, B9 exportação) |

CSS: `financeiro-paginas.css` é carregado sob demanda pelas páginas (sem tocar `styles.css`). Tema escuro via `[data-theme="dark"]`. Cores de série validadas (claro `#2F77C4`/`#C9741A`, escuro `#4F8FD6`/`#C87A2A`).

## 5. Banco

- SQL provisório (NÃO executável pelo pipeline): `docs/gestao-financeira/sql-provisorio/121_gestao_financeira_dominio.provisorio.sql` + `121_rollback.provisorio.sql`.
- Validado em PostgreSQL 17 **temporário local** (`backend/testes-financeiro-pg/run.sh`, exige `FIN_PG_DESCARTAVEL=1`, só loopback): aplica 2×, 9 blocos de teste, rollback e reaplicação.
- RLS ligada sem policies; `revoke` de `anon`/`authenticated`/`public`; `service_role` sem `DELETE` (único DELETE: `fin_desvincular_transferencia`, `SECURITY DEFINER`).
- Pontos para a homologação com o A1: dono/privilégios de `fin_desvincular_transferencia`; permissões de `service_role` em ambiente Supabase real; coexistência com a 120.

## 6. Testes

- Backend (sem rede, sem credenciais): `node --test test/financeiro/` (cálculos, importação, serviços, rotas, ponta a ponta com repositório em memória).
- Frontend: `node --test frontend/test/financeiroModelo.test.js`; navegador real: `frontend/test/financeiro.browser.test.js` (variáveis `FIN_PLAYWRIGHT_PATH`, `FIN_BROWSER_CHANNEL`).
- PostgreSQL descartável: `backend/testes-financeiro-pg/run.sh`.
- Homologação histórica LOCAL (planilha real, fora do Git): `backend/scripts/financeiro-homologacao-local.mjs` e `financeiro-previa-local.mjs`.
