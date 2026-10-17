# Kit de integração Agente 1 × Agente 2 (ensaiado em worktree descartável; NÃO mesclado)

Ensaio feito em 2026-10-17: `git merge --no-commit feat/financeiro-agente2-dominio` sobre `feat/financeiro-agente1-fundacao` → **sem conflitos de arquivo** (o Agente 2 só tocou caminhos exclusivos dele).

## Passos da integração (quando houver autorização para mesclar)
1. Mesclar a branch do Agente 2 (merge commit, sem rebase).
2. Em `backend/src/modules/gestao-financeira/index.js` (arquivo do Agente 1) acrescentar:
   ```js
   import { dominioRouter } from "./dominio/index.js";
   // ...
   gestaoFinanceiraRouter.use(dominioRouter);   // já atrás de requireFinanceiro() (routes.js)
   ```
3. Copiar `gestao-financeira-integracao.test.js.txt` para `backend/test/gestao-financeira-integracao.test.js` (9 provas: gate REAL × domínio REAL, HTTP em loopback, repositório em memória).
4. Rodar: `npm run test:seguro` (T1). Resultado do ensaio: 5328 testes, 5297 ok; as falhas restantes são as já classificadas (04-classificacao…) **+ 1 conflito novo, abaixo**.

## Conflito encontrado no ensaio (a resolver pelo Agente 2 — arquivos dele)
`test/central-acesso-painel.test.js` ("guarda estática: nenhuma permissão paralela") varre `backend/src` procurando `/temPermissaoConexao|exigirPermissao/` e exige que só `administrativo.comunicacao.conexao.js` o contenha.
O Agente 2 usa **`exigirPermissao`** como nome do parâmetro de injeção em `dominio/rotas.js` e `dominio/index.js` ⇒ o teste falha após o merge.
**Proposta (não aplicada):** o Agente 2 renomeia o parâmetro para `autorizar` (ex.: `criarDominioRouter({ autorizar, deps })`) — mesma razão pela qual o Agente 1 renomeou `exigirPermissaoFinanceira` → `autorizarAcaoFinanceira`. Não se deve afrouxar a guarda da Central.

## Outros pontos conferidos
- Slugs de página do Agente 2 presentes: visao-geral, fluxo-de-caixa, contas, dre, indicadores, categorias, plano-de-contas, importacao. **Ausentes** (continuam "Em construção"): conciliacao, periodos, relatorios, configuracoes.
- O SQL do domínio está em `docs/…/sql-provisorio/121_*.provisorio.sql` (fora de `database/migrations`): a numeração 121 só deve ser tomada na integração.
- O domínio importa `middlewares/financeiro.js` — existe apenas na branch do Agente 1 (esperado).
