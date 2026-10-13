# iFood — credenciais OAuth independentes por loja (migration 118)

Status: **implementado e testado localmente na branch `feat/ifood-credencial-por-loja`** (sobre a `feat/ifood-oauth-protecao-credencial`, PR #43).
Sem commit, sem migration em produção, sem OAuth real, sem deploy. A Saladas continua `pendente`.

## Decisão

O suporte do iFood recomenda uma autorização OAuth independente por merchant. A unidade (Subway Saci — Matriz) continua com **uma conexão**,
com a Sanduíches como loja principal e sua credencial **intocada**. A Saladas (loja adicional da 117) passa a poder ter uma credencial Order
**própria**. O modo compartilhado (uma credencial para várias lojas) continua funcionando quando for autorizado e suportado.

## Titular único da credencial de cada merchant

| Situação da loja adicional | Quem fornece o token |
|---|---|
| sem linha em `ifood_loja_credenciais` | a credencial Order da conexão (modo compartilhado, como na 117) |
| com linha `ativa` | **só** a credencial própria |
| com linha `reauth_required` | ninguém: a loja fica parada (nunca cai para o token da conexão — daria 403) |

Garantias no banco: `unique(loja_id, app_type)`; merchant vivo único (117); merchant não pode ser a principal de outra conexão (117).
No poller: cada merchant entra em **um** grupo só.

## Migration 118 (aditiva, idempotente, backend-only)

- `ifood_loja_credenciais`: tokens cifrados, `expira_em`, `status` (`ativa`/`reauth_required`), só `app_type = 'order'`; RLS sem policy; `service_role`
  só select/insert/update. Organização/unidade **derivadas da loja** por gatilho (valor forjado é substituído); loja e tenant imutáveis; loja
  `desativada` não recebe credencial.
- `ifood_oauth_sessoes.loja_id` (nula): loja-alvo da sessão; gatilho confere tenant e só aceita `order`.
- Não altera `ifood_conexoes`, `ifood_credenciais` nem a 117. Pós-condição aborta e desfaz se `anon`/`authenticated` alcançarem a tabela.
- Rollback `118_rollback.sql`: recusa se houver credencial própria `ativa`; remove tabela, coluna e funções.
- Ordem segura: o código antes da migration funciona (tabela ausente = nenhuma credencial própria). O código só usa a credencial própria quando
  existe linha nela, que só nasce pelo OAuth da loja.

## Fluxo OAuth da Saladas (só com autorização futura)

1. `POST /oauth/start` com `{ appType: "order", merchantId: "<merchant da Saladas>" }` (usuário com `INTEGRACOES_GERENCIAR`). Recusa antes de
   chamar o iFood se a loja não for uma loja adicional **desta** unidade. A sessão guarda `loja_id`.
2. O responsável digita o código no Portal do Parceiro **logado como a Saladas**.
3. `POST /oauth/complete`: o token só é aceito se declarar (`merchant_scope`) o merchant da Saladas com `order` e `events`, com validade
   > 60 s. Grava **exclusivamente** em `ifood_loja_credenciais` (troca condicional se já existir). Nunca lê nem escreve a credencial da
   Sanduíches e nunca cria/altera a conexão.
4. Autorizar **não libera** a Saladas: o estado da loja não muda. A liberação continua sendo o passo supervisionado separado
   (`database/operacoes/ifood-loja-extra-liberar.sql`).

O fluxo sem `merchantId` (conexão) continua protegido pelo PR #43: token que não cobre a Sanduíches (e as lojas compartilhadas) nunca a substitui.
A prova de cobertura é a mesma função (`coberturaDoToken`); a loja-alvo usa só o merchant dela, a conexão exclui as lojas com credencial própria.

## Token e refresh

- `lojaId` opcional em `getValidAccessToken`/`comAccessTokenValido`/refresh; single-flight por titular (loja e conexão não compartilham chave).
- **Refresh condicional** (também para a conexão): grava só se o access token ainda for o lido. Se uma credencial mais nova entrou (outra
  instância ou nova autorização), ela é preservada e o resultado da renovação é descartado.
- `reauth_required` e falhas de refresh ficam na credencial de **quem falhou**.

## Poller

- Grupos: conexões primeiro (Sanduíches prioritária), depois cada loja com credencial própria. Lease único, fencing e ACK após persistência
  inalterados; o ACK usa o token do grupo.
- Falha de autenticação, 403 e erro de ACK da Saladas isolam só o grupo dela (ciclo `PARCIAL`).
- **429 de loja própria** não encerra o ciclo (os detalhes da Sanduíches continuam): a loja entra em pausa de 120 s em memória. 429 da
  Sanduíches mantém o comportamento de sempre (ciclo encerrado).
- Loja com credencial própria sem credencial ativa ou em pausa é pulada **antes** de gastar tentativa de verificação.

## Pedidos

`obterConexaoAtivaDoMerchant` agora resolve também merchants adicionais (`ativa`/`liberada`) na conexão da unidade — antes (117) detalhes
funcionavam, mas confirmar/ações/handshake de um pedido da Saladas não achavam conexão. Quando a loja tem credencial própria devolve `lojaId`,
e detalhes, confirmação, ações e handshake usam o token da loja. Pedidos e eventos seguem na unidade, com a origem em `merchant_id`.

## Riscos que continuam

1. O iFood pode, ao autorizar a Saladas, invalidar o refresh token da Sanduíches (suporte diz que não; só a primeira autorização real prova).
   Mitigação: Gerente acompanhando, logo após um refresh normal; se falhar, reautorizar a Sanduíches pelo fluxo normal.
2. `merchant_scope` prova o que o token declara, não a aceitação pelo servidor.
3. A pausa por 429 é em memória (reinício a zera; o próximo 429 a recoloca).
4. Não existe tela para iniciar o OAuth da loja: hoje é a API (`merchantId`).
