# iFood Order/Events — autoatendimento universal

Branch `feat/ifood-order-autoatendimento` (PR #52). **Desligado por padrão** (`IFOOD_ORDER_SELF_SERVICE_ENABLED=false`). Nenhuma migration nova: usa a 116 (vínculo de loja), a 117 (lojas adicionais) e a 124 (finalidade da conexão), que já estão em produção.

## 1. Por que hoje é manual

Três controles do piloto exigem alguém de suporte para cada unidade:

| Controle do piloto | Onde fica | O que ele garante |
|---|---|---|
| `IFOOD_ORDER_PILOT_UNITS` (lista de unidades no Render) | `orderLiberadoParaUnidade` (OAuth, status, vínculo) e o escopo do poller | só unidades aprovadas conectam e são consultadas |
| O gestor digita o ID da loja e confere | `ifoodMerchantVinculo.service.js` (estados informado → aguardando_validacao) | a loja é a da unidade |
| Validação acompanhada: flag `IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED` + duas declarações | `verificarAutorizacao` / `concluirValidacao` | o iFood autorizou a loja; um humano conferiu no Portal |

## 2. O que substitui cada controle (equivalente ou mais forte)

| Antes | Agora |
|---|---|
| Lista de unidades | `IFOOD_ORDER_SELF_SERVICE_ENABLED=true` **+** o módulo `ifood` da unidade (gate da rota `/integracoes/ifood`) **+** a permissão `integracoes.gerenciar` (Administrador da empresa ou Gestor da unidade). O tenant vem sempre de `req.tenant`. Durante a homologação, `IFOOD_ORDER_SELF_SERVICE_UNITS` restringe a quem está na lista (seção 7). |
| ID digitado + conferência | a loja é a que **o próprio iFood declarou** no token Order desta autorização (claim `merchant_scope` com `order` **e** `events`). Só entram lojas **livres**: não são a loja principal de outra conexão viva, nem loja adicional de nenhuma conexão (117), nem estão num vínculo aberto de outra conexão. Várias lojas livres: o gestor escolhe por uma referência opaca (o ID inteiro nunca vai para a tela). Mais de 10 lojas no token: pede para autorizar só a da unidade. |
| Verificação + declarações | a **mesma** verificação de antes: uma consulta de eventos só daquela loja, com o token da própria conexão, **sem gravar e sem ACK**, com o mesmo freio (3 tentativas por vínculo, 10 min entre elas, 3 rejeições por dia). A promoção passa pela **mesma** `concluirValidacao` (índice único de merchant, compare-and-set). |
| Unidade na lista = consultada pelo poller | o poller consulta: piloto **∪** unidades **liberadas** com vínculo `validado` de uma conexão `ativa` com o **mesmo** merchant e unidade. Lido a cada ciclo (sem restart). Falha nessa leitura = só o piloto. |

O modo automático é um `Symbol` do servidor (`MODO_AUTOATENDIMENTO`): não existe forma de pedir "pular as declarações" pela requisição.

### Conexão que já tem loja

- **Unidade do piloto (Saci, North) ou já ativada:** nunca é alterada; o status diz *Conectado*.
- **Conexão `legado` cuja loja veio da Merchant API (Analytics/Financial) e que acabou de receber o Order:** a loja é **a dela**. O token Order precisa cobri-la, e a mesma verificação roda antes de a unidade entrar no poller. Nome e razão social da Merchant API não são regravados. Se o token cobrir outra loja: *Ação necessária* (`LOJA_CONECTADA_FORA_DO_TOKEN`), sem trocar nada.
  - Isto corrige um erro da 1ª versão do PR: ela mostrava *Conectado* sem a unidade estar no poller.

## 3. Fluxo do usuário

1. Admin da empresa (ou gestor da unidade) abre **Integração iFood** → card **Pedidos**: *Não conectado* (ou *Desconectado em …*) → **Conectar pedidos iFood**.
2. Assistente oficial do iFood (código no Portal do Parceiro): *Aguardando autorização*.
3. Ao concluir, a Central identifica a loja pelo token, verifica no iFood e ativa:
   - **Conectado — aguardando o primeiro pedido**: a conexão está ativa, mas o recebimento ainda não foi comprovado;
   - **Conectado — recebendo pedidos**: já chegou pedido desta loja à Central (recebimento **comprovado**);
   - **Validando loja**: a confirmação no iFood está pendente. A tela mostra **Verificar novamente** ou, durante o intervalo de segurança, "Nova verificação a partir de HH:MM";
   - **Ação necessária**: a tela mostra a mensagem certa e o botão certo:
     - escolher a loja;
     - **Reconectar pedidos iFood**: autorização expirada ou revogada, token sem loja, loja de outra unidade, loja diferente da já conectada, lojas demais no token;
     - "Desconectar e conectar de novo": 3 verificações sem sucesso.
4. Os pedidos entram no Checklist no próximo ciclo do poller.

Nenhuma mensagem mostra código técnico, merchant inteiro ou erro de banco.

## 4. Como uma empresa não conecta a loja de outra

- A loja só pode vir do token que o iFood emitiu para **esta** autorização. O corpo da requisição nunca traz merchant, organização ou unidade: só `ref`, que precisa bater com uma loja livre desse token.
- A loja que já é de outra conexão (principal ou adicional), ou que está em validação noutra conexão, é recusada antes de qualquer chamada ao iFood.
- Corrida entre duas unidades: o índice único de merchant (056) e o de vínculo aberto (116) deixam uma só vencer. A outra recebe *loja de outra unidade*.
- O duplo clique na mesma unidade gera uma consulta e uma promoção, e nenhuma mensagem falsa.
- O iFood confirma a autorização da loja com o token da própria conexão antes da promoção (403 `unauthorizedMerchants` = rejeitado).

## 5. Recuperação

| Situação | O que acontece | O que o gestor faz |
|---|---|---|
| Falha de rede/5xx na verificação | *Validando loja*, com o horário da próxima verificação | espera o horário e clica **Verificar novamente** |
| Clique dentro dos 10 min | *Validando loja*, "Nova verificação a partir de HH:MM" (sem consulta ao iFood) | espera |
| 3 verificações sem sucesso | *Ação necessária* | **Desconectar** e **Conectar pedidos iFood** (conexão nova, contagem nova) |
| iFood recusou a loja | vínculo `rejeitado` | **Reconectar** autorizando a loja certa |
| Token sem loja order+events / lojas demais | nada criado | **Reconectar** autorizando só a loja da unidade |
| Autorização expirada ou revogada no iFood (`reauth_required`) | *Ação necessária*; o poller para de usar a credencial | **Reconectar pedidos iFood** |
| Erro após o OAuth | a autorização gravada **nunca** é desfeita; vira *Validando loja* | **Verificar novamente** |
| Banco lento/fora no `/status` | resumo recuperável; o `/status` não cai | — |
| Banco lento/fora no ciclo do poller | o ciclo usa só o piloto; eventos das ativadas ficam na fila do iFood (sem ACK) até o ciclo seguinte | — |

## 6. Auditoria e logs

- `ifood.pedidos_conectados` (loja mascarada, origem `autoatendimento`, `lojaJaExistente`), `ifood.pedidos_ativacao_pendente` (motivo), `ifood.pedidos_desconectados`.
- Logs `order_autoatendimento.*`. O merchant aparece sempre mascarado; o token nunca aparece.

## 7. Liberação controlada: só a Feiraguay primeiro

`IFOOD_ORDER_SELF_SERVICE_UNITS` é uma lista **temporária**, de homologação. Não é uma etapa por conexão:

- **Durante a homologação:** a lista contém só a Feiraguay (`4fd38803-c91d-48dc-b2a8-d27d659eddcb`). Nenhuma outra unidade vê "Conectar pedidos iFood", consegue OAuth Order ou entra no poller por ativação. O piloto (Saci, North) continua como está.
- **Depois da homologação aprovada:** esvaziar a lista. A partir daí, qualquer empresa com o módulo `ifood` conecta sozinha. O controle por empresa passa a ser o módulo `ifood` em **Acessos**, que é um clique do administrador da plataforma, não um ajuste técnico.
- **Restringir a lista de novo:** a unidade sai do escopo no ciclo seguinte. Nada é apagado.

Antes de esvaziar a lista, rodar a leitura de alcance (`alcance-autoatendimento.mjs`, somente leitura). Ela lista quem a flag global abriria: módulo `ifood` efetivo, alguém com `integracoes.gerenciar` e sem Order.

## 8. Publicação e homologação: sequência, parada e reversão

**Nada disto foi executado.** Cada passo 🔒 é escrita em produção ou no Render e precisa de autorização explícita no dia.

| # | Passo | Quem | Pronto quando | Parar se | Reverter |
|---|---|---|---|---|---|
| 1 | Revisão do PR #52 aprovada | você | review sem bloqueio; CI/testes verdes | qualquer achado de segurança aberto | — |
| 2 | 🔒 Merge supervisionado | você | `main` com o commit; testes da `main` verdes | conflito ou teste vermelho | `git revert` do merge |
| 3 | 🔒 Deploy com a flag **desligada** | você | deploy `live`; logs sem erro de boot | erro de boot, worker sem lease | redeploy do commit anterior |
| 4 | Smoke (leitura) | eu, via script seu | Saci e North recebendo pedidos como antes (último pedido, lease, sem novos erros); `/status` da Saci igual; `IFOOD_ORDER_SELF_SERVICE_ENABLED` ausente/false | qualquer diferença na Saci/North | passo 3 → redeploy anterior |
| 5 | 🔒 Módulo `ifood` para a Feiraguay (empresa **e** unidade), **sem remover** o Checklist | você em Acessos | módulos efetivos = `checklist_operacional` + `ifood_dashboard` + `ifood`; Checklist abre normal | Checklist some/quebra | remover só o `ifood` da Feiraguay |
| 6 | 🔒 Render: `IFOOD_ORDER_SELF_SERVICE_UNITS=4fd38803-c91d-48dc-b2a8-d27d659eddcb` **e depois** `IFOOD_ORDER_SELF_SERVICE_ENABLED=true` (nessa ordem, no mesmo deploy) | você | leitura de alcance: só a Feiraguay liberada; Saci/North iguais ao passo 4 | outra unidade vê "Conectar pedidos iFood" | `IFOOD_ORDER_SELF_SERVICE_ENABLED=false` |
| 7 | OAuth oficial | operador da Feiraguay, com você | assistente concluído | erro na autorização | nada a reverter (nenhuma loja ativada) |
| 8 | Ativação automática | a Central | conexão `ativa`, vínculo `validado`, auditoria `ifood.pedidos_conectados`, tela *Conectado — aguardando o primeiro pedido* | *Ação necessária* com loja de outra unidade, ou qualquer mudança na Saci/North | **Desconectar** a Feiraguay pela tela |
| 9 | 1º pedido real | loja | pedido da Feiraguay no Checklist **da Feiraguay**, em nenhuma outra unidade; ACK no log; tela *Conectado — recebendo pedidos* | pedido em outra unidade, evento sem ACK repetindo, erro no poller | desligar a flag (passo 6) **combinando com a loja** (ver riscos) |
| 10 | Monitoramento 24–72 h | eu, via script seu | Saci, North e Feiraguay com pedidos, lease estável, sem `events.*` de erro novos | regressão em qualquer uma | flag off; se preciso, redeploy anterior |

**Critérios separados:**
- **Conexão ativa:** passo 8 conferido.
- **Recebimento comprovado:** passo 9, com pedido real.

Sem pedido real, o resultado é "conectada, recebimento não comprovado". Nenhuma evidência é simulada.

Depois do passo 10 aprovado, esvaziar a lista (🔒), conforme a seção 7.

Rollback sem apagar dados: Desconectar pela tela ou flag off. Não usar os rollbacks da 116/123.

## 9. Riscos residuais

- **Parar o polling de uma loja ativada** (flag off, sair da lista, Desconectar) faz a Central deixar de consultar os eventos dessa loja. O polling é o que mantém a integração "viva" para o iFood. Antes de qualquer reversão na Feiraguay, combinar com a loja como ela recebe pedidos naquele momento.
- **A Central não confirma pedidos automaticamente** (o `confirm` só existe como ação manual). A loja continua aceitando pedidos como hoje (Gestor de Pedidos/tablet). Confirmar isso com o operador da Feiraguay antes do passo 7.
- **Fim da homologação:** com a lista vazia, o controle por empresa é o módulo `ifood`. Quem já tem o módulo, um gestor e nenhum Order pode conectar sozinho (é o objetivo); a leitura de alcance mostra quem é.
- **Token sem `merchant_scope`:** se o iFood passar a emitir token opaco, o autoatendimento para de ativar (*Ação necessária*), mas nunca liga a loja errada.
- **Saci e North continuam pelo piloto.** A leitura de 21/10 confirmou vínculo `validado` com a mesma loja nas duas (Saci: conexão `legado`; North: `pedidos_producao`). Mesmo assim, enquanto `IFOOD_ORDER_SELF_SERVICE_UNITS` restringir a liberação (ou a flag estiver desligada), elas dependem de `IFOOD_ORDER_PILOT_UNITS`: o escopo por ativação só vale para unidades liberadas. Não tirá-las do piloto antes de a lista ser esvaziada, e então reconferir.
- **Exposição ao esvaziar a lista (leitura de 21/10):** só **Açaí no Grau Saci** ficaria apta (módulo `ifood`, 1 gestor, sem Order). Quatro unidades inativas do Grupo Jailton e Vanessa (Florianópolis 1–3, Rio Poty) têm `ifood` e ficariam aptas se reativadas.
- **Erro do iFood numa loja já ativa** (ex.: 403): mantém o comportamento atual do poller, sem mudança aqui.
