# iFood — ambiente de homologação (sandbox) local

> Escopo: rodar **OAuth → Merchant → vínculo com a unidade → Financial API** contra o
> iFood de teste, usando **exclusivamente o Supabase de teste**. Sem Order/Events.

## 1. Banco de teste

| | |
|---|---|
| Projeto Supabase | `teste-multiempresarial` (`wiqqsxnysbzhcrzrrean`) |
| Produção (NUNCA usar aqui) | `Crescer Com Delivery` (`uqybgauuxcrqzquultfu`) |
| Migration 056 (iFood) | conferida em 2026-09-26: 3 tabelas, colunas, constraints, índices, RLS e policy idênticos à `056_ifood_integracao.sql` |
| Módulo `ifood` contratado por alguma empresa | **nenhuma** — sem isso `requireModulo("ifood")` responde 403; liberar pelo Painel SuperAdmin (tela de Acessos) para a empresa de teste |

## 2. Aplicativo iFood de teste

```
APP ESPERADO:        Teste (D)
TIPO:                Distribuído   (fluxo userCode + authorizationCode, o implementado)
CLIENT ID ESPERADO:  93e719…52b0   (36 caracteres — comparar com o Portal do Desenvolvedor)
STATUS DA CONFIRMAÇÃO: NÃO COMPROVADO — aguarda conferência visual no Portal
```

`Teste (C)` é **Centralizado** (`client_credentials`): não funciona com este código.
O secret nunca é registrado aqui.

## 3. Como subir

```bash
cd backend
npm run dev:ifood-homolog      # http://localhost:3055
```

O comando carrega **somente**:

1. `backend/.env.test-integracao` — `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` do projeto de teste;
2. `backend/.env.ifood-homolog` — `IFOOD_HOMOLOGATION_MODE=true`, `IFOOD_TEST_CLIENT_ID`, `IFOOD_TEST_CLIENT_SECRET`, `IFOOD_TOKEN_SECRET` (exclusivo de teste), `PORT=3055`.

O `backend/.env` (produção) **não** é carregado. Ambos os arquivos acima são ignorados pelo Git (`.env.*`).

### Por que existe uma trava (`scripts/ifoodHomologGuard.mjs`)

`node --env-file=A --env-file=B` **não isola**: o último arquivo vence por chave, mas chaves
que só existem no primeiro **permanecem** (mistura parcial), e variáveis exportadas no shell
vencem os dois arquivos. Antes de subir, o script exige:

- host de `SUPABASE_URL` = projeto de teste (produção é recusada explicitamente);
- chaves em JWT legado: claim `ref` = projeto de teste;
- chaves no formato novo (`sb_publishable_…` / `sb_secret_…`): prova ativa — um `GET`
  somente-leitura ao projeto de teste (chave de outro projeto recebe HTTP 401);
- `IFOOD_HOMOLOGATION_MODE=true`, app de teste e `IFOOD_TOKEN_SECRET` (≥ 16);
- `IFOOD_API_BASE_URL` vazia ou `merchant-api.ifood.com.br`.

Se qualquer item falhar, **nada é iniciado** (exit 1). Testes: `backend/test/ifood-homolog-guard.test.js`.

## 4. O que o modo de homologação faz

Com `IFOOD_HOMOLOGATION_MODE=true`, `credenciaisDoApp()` devolve o app de teste para
`analytics` **e** `financial`; o `app_type` gravado no banco continua `analytics`/`financial`
(o CHECK não muda; `order` não existe). O header `x-request-homologation: true` só sai
quando o chamador pede (o service Financial pede sempre). `GET /status` expõe apenas o
booleano `homologacao` (badge na tela).

## 5. Antes do primeiro OAuth real (gate)

- [ ] `Teste (D)` conferido no Portal: Client ID = `93e719…52b0`
- [ ] Empresa de teste com o módulo `ifood` contratado
- [ ] Usuário `organization_admin` ou `unit_manager` na unidade de teste
- [ ] `npm run dev:ifood-homolog` sobe sem recusar
