# Dashboard Operacional 2.0 — Arquitetura

> Branch `feat/dashboard-operacional-2` (base `origin/main` `a035750`). Nada aplicado em produção.
> Auditoria de origem: [`docs/auditoria-ifood-order-events/`](../auditoria-ifood-order-events/README.md).

## 1. Princípios

1. **Evoluir, não duplicar.** Tudo mora no módulo existente `checklist-operacional` (backend) e no Dashboard Operacional que já existia (frontend). Não há produto novo, rota-raiz nova nem worker novo em produção.
2. **Uma fonte por número.** Tempos, atrasos e horários do fechamento vêm de `obterDashboard`, o mesmo cálculo da tela. Por isso Dashboard, fechamento armazenado, Excel, PDF e prévia de WhatsApp mostram os mesmos números (teste `fechamento — mesmos números do Dashboard`).
3. **Poller e ACK intocados.** A camada nova só **lê** `ifood_pedidos`, `ifood_eventos` e `ifood_disputas`. A única mudança em Events é o efeito local do evento `ORDER_PATCHED` (§7), sem alterar consumo nem ACK.
4. **Sem dado pessoal na camada analítica.** Nome, telefone, documento, endereço, entregador, códigos de coleta/entrega, texto de observação e dados de transação nunca entram. Testado com dados pessoais fictícios plantados no cenário sintético.
5. **WhatsApp só simulado.** O código desta entrega não importa o provider, o `WhatsAppService`, o gateway nem o Baileys (teste arquitetural). O único transporte existente é `noop`, e o banco recusa qualquer outro por `CHECK`.

## 2. Componentes

| Camada | Arquivo | Responsabilidade |
|---|---|---|
| Migration | `database/migrations/129_ifood_privilegios_minimos.sql` (+ rollback) | REVOKE de `anon`/`authenticated`/PUBLIC nas tabelas iFood; `service_role` fica com S/I/U/D, sem TRUNCATE |
| Migration | `database/migrations/130_operacional_camada_fechamento.sql` (+ rollback) | `operacional_pedidos`, `operacional_projecao_cursor`, `operacional_fechamentos`, `operacional_mensagens_simuladas` e RPC `operacional_fechamento_registrar` |
| Projeção (pura) | `checklistOperacional.projecao.js` | `ifood_pedidos` + `ifood_eventos` → linha sem PII, com linha do tempo, valores, cancelamento oficial e integridade |
| Ficha (pura) | `checklistOperacional.ficha.js` | Projeção + metas + disputas → Ficha 360° e item da lista |
| Fechamento (puro) | `checklistOperacional.fechamento.js` | Os 11 indicadores, status, pendências e hash do conteúdo |
| Diagnóstico (puro) | `checklistOperacional.diagnostico.js` | Regras determinísticas, limiares, biblioteca de ações |
| Redação (IA) | `checklistOperacional.redacao.js` | Reescreve achados comprovados; verificação de números; fallback determinístico |
| WhatsApp | `checklistOperacional.whatsapp.js` | Gera e valida a mensagem; transporte `noop`; chave de idempotência |
| Repositório | `checklistOperacional.operacional.repository.js` | Acesso ao banco, sempre com filtro de tenant |
| Service | `checklistOperacional.operacional.service.js` | Projeção incremental, lista/ficha, fechamento versionado, prévia e simulação |
| Agendador | `checklistOperacional.agendador.js` | Fechamento de ontem por unidade. **Não ligado no `server.js`**; exige duas travas de ambiente |
| Exportação | `checklistOperacional.exportar.js` | Excel do fechamento (8 abas); Excel do Dashboard sem mediana/P90 |
| Rotas | `checklistOperacional.routes.js` / `.controller.js` | 8 rotas novas (§3) |
| Frontend | `checklistOperacionalDashboard.js` (controlador), `checklistOperacionalOperacional.js` (abas novas), `checklistOperacionalDashboardVisual.js`, `checklistOperacionalGraficos.js`, `checklistOperacionalRelatorio.js`, `checklistOperacionalDashboard.css`, `api.js` | Quatro abas, ficha em diálogo, painel de fechamento, prévia do WhatsApp, PDF do fechamento |
| iFood | `ifoodEvents.service.js#extrasDePedidoAlterado` | `ORDER_PATCHED` reabre a leitura dos detalhes |

**Reaproveitados sem alteração:** `medirPreparo`/`medirEntrega`/`medirVida`/`chaveOpaca` (calc), `montarDashboard`, `resolverPeriodo`, linha do tempo de metas (127), análises determinísticas, motor de impressão em iframe do PDF, `enviarMensagem` + `reservarQuotaAgente` + `registrarUso` do Agente Crescer, o ciclo de Order Details e os helpers de API/contexto do frontend.

## 3. Rotas (todas sob `/api/v1/checklist-operacional`, tenant sempre do Context Token)

| Método e rota | Permissão | Observação |
|---|---|---|
| `GET /pedidos?periodo…` | `checklist.visualizar` ou `integracoes.ver` | Lista do período, sem PII |
| `GET /pedidos/:chave` | idem | Ficha 360°; `chave` é opaca (16 hex); pedido de outra unidade = 404 |
| `GET /fechamentos?competencia` | idem | Versões |
| `POST /fechamentos` | `configuracoes.gerenciar` ou `integracoes.gerenciar` | Gera ou revisa; corpo: `competencia`, `motivo`, `reprocessar` |
| `GET /fechamentos/:id` | leitura | Uma versão |
| `GET /fechamentos/:id/exportar.xlsx` | leitura | Excel da versão armazenada |
| `GET /fechamentos/:id/whatsapp` | leitura | Prévia (sem registro) |
| `POST /fechamentos/:id/whatsapp/simular` | gerenciar | Registra tentativa `noop` (idempotente) |

O perfil de exibição (TV) continua vendo **só** `/resumo` (teste). Sem a migration 130, as rotas novas respondem 503 e o Checklist e o Dashboard existentes seguem funcionando.

## 4. Camada analítica (`operacional_pedidos`)

- **Carimbos:** o MENOR `createdAt` de cada código (PLC, CFM, PRS, RTP, ADR, GTO, AAO, CLT, DSP, AAD, CON, CAN). Isso independe da ordem de chegada, de reentregas e de duplicatas. Sem a linha do evento, usa a coluna que o Events já gravou; sem as duas, fica **nulo**.
- **Estado:** o `status_oficial` do Events, nunca recalculado. O horário do CON é preservado mesmo quando o pedido é cancelado depois.
- **Classificação dos campos:**
  - *registrado* = carimbo ou valor do iFood;
  - *calculado* = duração entre carimbos registrados;
  - *indisponível* = falta um carimbo, com o motivo dito;
  - **nada estimado.**
- **Integridade:** `SEM_CHEGADA`, `SEM_DETALHES`, `DETALHES_DESATUALIZADOS`, `CONCLUIDO_SEM_DESPACHO`, `CONCLUIDO_SEM_HORARIO`, `CANCELADO_APOS_CONCLUSAO`, `CANCELAMENTO_SEM_EVENTO`, `ORDEM_INVERTIDA`, `EVENTO_SEM_DATA`. Nunca escondidos.
- **Idempotência:** `fonte_hash` estável, com desempate determinístico de eventos de mesmo horário. A mesma entrada gera o mesmo hash.
- **Incremental e sem depender de relógio:** cada projeção guarda o `atualizado_em` da fonte e o último `received_at` que viu (relógio do banco). Na leitura, só os pedidos cuja fonte mudou, ou que receberam evento depois, são reprojetados. Isso pega também eventos fora de ordem que não tocam `ifood_pedidos`.
- **Reconstrução histórica:** `sincronizarProjecao({ forcar: true })` reprojeta qualquer janela a partir do bruto.
- **Rastreabilidade:** `fonte` (hash dos detalhes, horários, contagem de eventos) e `regra_versao`.

## 5. Ficha 360° (estrutura)

| Bloco | Conteúdo |
|---|---|
| Identificação | número curto, prefixo do orderId (8 caracteres), unidade, horário de recebimento e a fonte desse horário, modalidade, logística, modo, agendado, status, origem, teste |
| Produtos | itens (nome, código PDV, quantidade, valores) e adicionais; observação só como **existência**; aviso se alterado depois da leitura |
| Financeiro operacional | itens, taxa de entrega, taxas do iFood, descontos, total; patrocínio (loja/iFood/rede/terceiros); métodos de pagamento. Rotulado: *não são repasse líquido* |
| Histórico | linha do tempo oficial com rótulos, etapas esperadas sem registro, alterações |
| Indicadores | confirmação, preparo, até o pronto, espera do entregador, pronto até a coleta, entrega, vida; meta vigente no recebimento; excedente |
| Ocorrências | cancelamento oficial (código, descrição, origem, estágio), disputas (tipo e desfecho, **sem** a mensagem do cliente), devolução, atrasos, problemas de dado |
| Rastreabilidade | fonte, regra, horário da projeção e do último evento, prefixo do hash |

## 6. Fechamento operacional diário

### 6.1 Regras de competência

- **Dia operacional:** `[00:00, 24:00)` no fuso. Hoje **não existe fuso por unidade** no banco: vale `America/Sao_Paulo` (o mesmo do Checklist), e cada versão grava `fuso` e `fuso_origem = padrao_plataforma`. Configurar o fuso por unidade é decisão pendente (§10).
- **Atribuição de pedidos:** três competências que nunca se misturam:
  - **ENTRADA** = dia da chegada (PLACED; sem PLC, o `createdAt`, só para contar). Usada para recebidos, tempos, atrasos, horários, descontos e clientes.
  - **CONCLUSÃO** = dia do CON (concluídos no dia).
  - **CANCELAMENTO** = dia do CAN (cancelados no dia e motivos).
- **Pedido que atravessa a meia-noite:** entra nos recebidos e nos tempos do dia da chegada e nos concluídos do dia da conclusão. Testado nas duas direções.
- **Identidade de soma:** só vale dentro da coorte de entrada (`recebidos = concluídos + cancelados + em aberto` dos que chegaram no dia). A tela e o Excel mostram as duas visões, rotuladas.

### 6.2 Os 11 indicadores (fórmulas)

| # | Indicador | Fórmula | Base / denominador |
|---|---|---|---|
| 1 | Pedidos | recebidos = pedidos reais com chegada no dia; concluídos no dia = CON no dia; cancelados no dia = CAN no dia; mais a coorte | teste fica fora |
| 2 | Tempo médio de preparo | Σ(DSP − PLC) ÷ n | DELIVERY recebidos no dia, não cancelados, não agendados, com os dois carimbos; duração ≤ 0 ou > 240 min descartada e contada |
| 3 | Tempo médio de entrega | Σ(CON − DSP) ÷ n | DELIVERY recebidos no dia e concluídos |
| 4 | Vida média | Σ(CON − PLC) ÷ n | DELIVERY recebidos, concluídos, não agendados |
| 5 | Pedidos atrasados | pedidos com alguma etapa > meta vigente no recebimento ÷ pedidos com alguma etapa avaliada; principal etapa = mais atrasos (empate: maior excedente) | **nenhum responsável é atribuído** |
| 6 | Motivos de cancelamento | contagem por `CANCEL_CODE` + descrição oficial; mais origem e estágio oficiais | cancelados no dia; "motivo não informado pelo iFood" quando falta |
| 7 | Horários de maior movimento | 3 horas com mais pedidos recebidos | entrada |
| 8 | Disputas | abertas no dia (abertura); expiradas/aceitas/recusadas no dia (desfecho); aguardando agora | `ifood_disputas`, sem texto do cliente |
| 9 | Descontos pagos pela loja | Σ `sponsorshipValues[name=MERCHANT].value` | recebidos no dia, não cancelados; **valor operacional** (o cobrado está no Financial) |
| 10 | Clientes novos e recorrentes | novo = `ordersCountOnMerchant = 0`; recorrente ≥ 1 | contagem por **pedido**; "sem informação" separado |
| 11 | Diagnóstico e ação | achado principal do motor determinístico + ação da biblioteca | §8 |

Toda média traz o tamanho da amostra. Indicador sem dado fica `estado: indisponivel` com o motivo, nunca zero. Cada tempo declara fonte, início, fim e população.

### 6.3 Estados e versionamento

| Estado | Quando |
|---|---|
| PRELIMINAR | competência = hoje; ou dia encerrado há menos de **6 h** (janela para eventos atrasados) |
| CONSOLIDADO | janela encerrada e cobertura suficiente |
| REVISADO | já havia CONSOLIDADO/REVISADO e o conteúdo mudou. Geração manual **exige motivo**; reprocessamento agendado usa motivo automático |
| INCOMPLETO | sem cobertura (antes do primeiro pedido), nenhum evento no dia, mais de 5% dos pedidos sem detalhes, ou falha na projeção. Nunca vira "sem problema" |

- **Função `operacional_fechamento_registrar`** (security definer, só `service_role`):
  - trava por unidade e competência (`pg_advisory_xact_lock`);
  - `JA_REGISTRADO` para a mesma `execucao_id`;
  - `SEM_MUDANCA` para o mesmo hash e status;
  - recusa PRELIMINAR depois de consolidado e REVISADO sem motivo ou sem consolidado anterior.
- **Imutabilidade:**
  - nenhuma versão é apagada ou reescrita (trigger);
  - a única mudança aceita é `organizacao_id` quando a unidade é transferida de empresa;
  - `substitui_id` encadeia as versões.
- **Registrado em cada versão:** unidade, competência, versão, status, horário, `execucao_id`, origem, autor (id), motivo, fonte, cobertura, indicadores, diagnóstico, pendências e `hash_conteudo`.
- **Concorrência:** testada com duas sessões reais simultâneas.
  - mesmo conteúdo → uma versão;
  - conteúdos diferentes → versões sequenciais sem colisão.

## 7. ORDER_PATCHED (achado D-8)

O evento OPA passa a reabrir a leitura dos detalhes **só daquele pedido**: `details_status = PENDENTE`, tentativas zeradas. Só faz isso quando os detalhes já tinham sido lidos **antes** da alteração.

O passo de detalhes que já existe (no máximo 10 por ciclo, respeita a retenção de 7 dias do iFood) rebusca de forma idempotente por hash e preserva `details_fetched_at` (SLA). O estado oficial e o ACK não mudam (testado).

Os 14 pedidos antigos com OPA **não** são reprocessados automaticamente: a maioria passou dos 7 dias de retenção do iFood. Ficam marcados como `DETALHES_DESATUALIZADOS` na projeção e na ficha.

## 8. Diagnóstico

- **Nível 1 (determinístico):**
  - **regras:** preparo/entrega/vida acima da meta (≥ 5 medições), atrasos ≥ 30% (≥ 10 avaliados), concentração de atraso num horário, cancelamento ≥ 5% e alta ≥ 3 p.p. sobre o dia anterior, queda de eficiência ≥ 10 p.p., disputas pendentes/expiradas, desconto da loja ≥ 20% dos itens, dados incompletos;
  - **cada achado traz:** fato numérico, referência, amostra, confiança e ação da biblioteca;
  - **sem amostra mínima:** a regra não dispara e isso fica registrado em `naoAvaliadas`.
- **Nível 3 (IA):** desligado por padrão (`OPERACIONAL_DIAGNOSTICO_IA_ENABLED=true` liga). Usa o provider, a cota por organização e o registro de custo do Agente Crescer. A saída é verificada e qualquer reprovação cai no texto determinístico, com o motivo registrado:
  - todo número precisa existir nos achados;
  - a ação precisa ser da biblioteca;
  - palavras de causa ou culpa são recusadas.

## 9. WhatsApp — geração e simulação

- **Formato:** cabeçalho, situação do fechamento, seções Pedidos, Tempos, Atrasos, Movimento, Cancelamentos, Disputas, Descontos, Clientes, Diagnóstico e Ação recomendada. O link do relatório completo só entra com `OPERACIONAL_RELATORIO_URL_BASE` em https (não configurada).
- **Validação:** até 1.500 caracteres; bloqueia telefone, e-mail, CPF e UUID; exige a situação.
- **Estados:**
  - `READY_FOR_REVIEW` = prévia válida;
  - `SIMULATED` = tentativa registrada com transporte `noop`;
  - `BLOCKED` = reprovada na validação;
  - `ERROR` = falha na geração.
  - Simulação **não** conta como entregue.
- **Deduplicação:** chave = fechamento + hash da mensagem; repetir não duplica. Uma versão nova do fechamento ou uma mensagem corrigida gera uma tentativa nova.
- **Histórico separado** (`operacional_mensagens_simuladas`) de `comunicacao_mensagens` (envios reais).

## 10. Destinatários futuros (arquitetura preparada, nada cadastrado)

A ativação real deve **reaproveitar** o pipeline de comunicação existente, sem outro canal:
- categoria `fechamento_operacional` em `comunicacao_categorias`;
- opt-in por destinatário em `comunicacao_destinatario_categorias`;
- consentimento explícito exigido pela política;
- janelas, limites, cooldown e idempotência atuais.

Itens que faltam e exigem decisão:

| Item | Como encaixar |
|---|---|
| Responsáveis por unidade | Hoje a habilitação é por organização. Precisa de vínculo destinatário ↔ unidade (a política já checa `vinculoValido`) |
| Horário de recebimento por destinatário | Preferência por categoria (coluna nova na tabela de categorias do destinatário) |
| Ativação individual e múltiplos destinatários | Já existem (teto de 5 por empresa) |
| Histórico, reenvio autorizado, limites, agrupamento, deduplicação | Já existem no pipeline (`comunicacao_mensagens`, `retryResendAllowlist`, limites por contato e por organização) |
| Troca do transporte | `criarTransporte` recusa tudo que não seja `noop`. Ativar exige mudança de código revisada, com testes, e **não** uma variável de ambiente |

**Nenhum usuário recebe nada por estar na unidade.** Antes de qualquer envio real é preciso homologar o provedor (Baileys é não oficial, com risco de banimento), os consentimentos e a política.

## 11. Segurança

- **129:** `anon`/`authenticated` ficam sem nenhum privilégio nas tabelas iFood; `service_role` fica sem TRUNCATE (teste em Postgres real).
- **130:** RLS ligado e sem policy; nenhum grant de cliente. Fechamentos só se escrevem pela RPC. O `service_role` recebe UPDATE **só** na coluna `organizacao_id`, para não quebrar a transferência de unidade (testado com a função 054).
- **Tenant:**
  - trigger de coerência unidade ↔ organização;
  - repositório sempre filtra organização + unidade;
  - trava dupla no service (uma linha de outro tenant vinda da fonte é recusada, e o fechamento vira INCOMPLETO);
  - chave e id de outra unidade = 404.
- **Achado preexistente (fora do escopo, reproduzido):** com a 127, `remapear_organizacao_em_tabelas_de_unidade` falha como `service_role` (`permission denied for table checklist_metas`). Transferir ou promover unidade quebra na `main`, e o trigger da 127 também proíbe mudar a organização. Correção proposta: migration que conceda `UPDATE (organizacao_id)` e ajuste os triggers de `checklist_metas` e do histórico para aceitar só essa mudança, como foi feito na 130.

## 12. Implantação futura (ordem; cada passo pede autorização)

1. Revisão do PR (sem merge automático).
2. Migration **129** em produção, com pré-voo (grants atuais) e verificação (consulta no rodapé da migration). Rollback disponível.
3. Migration **130** (aditiva). Rollback apaga fechamentos e simulações, então exportar antes.
4. Merge e deploy do backend e do frontend (o CSS subiu para `?v=3`).
5. Observar: lista de pedidos e ficha (a primeira abertura projeta a janela), gerar fechamento manual de um dia já encerrado e conferir com o Dashboard "ontem".
6. Só depois, e com decisão: agendamento em produção (exige integrar o agendador ao worker, com as travas trocadas por configuração aprovada), IA no diagnóstico e envio real de WhatsApp (homologação própria).
