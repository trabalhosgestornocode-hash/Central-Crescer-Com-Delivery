# Gateway WhatsApp (Baileys)

Processo separado que fala com o WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys)
(`baileys@6.7.24`, fixada — ver `docs/gateway-whatsapp-auth-state-instrumentacao.md`
no repo principal para a instrumentação que embasou essa escolha de versão).
**Não faz parte do backend principal** e nunca é deployado junto com ele.

Status: **Checkpoint C1 — não conectado a nenhum WhatsApp real, não
provisionado no Render.** Todo o lifecycle/reconexão/eventos abaixo é
testado com um socket Baileys **fake** injetado (`test/baileysSession.
test.js`) — ver `docs/` no repo principal para o relatório completo.

## Por que separado

O socket do WhatsApp precisa ficar vivo independente dos deploys do backend
(que acontecem várias vezes ao dia). Rodar dentro do processo web também
aproximaria fisicamente este código do `service_role` do Supabase — o
oposto do que o boundary abaixo exige.

## O que ele faz — e o que não faz

**Faz:** mantém a sessão Baileys, envia/recebe mensagens de texto, imagem e
documento, reporta status de conexão e de entrega ao backend.

**Não faz:** decidir destinatário, cooldown, permissão, política de envio,
Agente Crescer — nada disso. Não acessa dados financeiros nem organizações/
unidades. Não faz bulk, broadcast, grupos, campanhas ou automação comercial.
Toda inteligência de negócio mora no backend; este processo só traduz
Baileys ↔ protocolo interno.

```
Backend Crescer ──HTTP + HMAC──► Gateway ──WebSocket──► WhatsApp
                 ◄── eventos ────
```

## Segurança

| Regra | Como é garantida |
|---|---|
| Sem `SUPABASE_SERVICE_ROLE_KEY` / Supabase / Postgres direto | `test/seguranca-sem-supabase.test.js` escaneia `src/` inteiro |
| Auth state cifrado antes de sair do processo | AES-256-GCM (`src/crypto.js`), chave (`WHATSAPP_AUTH_ENCRYPTION_KEY`) só existe aqui |
| Backend nunca vê o auth state em claro | armazena só o ciphertext — o Gateway nunca envia a chave |
| Autenticação em 2 camadas de fronteira | HMAC nas duas direções (`src/hmac.js`) + rede privada do Render (Private Service, quando provisionado) |
| Sem segredo em log | `src/logsafe.js` mascara HMAC secret, chave de cifra, auth state, QR, conteúdo de mensagem, telefone completo |
| `LOGGED_OUT` nunca reconecta sozinho | `src/baileysSession.js` — só um novo pareamento explícito sai desse estado |
| Superfície HTTP mínima | sem bulk, broadcast, groups, contacts dump, ou endpoint genérico de Baileys |

## Rotas internas (Backend → Gateway)

Todas exigem HMAC, exceto `/health`.

| Método | Rota |
|---|---|
| POST | `/internal/whatsapp/connect` |
| POST | `/internal/whatsapp/disconnect` |
| GET | `/internal/whatsapp/status` |
| POST | `/internal/whatsapp/messages` |
| POST | `/internal/whatsapp/messages/:id/read` |
| GET | `/internal/whatsapp/messages/:id/status` |
| GET | `/health` — **sem HMAC** (probe do Render) |

### Eventos que o Gateway envia (Gateway → Backend)

`POST /internal/comunicacao/eventos/{mensagem-recebida,status-provider,heartbeat,auth-state}`
e `GET /internal/comunicacao/auth-state` — implementados do lado backend em
`backend/src/modules/comunicacao/gateway/`.

### HMAC

```
mensagem = timestamp \n nonce \n MÉTODO \n path+query \n sha256(corpo)
assinatura = HMAC-SHA256(WHATSAPP_GATEWAY_SECRET, mensagem)
```

Cabeçalhos: `X-Gateway-Timestamp`, `X-Gateway-Nonce`, `X-Gateway-Signature`.
Janela de **60 s** (passado e futuro), nonce de uso único, comparação em
tempo constante, cache de nonces com teto e limpeza automática. Mesmo
algoritmo já validado em produção por `worker-martinbrower/src/auth.
middleware.js` — reimplementado aqui como cópia independente, de propósito
(os dois processos são deployados separadamente).

## Variáveis de ambiente

Ver [`.env.example`](.env.example). Obrigatórias: `WHATSAPP_GATEWAY_SECRET`
(≥32 caracteres), `WHATSAPP_AUTH_ENCRYPTION_KEY` (32 bytes), `WHATSAPP_
BACKEND_URL`. O processo **recusa subir** sem elas.

## Build e teste local

```bash
npm install && npm test   # sem Baileys real, sem rede, sem QR

docker build -t gateway-whatsapp:local .
```

Nenhum teste conecta ao WhatsApp real. `test/baileysSession.test.js` injeta
um `fabricaSocket` fake no lugar do `makeWASocket` do Baileys — o mesmo
ponto de injeção que `src/server.js` usa para o socket real.

## Auth State

Ver `docs/gateway-whatsapp-auth-state-instrumentacao.md` no repo principal
para a instrumentação real (rodando `initAuthCreds()` do próprio pacote,
sem rede) que embasou o formato de `src/authState.js` e a decisão de schema
da migration 083 (`whatsapp_conexoes`, blob monolítico — não uma tabela por
chave).

## Deploy (Render Private Service) — proposta, não provisionada

Não criado neste checkpoint. Antes de provisionar, revisar: custo, plano,
região, env vars, network boundary, health check, comportamento em deploy —
ver o relatório do Checkpoint C0/C1 no histórico do projeto.
