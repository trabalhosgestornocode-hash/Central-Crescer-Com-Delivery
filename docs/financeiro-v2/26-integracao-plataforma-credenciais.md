# Financeiro v2 — 26. Integração com a plataforma (Etapa C), gateway, credenciais e provisionamento

Data: 14/11/2026. Branch local `feat/financeiro-v2-producao`. **Situação: NÃO PUBLICADO.** Nada foi aplicado no
Supabase nem no Render; nenhum segredo foi gerado, pedido ou versionado.

## 1. O que foi implementado (local, testado no PostgreSQL isolado)

| Peça | Arquivo | Comportamento |
|---|---|---|
| Rotas `/api/financeiro-v2` | `backend/src/modules/fv2-integracao/rotas.js`, `consultas.js` | Montadas em `routes.js` **depois** de `requireAuth` + `requireContexto`. **Desligadas por padrão** (`FV2_HABILITADO` ≠ `1` ou configuração incompleta): `/status` responde "não liberado" e as consultas 404. **Somente leitura** (qualquer método ≠ GET → 405). 27 consultas (Visão Geral, DRE, composição, contas, posição a receber, caixa, fluxo, calendário, vendas, conferências, fechamento, configurações, permissões) |
| Contrato da sessão | adaptador do núcleo (`integracao/plataforma.js`) | A cada requisição: impersonação, perfil de exibição, conta compartilhada, pessoa sem identidade, unidade não autorizada / não liberada, sessão expirada, contexto divergente e **concessão própria do v2** (SuperAdmin e papel `finance` não contam). Token tem de ser da mesma conta da sessão |
| Portas da plataforma | `portasPlataforma.js` | `perfis_operacionais` (pessoa → conta, ativa), `usuarios_unidades` (pessoa → unidades), contagem de pessoas por conta; erro de leitura = falha fechada |
| MFA real | `mfaPeloProvedor.js` | O token é validado **no Auth do projeto** (`auth.getUser`), o `sub` tem de ser a conta devolvida pelo provedor; recência pelo carimbo do **fator** em `amr` (≤ 10 min) — `aal2` sozinho e o `iat` NÃO provam recência |
| Cliente do gateway | `clienteGateway.js`, `canalGateway.js` | Porta `sessoes` do repositório: pede a sessão de banco ao gateway por canal **assinado** (HMAC, ±60 s, nonce único), levando o token do usuário |
| Gateway separado | `backend/src/fv2-gateway/` | Único processo com a credencial de autoridade. Confere canal, **valida o token no provedor**, aplica a política (escopo = sessão, validade ≤ 15 min, ≤ 5 min sensível, MFA recente nas finalidades sensíveis) e o banco confere a concessão (FV020). Registros sem segredos |

Testes novos: `integracao-http.test.js` (ponta a ponta com gateway real em processo), `integracao-mfa-config.test.js`.

## 2. Gateway no Render (A-3) — viabilidade e custo (nada contratado)

- **Viável** no workspace atual: já existe o mesmo padrão (`gateway-whatsapp`: *Private Service*, sem URL pública,
  região Ohio, plano `0.5c-512mb`/Starter). O gateway do v2 seria outro *Private Service* do mesmo repositório,
  `rootDir: backend`, comando `node src/fv2-gateway/servidor.js`, porta 10000, alcançado pelo backend só pela rede
  privada (`http://<nome-interno>:10000`; o cliente recusa HTTP em endereço público).
- **Custo adicional:** uma instância do plano Starter de *Private Service* (preço público do Render; confirmar o valor
  no painel antes de criar). Nenhum outro serviço muda de plano.
- Banco: o Render não sai por IPv6; usar o **pooler** do Supabase (região `us-west-2`) com os papéis de login próprios.

## 3. Credenciais (A-4) — você executa; nada passa por mim nem pelo Git

**Nomes exatos** criados pela instalação: `fv2_app` (operação), `fv2_autoridade` (gateway), `fv2_guardiao` (dono das
funções protegidas; nunca recebe login). Os papéis de **login** são criados por você, depois da instalação:

```sql
-- no editor SQL (sem senha aqui)
create role fv2_app_login login noinherit connection limit 4;
grant fv2_app to fv2_app_login with inherit true;
alter role fv2_app_login set search_path = financeiro_v2, pg_catalog;
create role fv2_autoridade_login login noinherit connection limit 2;
grant fv2_autoridade to fv2_autoridade_login with inherit true;
alter role fv2_autoridade_login set search_path = financeiro_v2, pg_catalog;
```

Senha: **não** digitar no editor SQL (o texto da consulta pode ficar no histórico). No seu computador, conectado como
`postgres` pelo `psql`, use `\password fv2_app_login` e `\password fv2_autoridade_login` (o psql pede a senha sem
eco e envia só o hash).

Variáveis no Render (valores só no painel):

| Serviço | Variável | Conteúdo |
|---|---|---|
| backend `crescercomdelivery` | `FV2_HABILITADO` | `0` até a ativação |
| | `FV2_APP_DATABASE_URL` | URL do pooler com `fv2_app_login` |
| | `FV2_GATEWAY_URL` | `http://<nome interno do gateway>:10000` |
| | `FV2_GATEWAY_CHAVE` | 64 caracteres aleatórios (ex.: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| | `FV2_PG_CA` | certificado-raiz do Supabase (público, do painel) |
| gateway (novo) | `FV2_AUTORIDADE_DATABASE_URL` | URL do pooler com `fv2_autoridade_login` |
| | `FV2_GATEWAY_CHAVE` | a mesma do backend |
| | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | os mesmos públicos do projeto (só para validar o token) |
| | `FV2_PG_CA`, `PORT=10000` | |

A credencial `fv2_autoridade_login` **nunca** vai para o backend comum (há teste que impede o código da integração de
ler `FV2_AUTORIDADE*`).

## 4. Provisionamento da administradora financeira do Açaí no Grau Saci (A-5) — procedimento

1. Você indica a **pessoa** (perfil operacional individual, conta pessoal, com **TOTP ativo** e vínculo ativo com a
   unidade). Nenhuma conta é escolhida automaticamente.
2. Um **atestante** com autoridade administrativa na empresa (tipo aceito: administrador da empresa), autenticado com
   TOTP nos últimos 10 min, atesta: não pode ser a própria pessoa nem outra pessoa da mesma conta; o atestante NÃO
   recebe acesso financeiro.
3. O gateway confere o token do atestante no provedor e a prova de segundo fator; o banco grava a concessão inicial e
   a auditoria (`fv2_abrir_sessao_de_provisionamento`).
4. A liberação da unidade (empresa + unidade) é outro ato sensível, também com TOTP recente, pela autoridade.

**Ainda falta implementar** (desenvolvimento, sem depender de você): as duas ações sensíveis acima por rota (POST,
com MFA) e a interface do v2 apontando para `/api/financeiro-v2`. Até lá, mesmo instalado, ninguém opera o v2.

## 5. O que ainda não está liberado (por decisão de segurança)

- Escritas, uploads e abertura de arquivos: sem antimalware efetivo, o cofre fica desligado.
- Homologação e reabertura: a matriz 24a não está aprovada.
- Saldos de abertura: só com evidência (extrato) registrada pela pessoa provisionada; nada é importado do legado e
  nenhuma conta começa em zero presumido.
