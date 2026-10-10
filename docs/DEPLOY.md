# Deploy — Subway Saci (GitHub + Render)

## Pré-requisitos
- Banco Supabase já criado, com `schema.sql`, a migration de RLS e os seeds rodados.
- As 3 chaves do Supabase em mãos (Project Settings → API):
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (secreta), `SUPABASE_ANON_KEY` (pública).

## 1. Enviar para o GitHub
Na raiz do projeto:
```bash
git init
git add .
git commit -m "Subway Saci — MVP (CMV, painel, auth)"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/subway-saci.git
git push -u origin main
```
> ✅ O `.gitignore` garante que `node_modules/` e `.env` (com a chave secreta) **não** subam.
> Confirme depois no GitHub que **não existe** um arquivo `backend/.env` no repositório.

## 2. Criar o serviço no Render
1. Acesse **https://render.com** → **New +** → **Blueprint**.
2. Conecte sua conta do GitHub e selecione o repositório `subway-saci`.
3. O Render lê o `render.yaml` e propõe um **Web Service** (`subway-saci`). Confirme.
4. Em **Environment**, defina as 3 variáveis (as `sync: false` do blueprint):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`  ← a chave **secreta**
   - `SUPABASE_ANON_KEY`
   (`DEFAULT_ORG_ID` e `DEFAULT_UNIDADE_ID` já vêm preenchidas.)
5. **Create** → o Render roda `npm ci` e inicia o servidor com `node src/server.js`. Ao terminar, você recebe uma URL
   `https://subway-saci.onrender.com` (HTTPS automático).

> Sem usar o blueprint? Crie um **Web Service** manual apontando para o repo, com
> **Root Directory:** `backend`, **Build:** `npm ci`, **Start:** `node src/server.js`,
> **Health Check Path:** `/health`, e as mesmas variáveis de ambiente.
>
> **Não use `npm start` como Start Command.** O Render encerra a instância com SIGTERM, e o npm não repassa
> o sinal ao Node: o backend não faz o encerramento gracioso (o poller do iFood Events continua consultando
> até o processo ser morto, e o lease vence em vez de ser liberado). Com `node src/server.js` o sinal chega.

## 3. Criar o primeiro admin (em produção)
As mesmas contas do Supabase valem em produção. Você pode criar o admin de duas formas:
- **Localmente**, apontando para o mesmo Supabase (seu `.env` já aponta):
  ```bash
  cd backend
  node --env-file=.env scripts/criar-admin.js admin@suaempresa.com SenhaForte123 "Admin"
  ```
- Ou pelo **Shell do Render** (aba Shell do serviço): rode o mesmo comando **sem** `--env-file`
  (as variáveis já estão no ambiente):
  ```bash
  node scripts/criar-admin.js admin@suaempresa.com SenhaForte123 "Admin"
  ```

## Observações
- **Serviço único:** o backend serve a API **e** o frontend estático — não precisa de outro serviço.
- **Free tier do Render** "dorme" após inatividade; a primeira requisição depois disso demora alguns segundos.
- **CORS/HTTPS:** o Render entrega HTTPS por padrão; como front e API são a mesma origem, não há problema de CORS.
- Antes de produção "de verdade", considere reativar o **helmet CSP** e criar **políticas de RLS** completas (defesa em profundidade).
