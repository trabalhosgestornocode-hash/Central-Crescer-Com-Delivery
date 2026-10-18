# iFood — múltiplas conexões por unidade (Financial de homologação + Order de produção)

Status: **implementado só em desenvolvimento** (branch `feat/ifood-multi-conexao`). Nada foi aplicado em produção: nenhuma migration, deploy, OAuth, rotulagem de conexão ou alteração de credencial.

## Problema

Uma unidade só podia ter **uma** conexão iFood viva (`uq_ifood_conexao_unidade_viva`). A Subway North Shopping usa essa conexão para a **homologação do Financial** (loja de teste, app de teste). Conectar a loja real (Order/Events, app distribuído) exigiria desconectar a de teste — o que destruiria a homologação em andamento.

## Modelo

Cada conexão (`ifood_conexoes`) declara:

| Coluna | Valores |
|---|---|
| `finalidade` | `legado` (padrão, todas as linhas existentes) · `financeiro_homologacao` · `pedidos_producao` |
| `ambiente` | `nao_informado` (padrão) · `homologacao` · `producao` |

Regras no banco (migration **124**, 100% aditiva):

- CHECK: `financeiro_homologacao` ⇒ `homologacao`; `pedidos_producao` ⇒ `producao`; `legado` aceita qualquer.
- Índice único `uq_ifood_conexao_unidade_finalidade_viva (unidade_id, finalidade)` onde `status <> 'revogada'`.
- `uq_ifood_conexao_merchant_vivo` (um merchant em uma conexão viva) e `unique (conexao_id, app_type)` das credenciais **não mudam**.
- Trigger: `pedidos_producao` só recebe credencial `order`; `financeiro_homologacao` **nunca** recebe `order` nem loja adicional (117).
- A finalidade só muda **de/para `legado`** (rotulagem e sua reversão), nunca de uma finalidade para outra.
- `ifood_oauth_sessoes.finalidade` (nullable): a sessão OAuth carrega a finalidade da conexão-alvo.

O índice antigo **continua valendo** até a migration **125** (separada): sem ela nenhuma unidade consegue ter a 2ª conexão viva — o comportamento em produção é idêntico ao de antes.

## Seleção (nunca por ordem de registro)

`escolherConexao(vivas, finalidade)` (`ifoodFinalidade.js`):

1. finalidade exata; senão
2. a conexão `legado`, **somente se for a única viva**; senão
3. `null`. Sem finalidade: a única viva, ou `IFOOD_CONEXAO_AMBIGUA` se houver mais de uma.

Quem usa o quê:

| Consumidor | Finalidade |
|---|---|
| Financial, Merchant API, vínculo de merchant (Financial), status topo | `financeiro_homologacao` |
| OAuth Order, vínculo manual da loja, Checklist, pedidos/ações | `pedidos_producao` |
| Poller (`listarConexoesElegiveisParaEvents`, `listarConexoesComMerchant`) | tudo **exceto** `financeiro_homologacao` |
| Resolução de token por merchant (`obterConexaoAtivaDoMerchant`) | tudo exceto `financeiro_homologacao` |

A Subway Saci é `legado` e continua servindo a todos os apps sem qualquer rótulo.

## OAuth

`ifoodConexaoDestino.js` decide o destino. A unidade "separa" as conexões quando está em `IFOOD_FINANCIAL_HOMOLOGATION_UNITS`:

- unidade que **não** separa: igual a antes (conexão `legado` única; a nova nasce `legado`);
- unidade que separa: Financial/Analytics → conexão `financeiro_homologacao`; Order → conexão `pedidos_producao` (criada na 1ª autorização);
- Order numa conexão `legado` de unidade que separa **sem credencial Order** → `IFOOD_CONEXAO_LEGADA_ROTULAR` (recusa **antes** de chamar o iFood): a conexão de teste tem de ser rotulada antes.
- A sessão guarda a finalidade; a conclusão recusa sessão cuja finalidade não bate com o app (`IFOOD_LOJA_OAUTH_INVALIDO`) **antes** de trocar o código.

## Desconexão

`DELETE /integracoes/ifood/?conexaoId=<uuid>` afeta **só** a conexão informada (reconferida no tenant). Sem `conexaoId`: só vale se a unidade tem uma conexão viva; com mais de uma → `IFOOD_CONEXAO_AMBIGUA`. Cancela apenas as sessões OAuth dos apps daquela conexão.

## Interface

Com mais de uma conexão (ou alguma já classificada), o painel mostra a seção **Conexões desta unidade**: um cartão por conexão (título, ambiente, loja mascarada, credenciais, status) e o botão **"Desconectar esta conexão (…)"** com confirmação que nomeia a conexão. O "Desconectar" genérico some. Unidade com uma conexão só: tela idêntica à de antes.

## Operação (supervisionada — fora do código)

- `database/operacoes/ifood-conexao-rotular.sql` — `legado → financeiro_homologacao|pedidos_producao` (exige `-v confirmo_homologacao=sim` para o Financial). Não toca merchant, status nem credenciais.
- `database/operacoes/ifood-conexao-rotular-rollback.sql` — volta a `legado` (recusa se a unidade tem outra conexão viva).

## Plano de implantação (cada passo exige autorização própria)

1. **PR + merge** do código (Render faz deploy automático). O código é compatível com banco **sem** a 124: consultas do poller e gravação da sessão OAuth repetem sem a coluna `finalidade`.
2. **Migration 124** (aditiva). Verificar: Saci `legado/nao_informado`, contagem de conexões e credenciais idêntica, poller ativo, `select finalidade` via REST.
3. Soak (≥ 24 h) com o código novo + 124: Saci sem regressão (pedidos, tempos, poller).
4. **Rotular a conexão de teste da North** como `financeiro_homologacao` (script supervisionado). Conferir que a homologação do Financial segue (status, token, merchant).
5. **Migration 125** (remove o índice antigo) — só depois dos passos 3–4.
6. OAuth do Order da loja real da North (store owner), informar/validar o Merchant ID real pelo vínculo manual (com as flags já existentes), conferir `pedidos_producao` + poller.
7. Checklist da North passa a mostrar a conexão real.

## Rollback (ordem inversa)

Revogar a conexão extra (se existir) → `125_rollback.sql` → `ifood-conexao-rotular-rollback.sql` → `124_rollback.sql`. Cada script **se recusa** a rodar se isso apagasse a distinção entre conexões. Código: `git revert -m 1` do merge (o código antigo ignora as colunas novas).

## Riscos residuais

- Financial **de produção** em unidade que já tem conexão de pedidos separada e não está na lista de homologação → `IFOOD_FINALIDADE_NAO_SUPORTADA` (não há finalidade `financeiro_producao`).
- A decisão "unidade separa" depende da env `IFOOD_FINANCIAL_HOMOLOGATION_UNITS`; remover a unidade da lista antes de classificar as conexões muda o destino do Order.
- O Order da North depende de `IFOOD_ORDER_PILOT_UNITS`, do OAuth do dono da loja e do Merchant ID real (nada disso é feito por este código).
