# Camada central Foody — piloto em sombra (código local)

> Fase: **código pronto, testado e documentado, sem produção.** Nada foi aplicado em banco de produção, nada foi publicado,
> nenhuma flag foi ligada. Nenhum indicador, tela, mensagem ou agente consome estes dados.
> Base: `origin/main` 6ce0c26 · branch `feat/foody-camada-central` (worktree local) · validação real em `docs/foody-validacao-real-api.md`.

## 1. O que foi entregue

| Peça | Arquivo | Papel |
|---|---|---|
| Migration aditiva | `database/migrations/144_foody_camada_central.sql` | 4 tabelas `foody_*`, triggers de tenant/vínculo/imutabilidade, função `foody_fechamento_registrar`, RLS sem policy |
| Rollback | `database/migrations/144_rollback.sql` | remove só objetos `foody_*`; idempotente |
| Constantes e catálogos | `backend/src/modules/foody/foody.constants.js` | status, pagamento, razão, `courierType`, estados de valor, flags |
| Flags | `foody.flags.js` | fail-closed: mestre + allowlist; agendador exige as duas + allowlist |
| Segurança | `foody.seguranca.js` | cifra do token por unidade (AAD), impressão, HMAC do entregador, `foodyLog` com redação |
| Período | `foody.periodo.js` | hora de parede, janela [D 00:00, D+1 00:00), D-1..D-3, congelamento |
| Cliente API | `foody.client.js` | **só GET** em `/orders?`, paginação + dedupe por uid, espaçamento, retentativa 429/5xx/rede, erro classificado sem token |
| Adaptador | `foody.adapter.js` | lista branca sem dado pessoal; operação pelo `classificarOperacao` do Parser; formato de pedido do Parser |
| Cálculo | `foody.fechamento.calc.js` | regras do Parser (elegibilidade, motor de cancelamentos, resumos) + separações aprovadas |
| Repositório | `foody.repository.js` | cliente de banco injetado; todo acesso filtra organização **e** unidade |
| Sincronização | `foody.sync.service.js` | travas → execução → GET → saneamento → upsert por hash → prova de cobertura |
| Fechamento | `foody.fechamento.service.js` | versão nova só quando o conteúdo muda; consolidado alterado vira `CORRIGIDO` com motivo |
| Agendador | `foody.agendador.js` | fail-closed, **não ligado no `server.js`**, D-1..D-3 por unidade, erro isolado |
| Conexão | `foody.conexao.js` | monta a linha de conexão (nasce `PAUSADA`, token cifrado); não grava |

## 2. Regras implementadas

- **Somente leitura na API:** um único ponto de chamada HTTP, `method: "GET"` fixo, sem corpo, host `app.foodydelivery.com/rest/1.2`, rota `/orders?startDate&endDate` (a rota documentada com barra responde 404).
- **Janela:** `startDate` inclusivo e `endDate` exclusivo (comprovado na API real). O dia D vai de `D 00:00:00-03:00` até `D+1 00:00:00-03:00`. A próxima página recomeça no `date` do último pedido, e o pedido de fronteira, que se repete, é deduplicado por `uid`. Uma página cheia sem avanço de data é erro (`PAGINACAO_SEM_PROGRESSO`), nunca cobertura parcial silenciosa.
- **Hora de parede:** todas as datas são gravadas como `timestamp` sem fuso, em horário de Brasília, igual ao Parser. A chave dos overrides não quebra.
- **Sem dado pessoal:** o registro gravado é uma lista branca. Cliente, telefone, endereço, observações, rastreio, coordenadas e o nome do entregador não entram; o nome vira HMAC-SHA256 com chave fora do banco, truncado a 16 hex. Campo novo da API é ignorado.
- **Multi-tenant:**
  - uma conexão por unidade;
  - o token é cifrado com AAD = `foody:token:<unidade_id>`: copiado para outra unidade, não decifra;
  - a impressão do token é conferida antes de qualquer chamada;
  - toda consulta filtra `organizacao_id` e `unidade_id`;
  - as linhas recebem o tenant do contexto, nunca do payload;
  - triggers no banco recusam unidade de outra organização e vínculo com execução ou conexão de outra unidade.
- **Outras operações (decisão aprovada):** pedido de Açaí despachado pela conta Subway fica na unidade dona da conta, marcado `operacao = acai_no_grau`. No fechamento ele vai para `outras_operacoes`, com quantidade, taxas identificadas e tipo de entregador, e `somadoAoCustoDaUnidade: false`. Não há rateio e nada é gravado no tenant do Açaí.
- **`courierType` em catálogo fechado:**
  - `internal` → `proprio`;
  - qualquer outro valor → `nao_classificado`, que vira pendência e fica fora do custo próprio;
  - sem nome de entregador → `sem_entregador`, fora de tudo.

  A `courierFee` de pedido sem entregador é só contada (taxa prevista).
- **Estados de valor:**
  - taxas brutas → `SINCRONIZADO`;
  - taxas válidas → `PROVISORIO` enquanto houver cancelamento em revisão, entregador não classificado, operação em dúvida, status desconhecido, taxa ausente ou cobertura incompleta; senão `SINCRONIZADO`;
  - `CONCILIADO` e `CUSTO_REAL` ficam reservados para fases futuras (o custo real é `null`, nunca inventado).
- **Idempotência:** o pedido só é regravado quando o `fonte_hash` muda (primeira execução preservada, última atualizada). O fechamento só ganha versão nova quando muda o hash, o status ou o estado. Mesma `execucao_id` → `JA_REGISTRADO`.
- **Pedido que some da API:** nunca é apagado; vira pendência `PEDIDO_AUSENTE_NA_API`. O `service_role` nem tem DELETE nas tabelas.
- **Congelamento:** só D-1..D-3 são reprocessáveis. Dia mais antigo exige `origem = reprocessamento` e motivo; hoje e o futuro são recusados.
- **Fechamento em tabela própria:** a camada usa `foody_fechamentos_logisticos`, e não `operacional_fechamentos`, para que uma versão nova nunca vire `REVISADO` nem acione aviso de correção no WhatsApp.

### 2.1 Dependência do nome do ponto de coleta

A API Foody não devolve um identificador do ponto de coleta, só o nome (`collectionPoint.name`), que o lojista pode editar.

**Comportamento implementado:**
- `ponto_coleta_esperado` é **opcional** e o padrão é `null`, sem filtro. O token pertence à conta da unidade, e todo pedido da conta é dela. Esse é o modo recomendado para contas com um único ponto, como a Subway Saci hoje.
- Quando ele está definido, a comparação ignora caixa, acento e espaços extras. Renomear "Subway Saci" para "SUBWAY  SACI" não perde pedido.
- Pedido de outro ponto **não é gravado** na unidade, porque pode ser de outra loja da mesma conta. Mesmo assim, nunca há perda silenciosa:
  - a contagem fica na execução (`pedidos_ponto_divergente`);
  - a cobertura do dia passa a **incompleta**, e o fechamento sai `INCOMPLETO` / `PROVISORIO`;
  - a pendência `PONTO_COLETA_DIVERGENTE` traz até 5 nomes de ponto vistos, para o gestor identificar a renomeação.
- O pedido não se perde: ele continua na Foody e volta a entrar no próximo reprocessamento (D-1..D-3) depois que o nome esperado for corrigido. Passados 3 dias, entra por reprocessamento explícito com motivo.

**Alternativas seguras, para decidir antes de usar o filtro em contas com vários pontos:**
1. **Preferida:** perguntar à Foody se há um identificador estável do ponto (ou um token por ponto) e filtrar por ele, nunca pelo nome.
2. Usar um **token por ponto de coleta**, se a Foody permitir. Aí o filtro deixa de ser necessário.
3. Criar uma **quarentena:** gravar os divergentes numa tabela própria, sem tenant de destino, para revisão manual e reatribuição auditada. Exige migration nova e não foi feito nesta fase.

Nunca rotear automaticamente por nome para outra unidade ou organização.

## 3. Flags (todas desligadas por padrão)

| Variável | Efeito |
|---|---|
| `FOODY_CENTRAL_ENABLED` | flag mestre; só `true` exato liga |
| `FOODY_CENTRAL_UNIDADES` | allowlist de `unidade_id` (UUIDs por vírgula); vazia = nenhuma |
| `FOODY_CENTRAL_AGENDADOR_ENABLED` | agendador; exige também a mestre e a allowlist |
| `FOODY_CENTRAL_SECRET` | ≥ 32 caracteres; deriva (HKDF) a chave do token e a do HMAC. Sem ele, o módulo falha fechado |

> O registro destas variáveis no `backend/.env.example` não foi feito: a edição do arquivo `.env*` foi bloqueada pela política
> de permissões da sessão. Adicionar manualmente, se desejado.

## 4. Testes

```
cd backend
node --test test/foody-central-unidade.test.js test/foody-central-sync.test.js test/foody-central-arquitetura.test.js
# Postgres LOCAL descartável (pula sem a variável):
CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/foody-central-migration-pg.test.js
```

| Arquivo | O que prova |
|---|---|
| `foody-central-unidade.test.js` (31) | flags fail-closed; janela/hora de parede/congelamento; cifra por unidade; HMAC; redação de log; cliente só GET, paginação com dedupe, erro sem token, retentativa; adaptador sem PII; cálculo (próprio × não classificado, Açaí separado, estados, pendências, hash determinístico) |
| `foody-central-sync.test.js` (26) | travas antes de qualquer chamada; isolamento (token de B na conexão de A não decifra, org errada não acha conexão, cada unidade com o próprio token e tenant, filtro de tenant em toda consulta); dedupe/idempotência; pedido ausente vira pendência; ponto de coleta divergente deixa o dia INCOMPLETO, normalização de nome, sem filtro por padrão; falha da API registrada sem token; versionamento REGISTRADO → SEM_MUDANCA → CORRIGIDO; agendador |
| `foody-central-arquitetura.test.js` (14) | nenhum método HTTP de escrita; host/rota únicos; nenhum import de WhatsApp/notificações/checklist/agente/serviços externos; só tabelas `foody_*`; **nenhum arquivo do sistema importa o módulo**; `server.js` não menciona Foody; migration aditiva, RLS sem policy, sem grant a anon/authenticated; rollback coerente |
| `foody-central-migration-pg.test.js` (9) | schema real completo + 144 num Postgres local: triggers de tenant e vínculo, unicidade, token cifrado obrigatório, regras da função de registro, imutabilidade, privilégios por papel, **transferência de unidade** com as tabelas `foody_*`, rollback e reaplicação |

Paridade local, com os pedidos reais saneados da validação (sem PII, fora do repositório): 30/30 comparações iguais ao pipeline do Parser, que por sua vez bateu 100% com os relatórios exportados.

**Regressão:**
- **Suíte completa do backend:** 6.164 testes; 16 falham e 3 são cancelados, exatamente os mesmos (lista idêntica) do `origin/main` 6ce0c26 limpo, que tem 6.093 testes. Nenhuma falha nova.
- **Testes com Postgres real:** os 24 arquivos que montam o schema real (que agora inclui a 144) dão 262/264. As 2 falhas também ocorrem sem a 144.
- **Testes existentes alterados:** só dois, `comunicacao-arquitetura-agendamento.test.js` e `ifood-migration-103.test.js`. Eles mantêm a lista das migrations conhecidas, e a 144 foi registrada nelas, como as 140–143 fizeram.

## 5. Fora do escopo desta fase

- consumidores: Parser, Dashboard, Checklist, Performance, Agente, WhatsApp;
- telas e rotas HTTP;
- cadastro real de conexão;
- ligar flags ou o agendador;
- aplicar a migration em produção.

Cada um desses itens exige autorização própria (ver o checklist de GO/NO-GO no relatório da fase).
