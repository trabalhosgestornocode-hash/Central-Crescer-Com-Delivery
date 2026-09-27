# iFood — status de homologação (consolidação, Checkpoint E)

> Fonte única de verdade sobre o que está **validado de verdade** (E2E real, sandbox Teste (C) centralizado) e o que
> depende de terceiros para ser validado. O modelo oficial do produto é **DISTRIBUÍDO**; o Teste (C) é só o ambiente
> técnico temporário. Nenhum dos itens abaixo passou por homologação oficial do iFood — todos os resultados reais são
> rotulados **"VALIDAÇÃO TÉCNICA CENTRALIZADA"**. Detalhes de cada item: `docs/ifood-auth-arquitetura.md`,
> `docs/ifood-events-worker.md`, `docs/ifood-order-confirm.md`, `docs/ifood-order-actions.md`.

## VALIDADO E2E (sandbox real, Teste (C) centralizado, merchant `55c8f464-e65f-4340-b2c7-62d143027040`)

| Item | Evidência |
|---|---|
| Auth Teste (C) | token client_credentials obtido, cacheado, single-flight; travas de ambiente testadas |
| Merchant | descoberta real (`listarMerchantsAutorizados`), 1 loja |
| Events | polling real (200/204), persistência, dedupe, lease (adquirir → outro bloqueado → liberar → assumir) |
| ACK | 202 real; reentrega após ACK comprovadamente não volta (polling seguinte 204) |
| Order Details | `GET /orders/{id}` real, parser sem avisos, persistência idempotente por hash |
| Confirm | POST real, 202, `confirm_requested`, evento CFM real resolvendo para `CONFIRMED` (3 pedidos) |
| ReadyToPickup | POST real, 202, `ready_requested`, evento RTP real resolvendo (sem SPE observado) |
| Dispatch | POST real com corpo `{"deliveredBy":"MERCHANT"}`, 202, evento DSP real resolvendo |
| CancellationReasons | GET real; forma observada é lista `[{cancelCodeId,description}]` (11 a 13 motivos, varia com o estado do pedido) |
| Cancelamento | POST real com corpo `{"cancellationCode","reason"}`; 1ª tentativa recusada (400, corpo incompleto), corrigida, 2ª aceita (202), evento CAN real resolvendo para `CANCELLED` |

Em todos os itens acima, o **HTTP aceito nunca foi tratado como estado oficial** — sempre foi o evento correspondente que fechou o ciclo, comprovado com timestamps reais.

## VALIDADO AUTOMATICAMENTE (sem prova E2E real)

| Item | O que existe |
|---|---|
| Handshake (HSD/HSS, accept/reject/alternative, `ifood_disputas`) | Parser, persistência (idempotente, tolerante a fora de ordem), `responderDisputa` com validação contra o que o iFood ofereceu, `expiresAt`, auditoria — tudo coberto por testes automatizados com dados sintéticos. **Nenhuma disputa real foi observada** nos ~20 eventos reais recebidos até aqui (nem mesmo depois de 3 cancelamentos reais). |

## PENDENTE EXTERNO

| Item | Motivo | Como desbloqueia |
|---|---|---|
| Handshake E2E — homologação assistida | O Handshake nasce por iniciativa do **cliente**, no app de consumidor de homologação; não existe simulador no Portal do Parceiro. Orientação do suporte/homologação do iFood (2026-09-27): o ciclo `HSD → resposta do merchant → HSS` será validado durante a homologação assistida | Rodar `npm run ifood:order-action -- --acao dispute-status` quando o iFood gerar o cenário; a disputa chega pelo caminho já implementado, sem mudança de código |
| Teste (D) distribuído — modelo oficial do produto | `userCode` gerado com sucesso (`POST /oauth/userCode` HTTP 200); autorização no Portal **bloqueada por permissão** do lado do iFood | Aguardar liberação/permissão do iFood para o app distribuído de teste |

## O que isso NÃO é

- Não é homologação oficial do iFood.
- Não valida o modelo DISTRIBUÍDO em produção (isso depende do Teste (D), acima).
- Não inclui UI final de operação de pedidos, nem integração com o Subway Saci real.
- Nenhuma ação foi executada em loja real ou em produção.
