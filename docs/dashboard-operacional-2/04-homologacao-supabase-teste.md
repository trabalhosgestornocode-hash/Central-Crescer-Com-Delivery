# Dashboard Operacional 2.0 — Homologação no Supabase de TESTE

> Projeto `teste-multiempresarial` (`wiqqsxnysbzhcrzrrean`, us-east-1, Postgres 17.6). **Produção** é `uqybgauuxcrqzquultfu` e **não** foi alterada.
> Execução em 30/10/2026. Nenhum deploy, push, merge, envio de WhatsApp, ação sobre pedido real, troca de credencial ou retenção de dados.

## 1. Pré-voo: identidade, isolamento e ausência de tráfego de produção

Todas as consultas do pré-voo foram só de leitura e retornaram apenas agregados.

| Verificação | Resultado |
|---|---|
| Identidade | Ref `wiqqsxnysbzhcrzrrean`, nome `teste-multiempresarial`, diferente da ref de produção. O script de homologação **recusa** qualquer outra ref e recusa explicitamente a de produção. |
| Eventos iFood | Último `received_at` em 30/09/2026; **0 nas últimas 24 h**. O lease do poller está parado desde 30/09. |
| Pedidos iFood | 10 no total (massa de teste antiga) |
| Comunicação | 0 mensagens em 7 dias |
| Autenticação | 0 logins em 7 dias; nenhuma sessão de contexto criada em 24 h |
| Conexões ao banco | Só PostgREST, pg_net, pg_cron scheduler e exporter, ou seja, nenhum worker da aplicação conectado |
| Unidades | 1 marcada como teste. As fixtures desta homologação usam o prefixo `[OP2]` e foram criadas do zero (nada `[OP2]` existia antes). |
| Migrações | 15 registradas, sem a 127. Por isso a 131 **não se aplica** a este banco (ela se recusa sem a 127). |
| Privilégios antes da 129 | Fotografados por tabela e papel para recuperação exata. Antes da 129, `anon`/`authenticated` tinham todos os privilégios nas tabelas iFood, o que é justamente o achado S-1. |

**Conclusão do pré-voo:** identidade e isolamento comprovados, sem tráfego de produção. Etapa liberada.

## 2. Migrations aplicadas no teste

| Migration | Resultado |
|---|---|
| 129 — privilégios mínimos iFood | aplicada (`success`) |
| 130 — camada analítica, fechamento e simulações | aplicada (`success`) |
| 131 — metas do Checklist × transferência | **não aplicada**: o banco não tem a 127, e a 131 se recusa a rodar sem ela. Homologada no Postgres descartável com a cadeia real da `main` (ver `02-homologacao.md`). |

**Impressão digital:** md5 das definições de funções, triggers e CHECKs e dos privilégios por coluna. É **idêntica** à do Postgres local montado a partir dos arquivos (`mt_branch`); nada ficou aplicado pela metade.

## 3. PostgREST + RLS com o service real (40/40)

Script `backend/scripts/operacional-homologacao-supabase-teste.mjs`. Ele lê as chaves de um arquivo de env do **teste** sem imprimi-las, apaga variáveis de IA e WhatsApp, e cria fixtures sintéticas: 2 empresas, 3 unidades, 49 pedidos, 458 eventos e 2 disputas, todos com prefixo.

- **Fechamento** pela RPC real: REGISTRADO v1 CONSOLIDADO com os mesmos números da homologação local (35/32/3; tempos 16 / 13,9 / 29,9 com 29 amostras; cancelamentos, disputas, descontos e clientes iguais).
  - Como não há metas (sem a 127), os atrasos aparecem como **não avaliados, com o motivo escrito**; nada é inventado.
  - Fuso da plataforma, com a origem gravada na versão.
- **Idempotência:** gerar de novo sem mudança dá SEM_MUDANCA.
- **Concorrência real pelo PostgREST:** duas gerações simultâneas do mesmo dia resultaram em REGISTRADO + SEM_MUDANCA, com **uma** versão.
- **Lista e Ficha 360°:** 35 pedidos reais + 1 de teste; a ficha mostra 10 eventos. Nenhum dado pessoal (fictícios plantados) na lista, na ficha ou nas linhas gravadas. O tenant está correto em todas as 48 linhas projetadas.
- **Isolamento:** ficha e fechamento de outra unidade da mesma empresa e de outra empresa dão **404**. O fechamento da outra unidade só enxerga o pedido dela.
- **WhatsApp:**
  - prévia pronta (898 caracteres), transporte `noop`, `envioReal=false`;
  - a simulação é registrada uma vez, e repetir não duplica;
  - o banco **recusa** `transporte='baileys'` mesmo vindo do `service_role` (CHECK).
- **Imutabilidade:** o `service_role` não reescreve conteúdo nem apaga fechamento (`permission denied`), e não move fechamento para empresa que não é a da unidade (trigger).
- **Excel** gerado a partir do fechamento lido pelo PostgREST (44 KB).
- **anon pela API HTTP:**
  - SELECT negado em `operacional_pedidos`, `operacional_fechamentos`, `operacional_mensagens_simuladas`, `operacional_projecao_cursor`, `ifood_pedidos`, `ifood_eventos`, `ifood_disputas`, `ifood_conexoes` e `ifood_credenciais`;
  - RPC de fechamento negada; INSERT em simulações negado; DELETE em `ifood_pedidos` negado.

## 4. Papel `authenticated` (como o PostgREST o usa): 14/14 negados

Teste com `set role authenticated` e claims de usuário, cada tentativa isolada e sem gravar nada: SELECT nas tabelas iFood e operacionais, RPC de fechamento, INSERT, UPDATE, DELETE e TRUNCATE. Todas deram `42501`.

## 5. Transferência real de unidade compatível com a 130

A unidade sintética `[OP2] A2` foi transferida da empresa A para a B pela função real de transferência, como `service_role`:

- `operacional_fechamentos` foi remapeada (1 linha);
- o hash do conteúdo do fechamento ficou **idêntico** antes e depois (`3612db51…`); só a organização mudou.

## 6. O que ficou no projeto de teste

- **Removidos:** pedidos, eventos, disputas, projeção e cursor sintéticos.
- **Mantidos como evidência:** fechamentos e simulações sintéticas, nas empresas e unidades `[OP2]`. Eles são imutáveis por desenho, inclusive para o `service_role`; apagá-los exigiria o dono do banco, e isso não foi feito.
- **Migrations:** 129 e 130 continuam aplicadas no teste. Rollbacks disponíveis: `129_rollback.sql` e `130_rollback.sql`. O rollback da 130 apaga fechamentos e simulações.

## 7. Limites desta homologação

- Sem a 127 no teste, metas e atrasos por meta não foram exercitados pelo PostgREST; foram exercitados localmente (`operacional-fechamento`, 24/24).
- A 131 não pôde ser aplicada no teste pelo mesmo motivo; foi provada no Postgres descartável com a cadeia real da `main`.
- Não houve comparação com dados reais de um dia encerrado; isso exige leitura de produção e fica como pendência de implantação.
