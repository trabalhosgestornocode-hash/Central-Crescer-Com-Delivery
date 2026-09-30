# iFood — status de homologação (consolidação)

> Fonte única de verdade sobre o que está **validado de verdade** e o que depende de terceiros para ser validado. O
> modelo oficial do produto é **DISTRIBUÍDO**; o Teste (C) centralizado é só o ambiente técnico temporário. Nenhum dos
> itens abaixo passou por homologação oficial do iFood: os resultados do Teste (C) são **"VALIDAÇÃO TÉCNICA
> CENTRALIZADA"** e os do Teste (D) são **"VALIDAÇÃO REAL DISTRIBUÍDA"** (app de teste, banco de teste). Detalhes de
> cada item: `docs/ifood-auth-arquitetura.md`, `docs/ifood-events-worker.md`, `docs/ifood-order-confirm.md`,
> `docs/ifood-order-actions.md`.

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

## VALIDADO REAL — modelo DISTRIBUÍDO (app distribuído de teste "Teste (D)", banco `teste-multiempresarial`, merchant `55c8f464-e65f-4340-b2c7-62d143027040`)

Todas as chamadas abaixo foram read-only, uma por vez, sem worker/polling/cron e sem persistência financeira.

| Item | Resultado | Evidência |
|---|---|---|
| OAuth distribuído | VALIDADO REAL | userCode → autorização no Portal pelo proprietário → `authorization_code`; access e refresh token gravados cifrados |
| Merchant API | VALIDADO REAL | `GET /merchant/v1.0/merchants` lista 1 loja, vinculada à unidade correta |
| Sales API | VALIDADO REAL | 2026-09-29, período 26–27/09 **sem** `x-request-homologation`: HTTP 200, 6 vendas, `merchant.id` = merchant consultado em todas, 6/6 `orderId` presentes em `ifood_pedidos`; documentos (CPF/CNPJ) não saem do mapper |
| Refresh token distribuído | VALIDADO REAL | 2026-09-29: `grantType=refresh_token` HTTP 200; o iFood **rotacionou** o refresh token (devolveu um novo), `expiresIn` 21600; par novo gravado cifrado; `GET /merchants` com o token novo: HTTP 200 e merchant correto |
| Financial Events API | **ACESSO** REAL VALIDADO | endpoint e autorização: HTTP 200 em 26–27/09 e 21–29/09, sem o header de fixture; corpo `[]` nas duas |
| Conteúdo financeiro de pedido de teste | NÃO GERADO PELO IFOOD | limitação oficial (abaixo) — **não** é conteúdo validado |

Estado operacional: worker iFood **desligado**, polling **desligado**, cron **inexistente**; nenhum refresh em
segundo plano (só sob demanda, dentro de uma chamada); **produção não ativada**.

### Limitação oficial do ambiente de teste (confirmada pelo suporte do iFood)

Pedidos criados em loja de teste/homologação **não geram** Financial Events, comissões, taxas,
`billingEntries` nem repasses simulados. Por isso:

- **Financial Events**: o `HTTP 200 + []` é o comportamento esperado — não é falha da integração.
  O **conteúdo** financeiro real não é validável com pedidos de teste.
- **Sales**: as vendas de teste vêm com `billingSummary.saleBalance = 0` e sem `billingEntries`.
- **Comissão, taxas e repasse**: não são simulados no ambiente de teste.
- **Settlements e Reconciliation**: o conteúdo financeiro definitivo não pode ser validado com esses pedidos.
- **Não** repetir consultas de Financial Events tentando encontrar eventos desses pedidos.

### Fixture x dado real

`IFOOD_FINANCIAL_FIXTURE` (padrão `false`) é **independente** de `IFOOD_HOMOLOGATION_MODE` (que só escolhe o app de
teste). `true` pede ao iFood a fixture fixa (`x-request-homologation: true` — outro merchant, outro período) e só é
aceito fora de produção (mesma trava de `centralizadoTestePermitido`; senão o backend não sobe). Fixture serve só para
teste, desenvolvimento e diagnóstico: nunca é dado financeiro real. Sales/Events marcam o resultado com `fonte` e
descartam vendas/eventos de outro merchant; a conciliação continua inteira em fixture (`fonte: "fixture"`), sem
misturar fontes. Frontend e query string não escolhem fixture.

### Refresh distribuído — garantias (cobertas por `test/ifood-refresh-distribuido.test.js`)

- Renovações simultâneas da mesma credencial no mesmo processo compartilham **uma** chamada ao iFood.
- Entre processos: se o refresh falha porque outro processo já rotacionou, a credencial é relida e a nova é usada.
- `reauth_required` só é gravado por compare-and-set (nunca sobre uma credencial recém-renovada).
- Refresh novo substitui o anterior; **sem** refresh novo na resposta, o anterior é preservado (nunca vira `null`).
- 400/401/403 podem exigir reautorização; 429/5xx/timeout **não** derrubam a credencial.
- O refresh nunca é repetido automaticamente (`semRetry`).

## DECISÕES PENDENTES

| Decisão | Depende de |
|---|---|
| Serializar o refresh entre processos com o lease de banco (`ifood_lease_adquirir`, migration 101) | confirmar a 101 aplicada no ambiente alvo, a semântica do lease para esse uso, o comportamento em produção e o impacto no worker. **Hoje o código não depende da 101.** |
| Aplicar migrations 101/102/103 em produção | decisão de ativar Events/Order em produção |
| Validar conteúdo financeiro real | transação real em loja real (homologação oficial/produção) |
| Persistir Sales | schema definitivo a partir do payload real já observado |
| Automatizar o Dashboard iFood | conteúdo financeiro real validado (Sales sozinho não traz comissão/taxas/repasse definitivos) |

## VALIDADO AUTOMATICAMENTE (sem prova E2E real)

| Item | O que existe |
|---|---|
| Handshake (HSD/HSS, accept/reject/alternative, `ifood_disputas`) | Parser, persistência (idempotente, tolerante a fora de ordem), `responderDisputa` com validação contra o que o iFood ofereceu, `expiresAt`, auditoria — tudo coberto por testes automatizados com dados sintéticos. **Nenhuma disputa real foi observada** nos ~20 eventos reais recebidos até aqui (nem mesmo depois de 3 cancelamentos reais). |

## PENDENTE EXTERNO

| Item | Motivo | Como desbloqueia |
|---|---|---|
| Handshake E2E — homologação assistida | O Handshake nasce por iniciativa do **cliente**, no app de consumidor de homologação; não existe simulador no Portal do Parceiro. Orientação do suporte/homologação do iFood (2026-09-27): o ciclo `HSD → resposta do merchant → HSS` será validado durante a homologação assistida | Rodar `npm run ifood:order-action -- --acao dispute-status` quando o iFood gerar o cenário; a disputa chega pelo caminho já implementado, sem mudança de código |
| Conteúdo financeiro real (Financial Events, `billingEntries`, comissões, taxas, repasses, Settlements, Reconciliation) | Pedidos de loja de teste não geram eventos financeiros (limitação oficial do iFood) | Só com pedido real em loja real, na homologação oficial/produção |

## O que isso NÃO é

- Não é homologação oficial do iFood.
- Não valida o modelo DISTRIBUÍDO em produção (o Teste (D) validou o fluxo no banco de teste, não em loja real).
- Não inclui UI final de operação de pedidos, nem integração com o Subway Saci real.
- Nenhuma ação foi executada em loja real ou em produção.
