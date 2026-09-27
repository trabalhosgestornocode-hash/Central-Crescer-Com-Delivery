# iFood — arquitetura de autenticação

> Princípio: **Order, Events, Merchant e Financial NÃO dependem do tipo de autenticação.**
> Eles pedem um token por **uma interface única**; quem decide de onde ele vem é o *Auth Provider*.

```
                 AUTH PROVIDER  (ifoodAuthProvider.js + ifoodToken.service.js)
                        │
                 getAccessToken()
        ┌───────────────┼───────────────┬───────────────┐
      Merchant        Financial        Events          Order
   (hoje)            (hoje)          (Checkpoint B)   (Checkpoint C)
```

Porta única: `ifoodToken.service.js#comAccessTokenValido({ conexaoId, appType, fn })`.
Ela escolhe o provider, entrega o token e, se a API responder 401, pede **uma** renovação
e repete a chamada **uma** vez (sem loop). O código de negócio nunca vê `authorization_code`,
`refresh_token` nem `client_credentials`.

## 1. Modelo OFICIAL atual: **Distribuído**

| | |
|---|---|
| Provider | `distributedAuthProvider` (em `ifoodToken.service.js`) |
| Fluxo | `userCode` → `authorizationCode` → `accessToken` + `refreshToken` |
| Persistência | `ifood_credenciais` (por conexão/unidade e app), tokens **cifrados** (AES-256-GCM); sessões em `ifood_oauth_sessoes` |
| Renovação | margem de 10 min; falha → `reauth_required` |
| `escopoDoToken` | `conexao` (o token pertence a uma unidade) |
| App de teste | **Teste (D)** — Distribuído — `IFOOD_TEST_CLIENT_ID/SECRET` (com `IFOOD_HOMOLOGATION_MODE=true`) |

Nada disto mudou. O produto continua distribuído: botão "Conectar iFood", tabelas de OAuth
distribuído, refresh token e reconexão permanecem como estão.

## 2. Modo TEMPORÁRIO de desenvolvimento: **Centralizado — Teste (C)**  (`centralized_test`)

Existe **somente** para desenvolver e validar tecnicamente as APIs de negócio (Events, Order,
ACK, Confirm, Ready, Dispatch, Cancelamento, Handshake) enquanto o Teste (D) está bloqueado
por permissão no iFood. **Não substitui a homologação do Teste (D)** e **não é o modelo do produto.**

| | |
|---|---|
| Provider | `criarProviderCentralizadoTeste()` (em `ifoodAuthProvider.js`) |
| Fluxo | `client_credentials` → `accessToken` (sem refresh token) |
| Endpoint | `POST https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token` |
| Corpo | `application/x-www-form-urlencoded`: `grantType=client_credentials`, `clientId`, `clientSecret` |
| Resposta | `accessToken` (JWT, ≤ 8.000 caracteres), `type: bearer`, `expiresIn: 21600` (6 h) |
| Persistência | **nenhuma.** Token só **em memória**, com cache por expiração e *single-flight*. Nunca é gravado como credencial de unidade |
| `escopoDoToken` | `app` (o token é do aplicativo, não de uma conexão/unidade) |
| Config | `IFOOD_CENTRALIZED_TEST_MODE=true`, `IFOOD_CENTRALIZED_TEST_CLIENT_ID`, `IFOOD_CENTRALIZED_TEST_CLIENT_SECRET` |

Fonte (portal iFood, conferida em 2026-09-27): *Documentações → Restaurante → Authentication →
Fluxo para aplicativos centralizados*
(`developer.ifood.com.br/pt-BR/docs/food/guides/modules/authentication/centralized`).
Padrão de URL das guias no portal novo: `/pt-BR/docs/food/guides/modules/<módulo>/<página>`.

### Regras de segurança (todas com teste)

- **Nunca reutiliza** `IFOOD_TEST_CLIENT_*` (Teste (D)). Variáveis próprias `IFOOD_CENTRALIZED_TEST_*`.
- **Nunca em produção.** Duas travas independentes:
  1. *subida* — `npm run dev:ifood-centralized-test` (e `ifood:centralized-check`) só carregam
     `.env.test-integracao` + `.env.ifood-centralized-test` e **recusam (exit 1)** se: `SUPABASE_URL`/chaves não
     forem do projeto `teste-multiempresarial`; houver `RENDER`/`NODE_ENV=production`; existirem credenciais dos apps
     **reais** (`IFOOD_ANALYTICS_*`/`IFOOD_FINANCIAL_*`); ou `IFOOD_HOMOLOGATION_MODE=true` (não mistura Teste (C) com Teste (D));
  2. *runtime* — o próprio provider chama `centralizadoTestePermitido()` antes de qualquer pedido de token
     (`ifood.ambienteTeste.js`): mesmo subindo o backend "na mão", ele se recusa.
- **Não martela o endpoint de token** (a doc do iFood avisa contra gerar token antes de expirar): cache até a margem
  de renovação, um único pedido em voo, e renovação forçada por 401 com intervalo mínimo de 30 s.
- Client secret e token **nunca** são logados (teste captura o console).
- `render.yaml` **não** recebe nenhuma variável do modo centralizado.

## 3. Futuro possível: centralizado em produção

Só se o produto passar a precisar dele (decisão de negócio + de segurança, não técnica). Como Order/Events/Financial
só usam a interface comum, bastaria um provider centralizado **de produção** (credenciais do app real, sem as travas de
teste) — o código de negócio não muda. Hoje isso **não** está previsto nem habilitado.

## 4. O que depende do tipo de autenticação (e o que não)

| Camada | Depende? |
|---|---|
| Events / Order / Merchant / Financial (chamadas HTTP, parsers, estados) | **Não** |
| Resolução `merchantId → unidade → organização` (multi-tenant) | **Não** (vem do vínculo, não do token) |
| Onde o token mora e como renova | **Sim** — só dentro do provider |
| Fluxo de conexão na UI ("Conectar iFood": userCode/authorizationCode) | **Sim** — exclusivo do distribuído |

**Resolvido no Checkpoint B (banco de teste):** no modo centralizado o tenant vem de uma linha de `ifood_conexoes` ligando o merchant da loja
sandbox à unidade de teste — o **binding temporário de homologação centralizada** (não é OAuth distribuído; ver `docs/ifood-events-worker.md`).

**appType `order`:** Events/Order pedem o token com `appType = "order"` (nunca `financial`). No `centralized_test` usam o token do app centralizado;
no `distributed` usarão a credencial `order` real quando existir. O CHECK de `app_type` foi ampliado pela migration 101.

## 5. Checklist explícito — **PENDENTE — TESTE (D) DISTRIBUÍDO**

Tudo o que o modo temporário **não** prova e que será repetido com o Teste (D) quando o ticket do iFood for resolvido:

- [ ] `userCode` (gerado com sucesso em 2026-09-27 — `POST /oauth/userCode` HTTP 200; autorização no Portal **bloqueada por permissão**)
- [ ] `authorizationCode` colado e trocado por token
- [ ] `accessToken` obtido e gravado **cifrado** em `ifood_credenciais` (banco de teste)
- [ ] `refreshToken` obtido e gravado cifrado
- [ ] refresh (renovação real) e `reauth_required`
- [ ] Merchant com token **distribuído** (`GET /merchants` + vínculo `merchantId → unidade`)
- [ ] Financial com token distribuído
- [ ] Events com token distribuído
- [ ] Order com token distribuído
- [ ] E2E completo (pedido normal e cancelado)
- [ ] **Homologação oficial**

Resultados obtidos com o Teste (C) serão sempre rotulados **"VALIDAÇÃO TÉCNICA CENTRALIZADA"**, nunca como homologação.
