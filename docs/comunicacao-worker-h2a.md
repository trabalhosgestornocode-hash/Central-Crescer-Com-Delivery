# Worker de comunicação — Checkpoint H.2-A

Invólucro operacional mínimo para chamar `executarCiclo()`
(`backend/src/modules/comunicacao/comunicacao.alertas.service.js`) em
intervalos controlados, como processo separado do backend HTTP principal.
**Este checkpoint é só o worker local — nenhum serviço foi criado no Render,
nenhuma habilitação foi criada, `modo` continua `DISABLED`.**

## 1. Por que dentro de `backend/`, não um pacote `worker-comunicacao/` à parte

O repositório não usa npm/yarn workspaces (não há `package.json` na raiz).
`worker-martinbrower/` é um pacote de verdade separado porque **nunca importa
código do backend** — fala com ele só por HTTP+HMAC. O worker de comunicação
é o oposto: `executarCiclo()` é uma árvore profunda de módulos do backend
(`administrativo.service.js`, `comunicacao.*.js`, cliente Supabase). Duplicar
isso num pacote irmão exigiria reimplementar ou importar por caminho relativo
cruzando `rootDir`s — frágil e exatamente o tipo de duplicação de motor de
negócio que o checkpoint proibiu.

**Escolha**: `backend/src/worker-comunicacao/` — um entrypoint dedicado
dentro do MESMO pacote (`subway-saci-backend`), com script próprio
(`npm run worker:comunicacao`). Reaproveita `node_modules`, env e todo o
bootstrap do backend sem duplicar nada. Continua sendo um **processo Render
separado** (rootDir `backend`, mas `startCommand` diferente) — nunca é
iniciado pelo `server.js` HTTP.

## 2. Arquivos

- `backend/src/worker-comunicacao/config.js` — parsing fail-closed de
  `COMUNICACAO_WORKER_INTERVAL_MS` (ausente → 60000ms; inválido/abaixo de
  5000ms → boot falha) e leitura de `WHATSAPP_GATEWAY_URL`/
  `WHATSAPP_GATEWAY_SECRET`/`PORT` (essas três NÃO são fail-closed no boot —
  ver §4).
- `backend/src/worker-comunicacao/loop.js` — o laço serial (`criarLoopWorker`).
  Único lugar que decide QUANDO chamar `executarCiclo()`; não implementa
  nenhuma regra de negócio.
- `backend/src/worker-comunicacao/worker-comunicacao.logsafe.js` — logger
  estruturado com bloqueio de campos sensíveis (telefone, JID, conteúdo,
  providerMessageId, nome, segredos).
- `backend/src/worker-comunicacao/index.js` — entrypoint: monta
  `whatsAppService` (`criarBaileysGatewayProvider` + `criarWhatsAppService`),
  monta o laço, sobe `/health`, liga SIGTERM/SIGINT/uncaughtException.

## 3. Gate de modo — mais forte que o já existente

`processarProximoLote()` já se recusa a agir se `modo !== NORMAL`, mas isso
acontece **depois** de `detectarESincronizarAlertas`/`agendarEnviosPendentes`
já terem rodado. Para a fase de validação do worker, `loop.js` lê o modo
**antes** de chamar `executarCiclo()` (pela mesma função,
`comunicacao.config.js#modoAtual` — nenhuma segunda fonte de verdade) e, se
não for `NORMAL`, **nem chama `executarCiclo()`**: zero detecção persistida,
zero agendamento, zero claim, zero chamada ao provider. Hoje, em produção,
`modo = DISABLED` — confirmado ao vivo no Checkpoint H.1.

## 4. `gatewayUrl`/`segredoHmac` — fail-closed no boot (Checkpoint H.2-A.1)

O worker de produção recusa subir se `WHATSAPP_GATEWAY_URL` ou
`WHATSAPP_GATEWAY_SECRET` estiverem ausentes/vazios, ou se a URL não for
parseável ou não usar esquema `http:`/`https:` (mesma política de esquema já
usada por `backend/src/shared/validar.js#urlOpcional` — `http:` é aceito de
propósito: é o esquema real da rede interna de Private Services do Render e
do desenvolvimento local, `http://127.0.0.1:PORTA`). O segredo só tem
presença validada — nenhum comprimento mínimo é imposto, pois o próprio
provider (`baileysGateway.provider.js`) também não impõe um, e inventar uma
regra mais forte aqui divergiria da regra real. Validar a PRESENÇA da config
no boot **não** é uma chamada ao provider — `modo=DISABLED` continua
garantindo zero chamadas reais mesmo com a config válida.

## 5. Sem `setInterval` — laço serial

`tick → await executarCiclo (se NORMAL) → sleep(intervalMs) → próximo tick`.
Nunca há duas chamadas de `executarCiclo()` simultâneas na mesma instância —
provado por teste (`worker-comunicacao-loop.test.js`, "sem sobreposição").
Segurança **entre instâncias** continua sendo o `FOR UPDATE SKIP LOCKED` do
claim atômico no banco (migration 087/088), não este laço.

## 6. Shutdown (SIGTERM/SIGINT)

1. marca `STOPPING`;
2. acorda um `sleep` em andamento imediatamente (não espera o intervalo à
   toa) e impede um novo tick de começar;
3. se um ciclo estiver em voo, espera até 12s (grace period, constante —
   sem env nova, sem necessidade operacional hoje) pelo término NATURAL;
4. nunca cancela nada nem reverte status de mensagem — leases no banco
   (`claim_expira_em`) já cuidam de qualquer coisa que não termine a tempo;
5. fecha o servidor `/health` e sai.

## 7. `/health`

`GET /health` sempre `200` enquanto o processo responde — `DISABLED` é
estado operacional válido, não erro:
```json
{ "status": "ok", "workerState": "DISABLED", "uptimeSegundos": 42, "lastCycleAt": "...", "lastCycleStatus": "skipped" }
```
Nunca inclui telefone, conteúdo, JID, token ou segredo.

## 8. Estados

`BOOTING → IDLE ⇄ RUNNING/DISABLED → STOPPING`. `ERROR` existe no enum mas
não é usado como estado persistente: uma falha de ciclo vira
`lastCycleStatus="failed"` e o worker volta a `IDLE` para o próximo tick —
uma falha de ciclo nunca mata o processo (só config inválida no boot ou
`uncaughtException` genuína o fazem, mesmo padrão do `worker-martinbrower`).

## 9. Logs estruturados (todos passam por `worker-comunicacao.logsafe.js`)

`comunicacao.worker_boot`, `worker_ready`, `cycle_started`, `cycle_skipped`
(`reason: global_disabled`), `cycle_completed` (agregados: detectados,
agendados, claimed, sent, blocked, failed, unknown — nunca conteúdo/telefone),
`cycle_failed`, `worker_stopping`, `worker_stopped`.

## 10. `organizacaoId` — não precisa de iteração externa

`executarCiclo({ organizacaoId = null })`: omitido = processa a FROTA
INTEIRA num lote só (decisão já existente em `agendarEnviosPendentes`). O
worker nunca precisa enumerar organizações.

## 11. Plano futuro de Render (documentação — nada foi criado)

```yaml
name: crescercomdelivery-comunicacao-worker
type: private_service
runtime: node          # mesmo rootDir do backend — reaproveita build/deps
rootDir: backend
branch: main
autoDeploy: off        # inicialmente, mesmo padrão do gateway-whatsapp
startCommand: npm run worker:comunicacao
# health: o tipo private_service do Render não expõe HTTP externo como o
# web_service faz; /health fica disponível internamente para diagnóstico
# (curl de dentro da rede Render) e para uma futura sonda própria do Render,
# se o plano do serviço suportar — a definir no H.2-B junto da criação real.
envs necessárias (sem valores aqui):
  - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (mesmas do backend)
  - WHATSAPP_GATEWAY_URL
  - WHATSAPP_GATEWAY_SECRET (mesmo segredo do backend web, já existente)
  - COMUNICACAO_WORKER_INTERVAL_MS (opcional; default 60000)
```
Nenhum Dockerfile é necessário: como o backend web já roda como serviço Node
nativo no Render (não Docker), o worker — mesmo `rootDir`, mesmo
`package.json` — segue o mesmo caminho, só com `startCommand` diferente.

## 12. Regra permanente

**Nunca** chamar `whatsapp.service.js`/Gateway/provider diretamente a partir
deste worker — a única porta de entrada é `executarCiclo()`/
`processarProximoLote()`. Reforçado por teste arquitetural
(`comunicacao-arquitetura-agendamento.test.js`): fora do próprio módulo
`comunicacao/`, só `worker-comunicacao/` pode importar
`comunicacao.alertas.service.js`.
