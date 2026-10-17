# Agente 2 — Contrato de integração (B3–B8)

Saneado: sem dados reais. Complementa `00-contrato-agente1-agente2.md`. Nada aqui altera arquivos exclusivos do Agente 1. Revisão formal da 121: `agente2-revisao-migration-121.md`.

## 1. O que o Agente 1 precisa aplicar na integração

| # | Arquivo (A1) | Mudança | Por quê |
|---|---|---|---|
| 1 | `modules/gestao-financeira/index.js` | `gestaoFinanceiraRouter.use(dominioRouter)` (já feito na integração) | `dominio/index.js` exporta `dominioRouter = criarDominioRouter({ autorizar: autorizarAcaoFinanceira })` |
| 2 | `app.js` | `app.use("/api/v1/gestao-financeira/importacoes/previa", express.json({ limit: "8mb" }))` e o equivalente para `/conciliacao/referencias/importar` (2 MB) **antes** do `express.json()` global | Os arquivos vão em base64; com o limite global de 1 MB só passam arquivos ≲ 700 KB |
| 3 | `GET /gestao-financeira/status` | O roteador do front lê `(await http.get(...)).data`; conferir se o handler devolve `{ data }` | As páginas do Agente 2 usam sempre `{ data }` |
| 4 | `shared/gestaoFinanceira.permissoes.js` | Já sincronizado com a matriz A7.1 (`cancelar`; `reabrir`/`excluir` sem nível). **Acrescentar nada**: as rotas novas usam só `ver, lancar, editar, conciliar, cancelar, fechar, reabrir, configurar` | LD-003 (`25412eb`) |
| 5 | `database/migrations/` | **Nova migration (sugestão 122)** a partir de `sql-provisorio/122_conciliacao_periodos.provisorio.sql` + rollback, **depois de revisão equivalente à da 121**. A 121 integrada continua válida | Ver §5. **O backend de B7/B8 e o frontend dependem do 122** (colunas `revisao_motivos`, `canal_referencia`, `versao`, `status` do par; tabelas e funções novas) |
| 6 | `frontend/src/financeiro/*` | Páginas novas: `conciliacao.js`, `periodos.js` (menu A1 já tem os itens `fin-conciliacao`, `fin-periodos`) | §4 |
| 7 | Reabertura | **Nada a habilitar agora.** O serviço recusa (`REABERTURA_NAO_HABILITADA`) mesmo que algum nível receba `reabrir`, até alguém passar `deps.reaberturaHabilitada = true` na montagem (decisão de política, BL-05) | Fail-closed |

Ordem de montagem: `tenant.use("/gestao-financeira", requireFinanceiro(), gestaoFinanceiraRouter)` → o domínio herda `req.financeiro` e `req.user`.

## 2. Autorização por rota (ação mínima)

Todas as rotas passam por `autorizar(acao)` injetado (nenhuma rota existe sem gate — teste prova). Não há permissões próprias do Agente 2.

| Ação | Rotas |
|---|---|
| `ver` | todos os `GET` (plano-contas, contas, extrato, aberturas, lancamentos, transferencias, relatorios/*, importacoes, `conciliacao/resumo|pendencias|referencias|excecoes-sangria`, `periodos`, `periodos/politica`, `periodos/:mes/pre-fechamento`) |
| `lancar` | `POST /lancamentos`, `POST /transferencias`, `POST /importacoes/previa`, `POST /importacoes/:id/cancelar` |
| `editar` | `PATCH /lancamentos/:id`, `GET /auditoria` |
| `conciliar` | `POST /transferencias/vincular`, `POST /transferencias/:id/desvincular` (**motivo obrigatório**), `POST /importacoes/:id/pares|alteracoes`, `POST /conciliacao/referencias`, `…/referencias/importar`, `…/referencias/:id/cancelar`, `POST /conciliacao/resolucoes`, `…/resolucoes/:id/revogar`, `POST /conciliacao/pendencias/:id/resolver` |
| `cancelar` | `POST /lancamentos/:id/cancelar` (lançamento isolado), **`POST /transferencias/:id/cancelar`** (par inteiro) |
| `configurar` | plano de contas, contas (inclui canal), `PUT /aberturas`, `POST /importacoes/:id/confirmar`, `POST /conciliacao/excecoes-sangria` (+`/:id/desativar`), `PUT /periodos/politica` |
| `fechar` | `POST /periodos/abrir`, `POST /periodos/:mes/fechar` |
| `reabrir` | `POST /periodos/:mes/reabrir` — nenhum nível a concede **e** o serviço está desativado por padrão |

Contexto: `organizacaoId`/`unidadeId` vêm **só** de `req.financeiro`; o autor de `req.user.id` (guarda estática: `test/financeiro/escopo-estatico.test.js`).

## 3. Contratos de API (`/api/v1/gestao-financeira`, respostas `{ data }`; erros `{ error, details:{ codigo } }`)

Dinheiro **sempre em centavos inteiros** (entrada aceita string pt-BR/en, até 2 casas). Datas `AAAA-MM-DD`. Mensagens (`error`) são **amigáveis e sem detalhes internos**; `details.codigo` é identificador estável.

**Transferências — três operações, três regras (nada é excluído):**
- Cancelar lançamento isolado: perna **vinculada** é recusada (`FIN_TRANSFERENCIA_VINCULADA`); perna **sem par** exige `confirmoPernaIsolada: true`.
- `POST /transferencias/:id/desvincular { motivo≥10 }`: pareamento incorreto; as duas pernas seguem **ativas** e voltam a pendentes; não cancela nada; par cancelado não desvincula.
- `POST /transferencias/:id/cancelar { motivo≥10 }`: par + duas pernas na mesma transação (ou nada); mês fechado de **qualquer** perna recusa tudo; idempotente (`jaCancelada: true`); auditoria antes/depois.

**Conciliação (B7)** — venda realizada ≠ recebimento efetivo; nada é inventado:
- `GET /conciliacao/resumo?mes=AAAA-MM` → `ponte` (vendas, recebido, diferença a explicar, taxas por canal, residual, `estado`, `faltando`), `caixaDias[]`, `sangriaDias[]`, `totalSangria`, `porConta[]`, `referencias[]`, `excecoesSangria[]`, `resumo`.
- Estados: `sem_referencia` · `conciliado` · `pendente_identificacao` · `parcialmente_resolvido` · `resolvido` · `sem_vinculo_canal`. **O residual nunca vira “prazo” sozinho.**
- `POST /conciliacao/referencias { itens:[{data,tipo(venda|taxa|sangria|dinheiro),valor,canal?,nota?}] }`; `POST …/referencias/importar { conteudoBase64, simular? }` (CSV/XLSX genérico DATA·TIPO·VALOR·[CANAL]·[NOTA]; idempotente; pensado para a planilha complementar ou PDV, **ainda não fornecidos**).
- `POST /conciliacao/resolucoes { escopo(ponte_mensal|caixa_dia|sangria_dia), chave, classificacao(prazo|taxa|ajuste|estorno|divergencia|outros), valor, nota }` (mesmo sinal da diferença; soma ≤ diferença; revogável com motivo; auditado).
- `GET /conciliacao/pendencias?de&ate` → pendências por motivo preservado (`a_identificar`, `valor_por_formula`, `identica_no_arquivo`, `transferencia_sem_contraparte`), duplicidades e movimentos com terceiros (líquido saindo).
- Exceções de sangria: dado aprovado (categoria + motivo, quem/quando), nunca nome fixo no código.

**Períodos (B8):**
- `GET /periodos` → meses + `politica`; `GET /periodos/:mes/pre-fechamento` → `fingerprint`, `periodo.versao`, `avaliacao{pode, exigeReconhecimento, bloqueios[]}`, `pendencias`, `resumo`.
- `POST /periodos/:mes/fechar { confirmo:true, versao, fingerprint, reconhecoPendencias? }` — **409** (`FIN_PERIODO_CONFLITO_DADOS|VERSAO`) se o mês mudou depois da pré-visualização; fechamento com pendências **bloqueado por padrão**; snapshot imutável (regime de caixa; `saldosConciliadosComExtrato:false`).
- `PUT /periodos/politica { permiteFecharComPendencias, notaAprovacao≥10, confirmoAprovacao }`: padrão **desligado**; ligar exige aprovação registrada (quem/quando/nota) e cada fechamento ainda exige reconhecimento.

## 4. Telas (contrato de montagem)

Arquivos em `frontend/src/financeiro/<pagina>.js`, cada um exporta `render(container, ctx)` (`ctx.permissoes` do `/status`; botões só aparecem com a permissão — o servidor decide).

| `pagina` (menu A1) | Estado |
|---|---|
| `visao-geral`, `fluxo-de-caixa`, `contas`, `dre`, `indicadores`, `categorias`, `plano-de-contas`, `importacao`, **`conciliacao`**, **`periodos`** | **entregues** |
| `relatorios`, `configuracoes` | não entregues (B9 exportação) |

CSS sob demanda (`financeiro-paginas.css`), tema escuro via `[data-theme="dark"]`.

## 5. Banco

- `sql-provisorio/121_*` (já promovida pelo A1) e **`122_conciliacao_periodos.provisorio.sql` + `122_rollback.provisorio.sql`** (NÃO executáveis pelo pipeline). O 122: tabelas `fin_referencias`, `fin_conciliacao_resolucoes`, `fin_sangria_excecoes`, `fin_config`; colunas `revisao_motivos`, `canal_referencia`, `versao`, `status` do par; funções `fin_abrir_periodo`, `fin_fechar_periodo`, `fin_reabrir_periodo`, `fin_fingerprint_periodo`, `fin_cancelar_transferencia`, `fin_desvincular_transferencia_motivada`; trava de período com `FOR SHARE`/`FOR UPDATE`; rede de segurança no COMMIT contra cancelamento parcial; **correções da revisão da 121** (R5–R10).
- Validado em PostgreSQL 17 **temporário local** (`backend/testes-financeiro-pg/run.sh`, `FIN_PG_DESCARTAVEL=1`, só loopback): aplica 121+122 duas vezes e **com dados existentes**, testes de domínio/períodos/cancelamento, **concorrência real com duas sessões** (fechamento × escrita; 5 cenários do cancelamento), rollbacks (recusa com dados; vazio sobe/desce). Revisão da 121 integrada: `revisao_migration.sh`.
- RLS ligada sem policies (sem FORCE — ver revisão: FORCE quebraria a auditoria com dono sem `BYPASSRLS`); `service_role` sem DELETE; o desvínculo sem motivo da 121 perde o EXECUTE no 122.
- Pendente de ambiente real e descartável (BL-02/BL-04): `service_role` com `BYPASSRLS`, dono das funções, default privileges de sequências.

## 6. Testes

- Backend (sem rede, sem credenciais): `node --test test/financeiro/` (cálculos, importação, serviços, rotas, ponta a ponta, conciliação, períodos, cancelamento, permissões por nível, isolamento, mensagens, **contrato repositório ⇄ SQL**, guarda de escopo).
- Frontend: `node --test frontend/test/financeiroModelo.test.js`; navegador real: `frontend/test/financeiro.browser.test.js` (14 testes; `FIN_PLAYWRIGHT_PATH`, `FIN_BROWSER_CHANNEL`).
- PostgreSQL descartável: `backend/testes-financeiro-pg/run.sh`.
- Homologação histórica LOCAL (planilha real, fora do Git): `backend/scripts/financeiro-homologacao-local.mjs` e `financeiro-previa-local.mjs`.
