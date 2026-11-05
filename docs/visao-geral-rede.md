# Visão Geral da Rede (Painel Administrativo)

Status: implementada na branch `feat/visao-geral-rede`, integrada à `main` (inclui os PRs #84 e #85 do Foody). **Somente leitura**: sem migration, sem variável de ambiente nova, sem escrita de dados.

## 1. O que foi implementado

| Item | Detalhe |
|---|---|
| Nova home do Painel Administrativo | "Visão Geral da Rede" (cross-tenant). A antiga "Visão Geral" passou a se chamar "Monitoramento Dashboard iFood" (mesmo id/rota; links salvos continuam válidos). |
| Rota nova | `GET /administrativo/visao-geral-rede?mes=&organizacaoId=&unidadeId=&modalidade=&situacao=&busca=` |
| Rota nova | `GET /administrativo/unidades/:unidadeId/dashboard` — Dashboard iFood completo da unidade (cards + Indicadores de Rentabilidade). Chama `obterMes` do Dashboard Executivo para **uma** unidade. |
| Conteúdo | 10 cards de KPI, filtros no servidor, rankings por modalidade, evolução mensal (6 meses), composição de deduções, tabela por empresa e por unidade. |
| Motor | Reaproveita `lucratividadeDaUnidade`, `agregarRede`, `escolherMetas`, `montarLinhaDoTempo`. O estado de atenção financeira (`administrativo.visaoRede.js`) deriva o limiar da meta já existente (`metaIdeal`/`limite`); o impacto estimado considera só o excedente ao limite. |
| Frontend | `renderIndicadores` extraída para `dashboardExecutivoIndicadoresTabela.js` e usada pelo Dashboard do franqueado e pelo detalhe administrativo (sem duplicar marcação). Cards com valores monetários que nunca cortam (`auto-fit`, piso de 260 px, quebra de linha como rede de segurança). |
| Acesso | Rotas atrás de `requirePainelAdministrativo` (aplicado ao router `/administrativo` inteiro). |

## 2. Integração com o Foody (PR #84 / #85)

O único conflito com a `main` foi em `frontend/src/dashboardExecutivo.js`: o PR #84 inseriu o bloco informativo ao lado de `renderIndicadores`, e esta branch moveu essa função para outro módulo.

Resolução, preservando as duas mudanças:

```js
if (dex.aba === "indicadores") {
  renderIndicadores(box, dex.dadosMes);                 // módulo extraído
  box.insertAdjacentHTML("beforeend", logisticaProprioHtml(dex.dadosMes.logisticaProprio)); // bloco Foody (#84)
  return;
}
```

- O teste de código-fonte do #84 (`frontend/test/dashboardExecutivoLogisticaProprio.test.js`) agora exige a assinatura exata `renderIndicadores(box, dex.dadosMes);` seguida do `insertAdjacentHTML(... logisticaProprioHtml(...))`, e que `logisticaProprioHtml(` apareça uma única vez. A verificação **não foi enfraquecida**.
- Nenhum arquivo Foody do backend foi alterado por esta demanda (a `main` entrou inalterada).
- A Visão Geral da Rede **não lê** `foody_*` nem o bloco `logisticaProprio`; o bloco continua desligado por padrão (`FOODY_CENTRAL_DASHBOARD_ENABLED`) e informativo.

## 3. Evidências de homologação disponíveis

Só há as declarações registradas nas mensagens dos commits da própria demanda. Não há relatório de homologação com usuário real nem capturas de tela arquivadas no repositório.

- `a80e4f6`: 537 testes de backend (34 novos), 1667 de frontend (27 novos).
- `a01855f`: 547 nos módulos tocados no backend; 1678 no frontend; suíte completa do backend 6235/6278 com falhas pré-existentes.
- `9f7f2e5`: valores de estresse (R$ 262.955,38 a R$ 12.500.000,00, negativos, 100,00 %) conferidos em larguras equivalentes a 1920/1440/1366/1024/768/390 px, "zero cortes" (conferência feita pelo autor da mudança).

## 4. Verificação desta integração (executada nesta etapa)

Ambiente: Node 20, Windows, variáveis Supabase fictícias, sem rede.

| Verificação | Resultado |
|---|---|
| Frontend completo | 1717 testes; 1691 passam; 0 falhas (os demais são `skip`/`todo`). |
| Backend, por arquivo (390 arquivos) | 7 arquivos falham na cópia de trabalho local; explicados abaixo. |
| Falhas **preexistentes** (também na `origin/main`) | `central-conversas`, `central-visao-historico`, `performance-calc`, `sessao-perfil` (3 de 3 execuções, nos dois lados). |
| Falhas por **CRLF local** | `migration-075` e `bonificacao-mensal-fechamento` falham só na cópia de trabalho do autor (arquivos com CRLF; no git estão em LF). Em checkout limpo do `HEAD` passam (50/50 e 37/37). |
| Intermitentes | `dashboard-executivo-periodo-misto` (crash nativo do Node/Windows): 0 falhas em 3 execuções; passa em checkout limpo (40/40). `whatsapp-retry-allowlist` e `whatsapp-retry-cache-routes` falham na `main` neste ambiente e passaram na branch. |
| Não executado | `ifood-worker-lifecycle.test.js` (trava no ambiente Windows por entrega de SIGTERM, preexistente, conforme registrado em `a01855f`); `migration-075` contra Postgres real; navegador/tela real; tema escuro; produção. |

Os testes de Visão Geral da Rede, administrativo, Dashboard Executivo, Foody e permissões estão entre os que passaram.

## 5. Desempenho (medição sintética, sem produção)

A Visão Geral da Rede **não** dispara uma consulta por unidade. `visaoGeralRede` faz três leituras em lote concorrentes (`Promise.all`: lançamentos, metas, trocas de modelo). Os lançamentos são lidos em lotes de 200 unidades, **sequencialmente**, com paginação de 1000 linhas (`administrativo.repo.js`: `emLotes`, `paginar`). Janela: 6 meses + mês corrente.

Medido com um Supabase simulado (dados fictícios, 6 meses de lançamentos diários por unidade, metade Marketplace, metade Full Service):

| Unidades | Linhas de lançamento | Consultas ao banco | CPU do serviço (melhor de 3) | Resposta | Heap |
|---:|---:|---:|---:|---:|---:|
| 46 | 7.268 | 14 (8 de lançamentos) | 5 ms | 37 KB | 18 MB |
| 200 | 31.600 | 37 | 12 ms | 152 KB | 28 MB |
| 500 | 79.000 | 84 | 31 ms | 378 KB | 44 MB |
| 1000 | 158.000 | 161 | 68 ms | 755 KB | 60 MB |

Leitura:
- A CPU e a memória do backend são desprezíveis. O custo real é a **latência de ida e volta ao banco**, que cresce com o número de páginas (≈ linhas ÷ 1000), em série.
- Não foi medida latência real do Supabase. Uma estimativa (não medida): com ~14 consultas sequenciais, a resposta fica em algumas centenas de milissegundos para 46 unidades.
- **Nenhuma otimização foi aplicada**: o fan-out por unidade que motivou a preocupação não existe, e mexer no repositório compartilhado (`administrativo.repo.js`) mudaria outras telas. Não há cache, então não há risco de número desatualizado.
- Se a rede crescer para centenas de unidades, o caminho seguro é paralelizar poucas páginas por vez (concorrência limitada de 3 a 4) em `carregarLancamentosDaFrota`. Isso não é necessário hoje.
- O detalhe `GET /administrativo/unidades/:id/dashboard` roda `obterMes` para uma unidade por clique.

## 6. Limitações conhecidas (sem ocultar)

1. Sem validação visual em navegador nesta etapa; sem tema escuro verificado; sem teste com dados reais de produção.
2. Desempenho medido apenas com simulação; latência real do Supabase não medida.
3. Se uma unidade não tiver `modelo_logistico_ifood`, a meta de deduções fica `null` e a situação depende dessa regra.
4. Testes de backend de arquivos de texto (`migration-075`, `bonificacao-mensal-fechamento`) são sensíveis a CRLF em cópias locais Windows.
5. A Visão Geral da Rede não inclui custo de entregadores próprios (Foody). Decisão de negócio pendente, igual à do Dashboard Executivo.
6. Não existe, no repositório, runbook de rollback ou backup (`docs/DEPLOY.md`); o procedimento abaixo é uma recomendação.

## 7. Procedimento de publicação

Pré-requisito: PR aberto da branch `feat/visao-geral-rede`, revisado e mesclado pelo responsável.

1. Confirmar CI/verificações do PR verdes e que o diff contém só os 16 arquivos da demanda, a documentação e o merge da `main`.
2. Mesclar. O Render publica sozinho a partir da `main` (há mudança de backend).
3. Verificar `/health`: `ok:true` e `versao` igual ao commit de merge.
4. Verificar o boot nos logs do Render e o primeiro ciclo do agendador Foody (cerca de 3 minutos depois do reinício), sem erros.
5. Como administrador: abrir a Visão Geral da Rede; trocar mês e ano; aplicar um filtro; clicar numa empresa e numa unidade; voltar (o contexto dos filtros se mantém).
6. Como usuário **sem** painel administrativo: confirmar que as duas rotas novas respondem 401/403.
7. Conferir o Dashboard Executivo (aba Indicadores) de uma unidade: indicadores idênticos aos de antes e, com a flag Foody desligada, sem o bloco "Entregadores próprios".
8. Conferir cartões de valores altos em celular.

Sem migration, sem variável nova, sem ação manual no Supabase.

## 8. Procedimento de rollback

- Rápido: no painel do Render, redeploy do commit anterior ao merge (`cf49bd6` na data desta preparação).
- Definitivo: `git revert -m 1 <commit-de-merge>` em PR, e novo deploy automático.
- Não há migration nem dado gravado por esta demanda: não há banco a desfazer e nenhum backup é necessário.
- Depois do rollback, repetir os passos 3 e 4 acima.
