# iFood Order/Events — autoatendimento universal

Branch `feat/ifood-order-autoatendimento`. **Desligado por padrão** (`IFOOD_ORDER_SELF_SERVICE_ENABLED=false`). Nenhuma migration nova: usa a 116 (vínculo de loja) e a 117 (lojas adicionais), que já estão em produção.

## 1. Por que hoje é manual

Três controles do piloto exigem alguém de suporte para cada unidade:

| Controle do piloto | Onde fica | O que ele garante |
|---|---|---|
| `IFOOD_ORDER_PILOT_UNITS` (lista de unidades no Render) | `orderLiberadoParaUnidade` (OAuth, status, vínculo) e o escopo do poller | só unidades aprovadas conectam e são consultadas |
| O gestor digita o ID da loja e confere | `ifoodMerchantVinculo.service.js` (estados informado → aguardando_validacao) | a loja é a da unidade |
| Validação acompanhada: flag `IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED` + duas declarações | `verificarAutorizacao` / `concluirValidacao` | o iFood autorizou a loja; um humano conferiu no Portal |

## 2. O que substitui cada controle (equivalente ou mais forte)

| Antes | Agora (com a flag) |
|---|---|
| Lista de unidades | uma flag do ambiente **+** o módulo `ifood` da unidade (gate da rota `/integracoes/ifood`) **+** a permissão `integracoes.gerenciar`. O tenant vem sempre de `req.tenant`. |
| ID digitado + conferência | a loja é a que **o próprio iFood declarou** no token Order desta autorização (claim `merchant_scope` com `order` **e** `events`). Só entram lojas **livres**: que não são a loja principal de outra conexão viva, nem loja adicional de nenhuma conexão (117), nem estão num vínculo aberto de outra conexão. Várias lojas livres: o gestor escolhe por uma referência opaca (o ID inteiro nunca vai para a tela). |
| Verificação + declarações | a **mesma** verificação de antes: uma consulta de eventos só daquela loja, com o token da própria conexão, **sem gravar e sem ACK**, com o mesmo freio (3 tentativas, 10 min entre elas, 3 rejeições por dia). A promoção passa pela **mesma** `concluirValidacao` (índice único de merchant, compare-and-set). |
| Unidade na lista = consultada pelo poller | o poller consulta: piloto **∪** unidades com vínculo `validado` de uma conexão `ativa` com o **mesmo** merchant e unidade. Lido a cada ciclo (sem restart). Falha nessa leitura = só o piloto. |

O modo automático é um `Symbol` do servidor (`MODO_AUTOATENDIMENTO`): não existe forma de pedir "pular as declarações" pela requisição.

## 3. Fluxo do usuário

1. Admin da empresa abre **Integração iFood** da unidade → card **Pedidos**: *Não conectado* → botão **Conectar pedidos iFood**.
2. Assistente oficial do iFood (código no Portal do Parceiro): *Aguardando autorização*.
3. Ao concluir, a Central identifica a loja pelo token, verifica no iFood e ativa:
   - *Conectado — recebendo pedidos* (ou *Conectado* enquanto o worker não confirma recebimento ao vivo);
   - *Validando loja* + **Verificar novamente** (falha transitória do iFood);
   - *Ação necessária* com a mensagem certa: escolher a loja, reconectar (token sem loja, loja de outra unidade, iFood recusou, autorização expirada) ou aguardar o limite de verificações.
4. Os pedidos entram no Checklist no próximo ciclo do poller.

Desconectar: igual a antes (conexão revogada, credenciais apagadas, vínculos cancelados) + auditoria `ifood.pedidos_desconectados`. A tela volta a *Não conectado*; reconectar cria uma conexão nova.

## 4. Como uma empresa não conecta a loja de outra

- A loja só pode vir do token que o iFood emitiu para **esta** autorização; o corpo da requisição nunca traz merchant, organização ou unidade (só `ref`, que precisa bater com uma loja livre desse token).
- Loja que já é de outra conexão (principal ou adicional) ou está em validação noutra conexão: recusada antes de qualquer chamada ao iFood.
- Corrida entre duas unidades: o índice único de merchant (056) e o de vínculo aberto (116) deixam uma só vencer; a outra recebe *loja de outra unidade*.
- O iFood confirma a autorização da loja com o token da própria conexão antes da promoção (403 `unauthorizedMerchants` = rejeitado).
- Conexão que já tem loja (Saci, North, qualquer unidade do piloto) nunca é alterada pelo autoatendimento.

## 5. Recuperação

| Situação | O que acontece | O que o gestor faz |
|---|---|---|
| Falha de rede/5xx na verificação | `validando_loja`, nada promovido | **Verificar novamente** (após 10 min) |
| iFood recusou a loja | vínculo `rejeitado` | reautorizar com a loja correta |
| Token sem loja order+events | nada criado | reautorizar escolhendo a loja |
| Credencial `reauth_required` | *Ação necessária* | **Reconectar pedidos iFood** |
| Erro após o OAuth | a autorização gravada **nunca** é desfeita; vira `validando_loja` | **Verificar novamente** |
| Desligar a flag | volta exatamente ao piloto; unidades ativadas deixam de ser consultadas no ciclo seguinte (nada é apagado) | — |

## 6. Auditoria e logs

- `ifood.pedidos_conectados` (loja mascarada, origem `autoatendimento`), `ifood.pedidos_ativacao_pendente` (motivo), `ifood.pedidos_desconectados`.
- Logs `order_autoatendimento.*`; o merchant aparece sempre mascarado, o token nunca.

## 7. Plano supervisionado — Feiraguay (prova final)

**Nada disto foi executado.** Cada passo marcado 🔒 é escrita em produção e precisa da sua autorização explícita no dia.

Pré-condições (leitura):
1. PR revisado e mergeado; deploy publicado (🔒 merge e deploy).
2. Migrations 116 e 117 aplicadas (já estão).
3. Worker de Events ligado e saudável (Saci recebendo pedidos no dia).
4. Saci e North: anotar o estado atual (conexão, merchant, último pedido) para comparar depois.

Ativação:
5. 🔒 Habilitar o módulo `ifood` para a Feiraguay (empresa e unidade) em **Acessos**. Hoje ela só tem `checklist_operacional` + `ifood_dashboard`, e a rota exige `ifood`.
6. 🔒 Render: `IFOOD_ORDER_SELF_SERVICE_ENABLED=true` (vale para o ambiente inteiro; o piloto continua valendo para a Saci/North). Alternativa mais restrita para a 1ª prova: manter a flag desligada e só incluir a Feiraguay em `IFOOD_ORDER_PILOT_UNITS`. Isso, porém, não testa o autoatendimento.
7. Você (com o dono da loja) clica **Conectar pedidos iFood** e autoriza no Portal do Parceiro. Eu não faço essa etapa.
8. Leitura: conexão da Feiraguay `ativa` com a loja mascarada esperada; vínculo `validado`; auditoria `ifood.pedidos_conectados`; Saci e North idênticas ao passo 4.

Critérios (separados):
- **Conexão ativa**: os itens do passo 8 conferem.
- **Recebimento de pedidos comprovado**: só depois de um pedido REAL da Feiraguay aparecer no Checklist da Feiraguay (e em nenhuma outra unidade), com o evento reconhecido (ACK) no log do worker. Sem pedido real, o resultado é "conectada, recebimento não comprovado". Nenhuma evidência é simulada.

Rollback (sem apagar dados): desconectar a Feiraguay pela tela **ou** desligar a flag (🔒). Não usar o rollback da 116/123.

## 8. Riscos residuais

- A flag é **por ambiente**: ligada, qualquer unidade com módulo `ifood` e gestor com `integracoes.gerenciar` pode conectar. O controle por empresa passa a ser o módulo `ifood` em Acessos.
- Habilitar o módulo `ifood` pode liberar outras telas iFood da unidade além de Pedidos; conferir no passo 5 antes de ligar.
- Token Order sem o claim `merchant_scope` (formato opaco) não ativa: cai em *Ação necessária*. Se o iFood mudar o formato do token, o autoatendimento para de ativar (fail-closed). Ele nunca ativa a loja errada.
- O limite de verificações aparece como *Ação necessária* também no clique imediato após uma falha. A mensagem pede para tentar mais tarde.
- Depois de desconectar, a tela mostra *Não conectado* (não há um estado "revogado" separado); a trilha fica na auditoria.
- Um 403 do iFood numa loja já ativa continua com o comportamento atual do poller (registro de erro e nova tentativa), sem mudança aqui.
- As ações de pedido (confirmar/despachar) seguem o comportamento já existente para lojas ativas; o autoatendimento não as liga nem desliga.
