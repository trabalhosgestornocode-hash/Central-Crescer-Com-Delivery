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

## Runbook de implantação (cada passo exige autorização específica; ids e URLs reais ficam no runbook privado, fora do repositório)

Convenções: `$DB` = URL de conexão do banco de produção, fornecida só no momento, nunca gravada; todo `psql` usa `-X -v ON_ERROR_STOP=1`. Janela: fora do pico do jantar (18h–21h) e fora de sexta/sábado à noite.

### Passo 0 — Pré-voo (somente leitura)
- `gh pr view <PR> --json isDraft,mergeable,headRefOid` e `gh pr checks <PR>`: head = commit revisado, sem commits novos desde a revisão.
- Operador confirma no painel do Render: **Pull Request Previews = Off**, Auto-Deploy = On Commit da `main`, hash do último deploy Live.
- Backup: último backup diário do Supabase (PITR desligado: o ponto de recuperação além disso é o backup diário) e cópia local, fora do repositório, de `ifood_conexoes` (sem tokens): `\copy (select * from ifood_conexoes) to 'conexoes-AAAAMMDD.csv' csv header`.
- `node monitor-multiconexao.mjs baseline` (lê Saci, North, poller; imprime só ids mascarados). **Parar** se o veredito não for OK.

### Passo 1 — Merge do PR (deploy automático)
- Pré-condições: Passo 0 OK; PR fora de Draft; operador na tela da Saci.
- O deploy reinicia o único serviço web, que contém o poller embarcado. Os eventos não se perdem (o iFood reentrega o que não recebeu ACK; o ACK só ocorre depois de persistir) e o lease com fencing impede dois pollers. O código só muda no poller o filtro `finalidade <> 'financeiro_homologacao'`, com repetição sem o filtro se a coluna ainda não existir: a Saci (`legado`) continua elegível.
- Evidências do operador (como no PR #47): deploy novo com o commit do merge; build sem erro; Live; logs com `Subway Saci API rodando` e `iFood Events: embarcado ATIVO`; sem `error` repetido nem reinício em laço.
- Monitorar: `node monitor-multiconexao.mjs +0 --base monitor-mc-baseline.json`, depois +15 min e +60 min. **Critério de parada:** veredito PARAR (lease sem renovar > 180 s, Saci sem evento > 10 min fora do horário morto, eventos `FALHOU` ou sem ACK, conexão que mudou ou sumiu, North com pedido/evento antes da hora). Parar = não avançar; o rollback de código é `git revert -m 1 <merge>` por decisão do operador.

### Passo 2 — Migration 124 (aditiva)
- Pré-condição: Passo 1 há pelo menos 1 h, monitor OK.
- `psql "$DB" -X -v ON_ERROR_STOP=1 -f database/migrations/124_ifood_conexao_finalidade.sql`
- Verificar (esperado): colunas existem; todas as linhas `legado|nao_informado`; **o índice antigo continua**; credenciais e conexões idênticas ao baseline.
  ```sql
  select finalidade || '|' || ambiente, count(*) from ifood_conexoes group by 1;           -- só legado|nao_informado
  select indexname from pg_indexes where indexname in ('uq_ifood_conexao_unidade_viva','uq_ifood_conexao_merchant_vivo','uq_ifood_conexao_unidade_finalidade_viva'); -- 3 linhas
  select count(*) from pg_trigger where tgname in ('trg_ifood_credencial_finalidade','trg_ifood_conexao_finalidade','trg_ifood_loja_finalidade'); -- 3
  ```
- `node monitor-multiconexao.mjs pos124 --base monitor-mc-baseline.json` deve dar OK. **Parar** em qualquer divergência; rollback: `124_rollback.sql` (nada rotulado ainda, então não é bloqueado).

### Passo 3 — Soak
- Pelo menos 24 h com código novo + 124: monitor a cada 2–4 h, incluindo o pico do jantar. Saci sem regressão (pedidos, tempos do Checklist, poller).

### Passo 4 — Rotular a conexão de teste da North (supervisionado)
- Pré-condições: Passo 3 OK; o operador confirma no Render (somente leitura) que `IFOOD_FINANCIAL_HOMOLOGATION_UNITS` contém a North (é o que a faz "separar" as conexões; fora da lista o Order dela seria recusado com `IFOOD_FINALIDADE_NAO_SUPORTADA`) e que `IFOOD_ORDER_PILOT_UNITS` a contém (necessário só no Passo 6); homologação do Financial íntegra (status da North conectado, token financeiro renovando); aprovação específica.
- Snapshot ANTES (linha inteira, sem tokens em claro):
  ```sql
  select md5((to_jsonb(c) - 'finalidade' - 'ambiente' - 'atualizado_em')::text) from ifood_conexoes c where id = '<UUID da conexão de teste>';
  select md5(string_agg(k::text, '|' order by app_type)) from ifood_credenciais k where conexao_id = '<UUID da conexão de teste>';
  ```
- `psql "$DB" -X -v ON_ERROR_STOP=1 -v conexao=<UUID> -v finalidade=financeiro_homologacao -v confirmo_homologacao=sim -f database/operacoes/ifood-conexao-rotular.sql`
- Rodar de novo o snapshot: **os dois hashes têm de ser iguais**. Conferir `finalidade|ambiente = financeiro_homologacao|homologacao` e que a Saci continua `legado`.
- Parar se o script abortar (nada é gravado) ou se qualquer hash mudar; reverter com `ifood-conexao-rotular-rollback.sql`.

### Passo 5 — Migration 125 (remove o índice antigo) — aprovação específica
- Pré-condições (todas): 124 aplicada há ≥ 24 h; código novo no ar; conexão de teste da North rotulada e verificada; monitor OK; **nenhuma** unidade com conexão `legado` esperando um segundo app; aprovação escrita do operador.
- `psql "$DB" -X -v ON_ERROR_STOP=1 -f database/migrations/125_ifood_conexao_remove_indice_unidade.sql`
- Verificar: `uq_ifood_conexao_unidade_viva` ausente; `uq_ifood_conexao_merchant_vivo` e `uq_ifood_conexao_unidade_finalidade_viva` presentes; nenhuma linha alterada (monitor OK). Rollback: `125_rollback.sql`.

### Passo 6 — Loja real da North (fora deste PR, com autorização própria)
- OAuth do Order pelo dono da loja (cria a conexão `pedidos_producao`), vínculo manual do Merchant ID real com as flags existentes, conferir `conexoes` no status, poller e Checklist. Parar se a conexão de teste mudar em qualquer campo.

## Rollback — condições de bloqueio (testadas em banco descartável)

| Script | Bloqueia quando | O que fazer antes |
|---|---|---|
| `125_rollback.sql` | alguma unidade tem 2+ conexões vivas | revogar a conexão extra (ação supervisionada) |
| `124_rollback.sql` | há conexão **viva** rotulada; ou unidade com 2+ vivas; ou sessão OAuth pendente com finalidade | `ifood-conexao-rotular-rollback.sql`; `125_rollback.sql`; aguardar/cancelar a sessão |
| `ifood-conexao-rotular-rollback.sql` | a unidade tem **outra** conexão viva | revogar/ajustar a outra antes |
| `124_rollback.sql` (linhas revogadas rotuladas) | não bloqueia (histórico) | — |

Ordem completa: revogar a extra → `125_rollback.sql` → desrotular → `124_rollback.sql`.

## Rollback (ordem inversa)

Revogar a conexão extra (se existir) → `125_rollback.sql` → `ifood-conexao-rotular-rollback.sql` → `124_rollback.sql`. Cada script **se recusa** a rodar se isso apagasse a distinção entre conexões. Código: `git revert -m 1` do merge (o código antigo ignora as colunas novas).

## Riscos residuais

- Financial **de produção** em unidade que já tem conexão de pedidos separada e não está na lista de homologação → `IFOOD_FINALIDADE_NAO_SUPORTADA` (não há finalidade `financeiro_producao`).
- A decisão "unidade separa" depende da env `IFOOD_FINANCIAL_HOMOLOGATION_UNITS`; remover a unidade da lista antes de classificar as conexões muda o destino do Order.
- O Order da North depende de `IFOOD_ORDER_PILOT_UNITS`, do OAuth do dono da loja e do Merchant ID real (nada disso é feito por este código).
