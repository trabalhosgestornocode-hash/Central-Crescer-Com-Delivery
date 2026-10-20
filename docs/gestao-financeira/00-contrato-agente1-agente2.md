# Contrato técnico Agente 1 ⇄ Agente 2 — Gestão Financeira (v1, estável)

Mudanças neste contrato só com acordo explícito entre os dois agentes.

## Identificadores
| Item | Valor |
|---|---|
| Módulo canônico | `gestao_financeira` (categoria `financeiro`) — nasce DESABILITADO |
| Namespace de permissões | `gestao_financeira.{ver,lancar,editar,conciliar,fechar,reabrir,excluir,configurar}` |
| API de domínio | `/api/v1/gestao-financeira/*` |
| Saúde/autorização | `GET /api/v1/gestao-financeira/status` |
| Setores autorizados | `GET /api/v1/sessao/setores` → `{ setores: ["financeiro","operacional"] }` (derivado no servidor, a cada chamada) |

As permissões financeiras ficam em `backend/src/shared/gestaoFinanceira.permissoes.js` (arquivo NOVO, do Agente 1), **fora** de `PERMISSOES`, para não serem herdadas por `organization_admin`.

## Níveis de concessão → permissões (proposta; a matriz final é validada antes de liberar escrita)
- `leitura`: `ver`
- `operador`: `ver, lancar, editar`
- `gestor`: `ver, lancar, editar, conciliar, cancelar, fechar, configurar`
- **A7.1:** `cancelar` é independente de `excluir`; `reabrir` e `excluir` **não são concedidos a nenhum nível** (ver `07-permissao-cancelar-e-revisao-121.md`).

## Unidade e tenant
O backend NUNCA aceita organização/unidade do cliente. Ambas vêm do Context Token → `sessoes_contexto` (`req.tenant`). Cada requisição financeira relê a concessão no banco.

## Como registrar o router (Agente 2)
O Agente 1 cria o ponto de montagem em `backend/src/routes.js`:
```js
tenant.use("/gestao-financeira", requireFinanceiro(), gestaoFinanceiraRouter);
```
`gestaoFinanceiraRouter` é exportado de `backend/src/modules/gestao-financeira/index.js`, que importa `./dominio/index.js` (**Agente 2** exporta `dominioRouter` lá). O Agente 1 só monta `GET /status` e o gate.

Em cada rota o Agente 2 usa **apenas**: `autorizarAcaoFinanceira("gestao_financeira.<acao>")` (lê `req.financeiro = { nivel, permissoes, organizacaoId, unidadeId }`). **Proibido** usar `requirePermissao`, `requireModulo`, `requirePapel`, `requireAlgumaPermissao` (têm bypass de impersonação). Toda query filtra explicitamente por `req.financeiro.organizacaoId` e `unidadeId`.

## Erros
Mesmo formato do `ApiError` existente: `{ erro: string, detalhes?: { codigo } }`.
Códigos: `FINANCEIRO_NAO_HABILITADO` (403), `FINANCEIRO_SEM_CONCESSAO` (403), `FINANCEIRO_PERMISSAO_INSUFICIENTE` (403), `FINANCEIRO_BLOQUEADO_IMPERSONACAO` (403), `MFA_REQUERIDA` / `REAUTENTICACAO_RECENTE` (401, só administração de concessões).

## Frontend
- Entrada: `frontend/src/financeiro/` (Agente 2 — conteúdo das páginas). Cada página exporta `render(container, ctx)`.
- Agente 1 é dono de: seleção de setor, alternador, menu e roteamento global (`frontend/src/config.js`, shell/topbar), com estas rotas: `financeiro/visao-geral`, `fluxo-de-caixa`, `contas`, `conciliacao`, `dre`, `indicadores`, `categorias`, `plano-de-contas`, `periodos`, `importacao`, `relatorios`, `configuracoes`. Páginas ainda não entregues mostram "Em construção".
- O setor ativo é preferência de UI; nunca autoriza nada.

## Banco e migrations
- **Agente 1**: migration de fundação (módulo, categoria, concessões, auditoria, RLS, revokes) — próximo número livre **120**.
- **Agente 2**: migration(s) do domínio financeiro, numeração a partir de **121**, coordenada. Tabelas do domínio: RLS ligado, **sem** policies de tenant para `anon/authenticated`, `revoke all` desses papéis, acesso só via backend (service_role) com filtro explícito de org+unidade. Nenhuma migration é aplicada em produção.

## Arquivos exclusivos
**Agente 1:** `shared/gestaoFinanceira.*`, `middlewares/financeiro*.js`, `modules/gestao-financeira/{index,status,concessoes}*`, `modules/sessao/*` (setores), `routes.js`, `shared/{permissoes,modulos}.js`, `frontend/src/{config,shell}*`, `database/migrations/120_*`, `backend/testes-seguros/**`, este diretório de contrato.
**Agente 2:** `modules/gestao-financeira/dominio/**`, `frontend/src/financeiro/**`, `database/migrations/121+`, `backend/src/financeiro-calculos/**` (módulos puros), testes do domínio.

## Privacidade (repo PÚBLICO)
Nada de planilha, movimentação, extrato ou fixture financeira real no Git. Testes usam apenas dados fictícios. Arquivos privados vão em `docs/gestao-financeira/privado/` (ignorado).

---

## Atualização v1.1 (checkpoint A4/A5) — o que já existe no código da branch `feat/financeiro-agente1-fundacao`

**Envelope das respostas:** `{ "data": ... }` (igual ao resto da API). `GET /api/v1/gestao-financeira/status` → `{ data: { habilitado, nivel, permissoes[] } }`; `GET /api/v1/sessao/setores` → `{ data: { setores: ["financeiro"|"operacional"] } }`.

**Gate da API (Agente 2 só consome):** `tenant.use("/gestao-financeira", requireFinanceiro(), gestaoFinanceiraRouter)` já está em `backend/src/routes.js`. `req.financeiro = { nivel, permissoes, somenteFinanceiro, organizacaoId, unidadeId }`. Use `autorizarAcaoFinanceira(PERM_FIN.X)` (de `middlewares/financeiro.js` e `shared/gestaoFinanceira.permissoes.js`). Sem unidade selecionada ("todas as unidades") o financeiro responde `FINANCEIRO_SEM_CONCESSAO`: o financeiro é sempre **por unidade**.

**Onde o Agente 2 anexa o domínio:** crie `backend/src/modules/gestao-financeira/dominio/index.js` exportando `dominioRouter`; o Agente 1 fará a linha `gestaoFinanceiraRouter.use(dominioRouter)` em `modules/gestao-financeira/index.js` na integração (o arquivo é do Agente 1; não edite).

**Páginas (frontend):** o menu tem 12 itens, ids `fin-*`, em `frontend/src/financeiroMenu.js`. Para cada item, o roteador faz `import("./financeiro/<pagina>.js")` e chama `render(container, ctx)`; `ctx = { rota, nivel, permissoes, sessao }`. As páginas são do Agente 2; enquanto o arquivo não existir aparece "Em construção". Slugs: `visao-geral, fluxo-de-caixa, contas, conciliacao, dre, indicadores, categorias, plano-de-contas, periodos, importacao, relatorios, configuracoes`. Antes de cada página, o roteador consulta `/status`; 403 => o setor é abandonado (revogação imediata). Use `http.get/post` de `sessao.js` (envia Bearer + Context Token); um 403 `FINANCEIRO_*` do seu domínio deve ser propagado, não engolido.

**Concessão:** tabela `gestao_financeira_concessoes` (migration 120) com `somente_financeiro` (usuário que entra direto no financeiro). **Nunca** leia essa tabela no domínio; a autorização já vem em `req.financeiro`.

**Administração (SuperAdmin):** `GET|POST /api/v1/plataforma/gestao-financeira/concessoes` e `POST .../:id/revogar`. Escritas **bloqueadas** salvo `FINANCEIRO_CONCESSOES_HABILITADAS=true` + AAL2 com 2º fator ≤ 10 min por requisição. Não faz parte do domínio do Agente 2.

**Numeração:** 120 = fundação (Agente 1). O Agente 2 usa **121+**. As tabelas do domínio devem referenciar `organizacoes(id)` e `unidades(id)` e seguir o padrão RLS-sem-policy da 120.
