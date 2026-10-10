# iFood Events — escopo do piloto (IFOOD_ORDER_PILOT_UNITS)

Complementa `ifood-fase1-piloto-runbook.md`. Checkpoint 6D.

## Regra

O poller de Events só trabalha para as unidades listadas em `IFOOD_ORDER_PILOT_UNITS` (ids de unidade, UUID).

| Situação | Comportamento |
|---|---|
| Lista vazia ou ausente | Nenhuma loja é consultada. Nenhum token é pedido ou renovado. Nenhum ACK. Estado do ciclo: `SEM_MERCHANTS`. |
| Unidade fora da lista | Sem polling, sem token, sem ACK, sem reprocessamento de pendentes, sem busca de Order Details. |
| Conexão nova de outra unidade | Não entra sozinha. Só entra quando o id da unidade for incluído na variável. |
| Modo centralizado (`centralized_test`) | Mesmo filtro: o lote de merchants só leva lojas de unidades da lista. |
| Empresa, merchant ou id de conexão na variável | Não autorizam nada. O único critério é o `unidade_id` da conexão. |

A lista vale para os dois hosts (embarcado no Web Service e worker dedicado): os dois montam o mesmo poller.

## O que acontece com dados já recebidos

Mudar a lista **não apaga e não altera** nada.

- Eventos já gravados de uma unidade que saiu da lista ficam como estão (`RECEBIDO`/`FALHOU` continuam pendentes,
  sem gastar tentativas). Se a unidade voltar à lista, o reprocessamento os retoma.
- Pedidos já gravados permanecem. Detalhes pendentes dessa unidade deixam de ser buscados.
- Eventos novos dessa loja ficam no iFood sem ACK deste aplicativo. O iFood guarda eventos por tempo limitado:
  o que não for consultado dentro dessa janela não chega mais ao sistema (não é uma perda causada por descarte
  nosso; é a consequência de parar de consultar).

## Quando a mudança passa a valer

A variável é lida **no boot** do processo. Alterar `IFOOD_ORDER_PILOT_UNITS` no Render só tem efeito depois do
deploy/restart que a alteração provoca. Não há interrupção instantânea:

1. o ciclo em andamento termina com a lista com que começou (inclusive o ACK do que ele já gravou);
2. durante o deploy, a instância antiga e a nova coexistem por alguns segundos; o lease garante que só uma
   consulta por vez, e cada uma usa a própria lista;
3. a partir do primeiro ciclo da instância nova, só a lista nova vale.

## Disponibilidade da loja

O polling a cada 30 s é o que mantém a loja **aberta** no iFood para este aplicativo. Parar de consultar uma
loja (tirá-la da lista, esvaziar a lista ou desligar o Events) faz o iFood considerá-la sem conexão por este app
em poucos minutos. Se o Gestor de Pedidos (ou outro integrador) estiver aberto, a loja continua aberta por ele.
Por isso: **nunca tirar uma loja do piloto sem confirmar que o Gestor de Pedidos está aberto nela**.

## Kill switch (ordem recomendada)

Não presumir que mudar uma flag no Render interrompe na hora um worker em execução.

1. Confirmar com a loja que o Gestor de Pedidos está aberto e recebendo pedidos.
2. Escolher o alcance:
   - parar **uma loja**: remover o id da unidade de `IFOOD_ORDER_PILOT_UNITS`;
   - parar **tudo**: `IFOOD_EVENTS_EMBEDDED_ENABLED=false` (e/ou esvaziar a lista — as duas travas são independentes).
3. Salvar e aguardar o deploy terminar (a alteração de variável dispara o deploy).
4. Conferir, nesta ordem:
   - `/health` → `ifoodEvents` (com a flag desligada: `disabled`);
   - logs: `events.conexoes_fora_do_piloto` / `events.sem_merchants` e ausência de `events.lote` para a loja;
   - tabela `ifood_poller_lease`: titular da instância nova (ou lease vencido, com o Events desligado).
5. Só então considerar o polling interrompido. Até o passo 4, tratar como ainda ativo.

Reverter é o caminho inverso: recolocar o id na lista (ou religar a flag), aguardar o deploy e conferir os logs.

## Verificação somente leitura da produção (pendente de acesso)

A executar por quem tem acesso ao Supabase de produção, **apenas SELECT**, sem imprimir segredos:

```sql
-- 1. Migrations 101–103 aplicadas (tabelas e colunas existem)
select to_regclass('public.ifood_eventos') is not null as m101_eventos,
       to_regclass('public.ifood_pedidos') is not null as m101_pedidos,
       to_regclass('public.ifood_poller_lease') is not null as m101_lease;
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'ifood_pedidos'
   and column_name in ('details_status', 'action_state', 'action_uncertain', 'ready_requested_at');

-- 2. Conexão e credencial Order da unidade do piloto (sem tokens)
select c.id, c.status, c.merchant_id is not null as tem_merchant, k.app_type, k.status as credencial,
       k.expira_em
  from ifood_conexoes c left join ifood_credenciais k on k.conexao_id = c.id
 where c.unidade_id = '<id da unidade>';

-- 3. Estado do Events
select nome, holder, lease_ate, geracao from ifood_poller_lease;
select processing_status, count(*) from ifood_eventos group by 1;
select unidade_id, count(*) from ifood_pedidos group by 1;
```

No Render (somente leitura): presença — nunca o valor — de `IFOOD_ORDER_CLIENT_ID`, `IFOOD_ORDER_CLIENT_SECRET`,
`IFOOD_ORDER_PILOT_UNITS`, `IFOOD_EVENTS_EMBEDDED_ENABLED`, `IFOOD_ORDER_DETAILS_ENABLED`, `IFOOD_CENTRALIZED_TEST_MODE`, `IFOOD_HOMOLOGATION_MODE`.
Os nomes das colunas das consultas 2 e 3 devem ser conferidos com as migrations antes de executar.
