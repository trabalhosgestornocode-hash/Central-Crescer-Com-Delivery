# iFood — conexão de pedidos (Order) sem Financial e vínculo manual da loja

Checkpoint 6E.4. Complementa `ifood-events-piloto-escopo.md`.

## Por quê

O aplicativo distribuído de pedidos (`central-ccd`) tem Order e Events homologados, mas não tem o módulo
Merchant, e o Financial é outro aplicativo. O fluxo antigo só vinculava a loja pela Merchant API com o token
Financial — uma unidade só com o app de pedidos ficava sem caminho.

## Fluxo do gestor

1. **Conectar pedidos** — Integrações → iFood → Operação (só unidades em `IFOOD_ORDER_PILOT_UNITS`).
2. **Autorizar o aplicativo** — código de vínculo aprovado no Portal do Parceiro iFood.
3. **Informar o ID da loja** — copiado do Portal do Parceiro (36 caracteres).
4. **Conferir os dados** — o responsável confere o ID e confirma.
5. **Validação final** — feita pelo suporte da plataforma, em janela acompanhada.

O painel nunca mostra "Conectado" nem Eventos "Ativo" antes da etapa 5. Até lá os pedidos não chegam.

## Estados do vínculo (`ifood_merchant_vinculos`, migration 116)

| Estado | Significado | Quem muda |
|---|---|---|
| `informado` | ID digitado | gestor |
| `aguardando_validacao` | ID conferido pelo responsável | gestor |
| `validado` | validação final concluída; merchant gravado em `ifood_conexoes` (conexão `ativa`) | suporte, com a flag |
| `rejeitado` | o iFood não reconhece a loja na autorização, ou a loja já é de outra unidade | sistema |
| `cancelado` | ID trocado, desistência ou conexão desfeita | gestor / sistema |

Enquanto o vínculo não é `validado`, `ifood_conexoes.merchant_id` fica vazio e a conexão `pendente`: o poller
de Events (que só lê conexões `ativa` com merchant) não enxerga a unidade. Nada é apagado — cada tentativa
fica como histórico (quem, quando, resultado).

## Rotas (`/api/v1/integracoes/ifood`, permissão `integracoes.gerenciar`)

| Rota | Chama o iFood? | Flag |
|---|---|---|
| `POST /merchants/manual` | não | — |
| `POST /merchants/manual/conferir` | não | — |
| `DELETE /merchants/manual` | não | — |
| `POST /merchants/manual/verificar-autorizacao` | **sim** (uma consulta de eventos restrita à loja) | `IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED=true` |
| `POST /merchants/manual/validar` | não | `IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED=true` |

Organização e unidade vêm sempre do contexto da sessão — nunca do corpo. A interface só usa as duas primeiras.

## Validação final (não executar sem autorização específica)

Pré-requisitos: migration 116 aplicada, flag ligada, Gestor de Pedidos aberto e acompanhado na loja.

1. `verificar-autorizacao` — consulta de eventos com o token Order da própria unidade, só para a loja informada.
   - 403 citando a loja → `rejeitado`.
   - resposta positiva → registra a evidência; o estado **continua** `aguardando_validacao`.
   - Os eventos devolvidos são descartados: nada é gravado e não há ACK.
   - A consulta pode manter a loja aberta por alguns minutos (heartbeat do iFood).
   - Freio: no máximo 3 consultas por vínculo, com 10 minutos entre elas; 3 rejeições em 24 h bloqueiam novas tentativas.
2. `validar` — exige a evidência acima (até 24 h), o ID reenviado idêntico e as duas declarações explícitas:
   `evidenciaPortalParceiro: true` e `confirmacaoOperacional: true`.

Resposta positiva do iFood **não prova a identidade da loja**: o mesmo dono pode ter várias lojas na mesma
autorização. A prova é a conferência no Portal do Parceiro e a comparação do primeiro pedido com o Gestor.

## O que não mudou

- Poller, processamento de eventos e pedidos, ACK e lease.
- Vínculo pela Merchant API com o token Financial (`POST /merchants/link`) e as conexões existentes.
- OAuth (`/oauth/start`, `/oauth/complete`): já aceitava o app Order sem loja; só a interface escondia o botão.

## Ordem de publicação

O merge na `main` dispara deploy automático no Render. A ordem segura é **estrutura primeiro, código depois**:

1. **Aplicar a migration 116 em produção** (com autorização). É só aditiva — uma tabela nova, sem alterar
   nenhuma existente — e fica inerte enquanto o código não é publicado. Conferir:
   ```sql
   select to_regclass('public.ifood_merchant_vinculos') is not null as tabela,
          (select relrowsecurity from pg_class where oid = to_regclass('public.ifood_merchant_vinculos')) as rls,
          has_table_privilege('anon', 'public.ifood_merchant_vinculos', 'select') as anon_le,          -- esperado: false
          has_table_privilege('service_role', 'public.ifood_merchant_vinculos', 'select,insert,update') as backend_ok;
   ```
2. **Merge do PR** (deploy automático), com `IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED` e
   `IFOOD_EVENTS_EMBEDDED_ENABLED` ausentes ou diferentes de `true`.
3. **Smoke tests** (abaixo).
4. Gestor conecta os pedidos, informa e confere a loja.
5. Em janela acompanhada, com autorização específica: ligar a flag de validação, verificar a autorização,
   validar e só então ligar o Events.

Compatibilidade se a ordem for invertida (código antes da migration): o status continua respondendo (a leitura
do vínculo é tolerante à tabela ausente e nem acontece para unidades sem o app de pedidos), a desconexão
funciona e as rotas de vínculo respondem 503 "ainda não está disponível neste ambiente". Nada quebra para as
unidades existentes, mas o gestor da unidade piloto veria esse erro ao informar a loja — por isso a migration vem antes.

### Smoke tests depois do deploy

- `GET /health` → `ifoodEvents: disabled`.
- Log de boot: `events.embutido_desabilitado`; nenhum `events.lote`, `events.ack` ou `merchant_manual.*` inesperado.
- Unidade com Financial (ex.: North Shopping): tela de Integração iFood igual a antes, loja vinculada, sem etapa nova.
- Unidade fora do piloto: Pedidos "Ainda não disponível para esta unidade".
- Unidade piloto (com a allowlist configurada): botão "Conectar pedidos" visível sem loja vinculada.
- `POST /merchants/manual/verificar-autorizacao` e `/validar` → 403 (`IFOOD_VALIDACAO_NAO_HABILITADA`).
- Banco: `select estado, count(*) from ifood_merchant_vinculos group by 1;` → vazio até o gestor informar a loja.

### Contingência

- **Problema no código:** reverter o commit do merge e deixar o deploy automático publicar. A tabela pode ficar:
  sem o código ninguém a lê.
- **Problema na migration:** `116_rollback.sql` remove a tabela. Ele recusa (e não remove nada) se houver
  vínculo `validado`, porque nesse caso o merchant já está em `ifood_conexoes` e o histórico só existe ali.
- **Vínculo errado ainda não validado:** o gestor usa "Corrigir o ID" (o anterior fica como `cancelado`) ou
  desconecta a integração. Nenhum pedido foi recebido nesse estado.
- **Loja validada por engano:** desconectar a integração da unidade (a conexão vira `revogada` e o poller
  deixa de enxergá-la no ciclo seguinte) e seguir o kill switch de `ifood-events-piloto-escopo.md`.

## Validação externa da loja — o que vale e o que não vale

- Resposta HTTP 200 ou 204 do iFood **não comprova sozinha a identidade da loja**. Ela só diz que a
  autorização cobre aquele ID; o mesmo dono pode ter várias lojas na mesma autorização.
- O ID tem de ser conferido no **Portal do Parceiro** pelo responsável da unidade.
- A consulta real de eventos usada na validação exige **autorização específica e supervisão**: ela fica
  desligada (`IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED`), pode manter a loja aberta por alguns minutos e, se o
  ID estiver errado, conta como consulta a loja não autorizada (infração no iFood).
- `excludeHeartbeat=true` **não é usado**: só está documentado para integrações de logística, e a
  aplicabilidade a este aplicativo não foi confirmada oficialmente.
