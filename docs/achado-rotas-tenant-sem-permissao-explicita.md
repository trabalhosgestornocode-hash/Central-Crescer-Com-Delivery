# Achado — rotas do tenant sem exigência de permissão no roteador

Documento do Checkpoint 6B.1. **Só registra o achado; nenhuma rota foi alterada nem refatorada.**

## O que foi medido

Com os routers REAIS do tenant (`backend/test/helpers/rotas-tenant.js`) atrás de um contexto simulado cujo papel tem
**zero permissões** e **todos os módulos contratados**, cada método+caminho foi disparado. Rotas que **não** respondem
403 são rotas cujo roteador não exige permissão alguma: quem tem Context Token válido (e o módulo contratado) chega ao
handler.

Resultado nesta medição: **33 rotas** (o achado anterior falava em 34; a diferença é a contagem da credencial Realtime,
que passou a ter regra própria no perfil de exibição, e rotas que respondem por timeout/erro por não haver banco no teste).
O número exato importa menos que a lista:

| Módulo (prefixo) | Rotas sem exigência no roteador | Observação |
|---|---|---|
| `/produtos` | `GET /`, `GET /historico/recentes`, `GET /:id`, `GET /:id/historico` | leitura de produtos/CMV |
| `/cmv` | `GET /`, `GET /produto/:id` | leitura |
| `/dashboard` | `GET /resumo` | leitura |
| `/vendas` | `GET /visao-geral`, `/faturamento`, `/produtos`, `/importacoes`, `/importacoes/:id/arquivo`, `/divergencias`, `/combos/:codigo/componentes`; **`DELETE /importacoes/:id`**, `PATCH /divergencias/:id`, `POST /importar`, `/importar/preview`, `/vincular`, `/vincular-lote` | **inclui escritas e exclusão** |
| `/integracoes/martin-brower` | `GET /settings`, `/products`, `/price-history`, `/sync-history`, `/unlinked`; `POST /start`, `/:sessionId/code`, `/:sessionId/cancel`; `GET /:sessionId/status` | inclui iniciar sessão do integrador |
| `/inteligencia` | `GET /integracoes` | leitura |
| `/agente` | `POST /mensagem`, `GET /conversas/:conversationId` | |
| `/realtime` | `POST /credencial` | intencional: a TV precisa dela (regra própria, só tópico da unidade) |

Há ainda rotas que o roteador protege só com `requireModulo` na montagem (contratação), não com permissão.

## O que isto significa para o perfil de exibição

**Nada.** O perfil `display_operator` é barrado **antes** de chegar a qualquer uma delas por `restringirPerfilExibicao`
(deny-by-default, montado logo após `requireContexto`), e isso é provado:

* `perfil-exibicao-isolamento.test.js` — todas as rotas do tenant, por papel e com mutação do próprio teste;
* `perfil-exibicao-cadeia-real-pg.test.js` — pela cadeia real (JWT → contexto → restritor) contra Postgres;
* `perfil-exibicao-rotas-fora-do-tenant-real-pg.test.js` (6B.1) — **todas** as rotas de `routes.js` (sessao, plataforma,
  administrativo, contexto, tenant), percorrendo a pilha Express, com a sessão de exibição real: só a lista fechada
  responde 2xx.

O achado é, portanto, **pré-existente e independente** do 6B: afeta os papéis que já existiam (qualquer papel com
Context Token e módulo contratado alcança essas rotas, mesmo sem a permissão "natural" do módulo).

## Limites da verificação (honestidade)

* Foi medido o que o **roteador** exige. Alguns controllers/services podem checar permissão por dentro; isso **não foi
  auditado** aqui. A afirmação é "o roteador não exige", não "a rota é insegura".
* O isolamento entre empresas/unidades não está em questão: os handlers filtram por `req.tenant`.
* Rotas que deram timeout no teste (sem banco) foram contadas como "não 403" porque o handler foi alcançado.

## Recomendação (não executada)

Tratar em checkpoint próprio: classificar cada rota (leitura/escrita), adicionar `requirePermissao` correspondente e um
teste de trava que falhe quando uma rota nova do tenant nascer sem exigência. Prioridade maior para as **escritas**
(`/vendas` importar/vincular/excluir e `/integracoes/martin-brower` start/cancel/code). Exige cuidado: papéis em uso
hoje que dependem do comportamento atual podem perder acesso — validar com os perfis reais antes de publicar.
