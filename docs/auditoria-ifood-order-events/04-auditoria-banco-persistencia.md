# 04 — Auditoria do banco e da persistência

> Produção `uqybgauuxcrqzquultfu`, só `SELECT` (catálogo + agregados), 30/10/2026 ~01:30 UTC. As migrations citadas estão em `database/migrations/` (`a035750`).

## 1. Onde ficam os dados

| Tabela | Migration | Conteúdo | Chave / dedupe | Volume [BD] | Tamanho |
|---|---|---|---|---|---|
| `ifood_eventos` | 101 | 1 linha por evento recebido; `payload` jsonb **integral** + `payload_hash`; status de processamento; ACK; reentregas | `UNIQUE(event_id)` (`uq_ifood_eventos_event_id`) | 51.331 eventos (10/10 → 30/10) | 63 MB |
| `ifood_pedidos` | 101 + 102 + 103 + 128 (índice) | 1 linha por pedido: estado oficial, carimbos, colunas extraídas, `details_payload` integral, estado das ações | `UNIQUE(order_id)` | 4.549 | 48 MB |
| `ifood_disputas` | 103 | 1 linha por negociação: dados do HSD, settlement, decisão | `UNIQUE(dispute_id)` | 170 | 480 kB |
| `ifood_pedido_acoes` | 102 + 103 | Auditoria de ações nossas (confirm/ready/dispatch/cancel/disputa) | — | **0** | 32 kB |
| `ifood_poller_lease` | 101 | Lease do poller (relógio do banco) | PK `nome` | 1 | — |
| `checklist_metas`, `checklist_metas_historico` | 127 | Metas de tempo do Checklist | — | — | — |
| `ifood_conexoes`, `ifood_conexao_lojas`, `ifood_merchant_vinculos`, `ifood_credenciais`, `ifood_loja_credenciais` | 056, 116–118, 124–125 | Tenant ↔ merchant ↔ credencial | `uq_ifood_conexao_merchant_vivo` | 2 conexões (estimativa) | — |

Crescimento observado: ~2.500 eventos/dia em 3 unidades (pico de 4.053 em 20/10) ≈ **~3 MB/dia** de eventos e ~2,4 MB/dia de pedidos. Para 30 unidades: ~55 MB/dia (~20 GB/ano), sem retenção.

## 2. Respostas às perguntas da Fase D

| Pergunta | Resposta | Evidência |
|---|---|---|
| Existe payload bruto? | **Sim**, nos dois níveis: `ifood_eventos.payload` (evento) e `ifood_pedidos.details_payload` (Order Details) | mig. 101/102; `ifoodEvents.service.js:240`; `ifoodOrder.service.js:92` |
| Existe histórico completo? | **De eventos, sim** (um registro imutável por evento). **De estado, não**: `ifood_pedidos` guarda só o estado atual + carimbos do **primeiro** evento de cada tipo | `extrasDoEvento` usa `seVazio` (`ifoodEvents.service.js:94`) |
| Dados são sobrescritos? | `status_oficial/_em/_evento_id` sim (o estado anda). `details_payload` só é regravado se o hash mudar, e na prática nunca muda, porque a busca não se repete depois de OK. Carimbos são *first-write-wins* | `ifoodEvents.repository.js:228-243`; `ifoodOrder.service.js:39,85` |
| Eventos são deduplicados? | Sim: no lote (`Set`) e no banco (UNIQUE + `ON CONFLICT DO NOTHING`). Reentregas contadas em `reentregas` | `ifoodEvents.service.js:214-222`; repo `:143-152`; [BD] 0 reentregas |
| Existe retenção? | **Não**: nenhuma rotina apaga ou anonimiza `ifood_eventos`/`ifood_pedidos`. (A retenção existente é a da inbox do WhatsApp, `comunicacao.inbox.retencao.js`) | Busca por purga/retenção nos módulos iFood e no worker: nenhuma |
| Eventos atrasados? | Aceitos: o pedido é criado pelo 1º evento que chegar (`garantirPedido`) e os carimbos preenchem lacunas | repo `:215-222`; `extrasDoEvento` |
| Proteção contra fora de ordem? | Sim: ordenação por `createdAt` no lote; ciclo de vida monotônico (`RANK_STATUS`); terminal não regride; CONCLUDED×CANCELLED decide pelo mais recente; compare-and-set em `status_oficial_em` | `ifoodEvents.parser.js:29-35,132-141`; `ifoodEvents.service.js:44-65` |
| Vínculo correto com unidade e organização? | Sim: o tenant vem **só** da conexão; pedido de outro tenant nunca é alterado (`PEDIDO_DE_OUTRO_TENANT`); constraints `ck_ifood_eventos_tenant` e `ck_ifood_eventos_quarentena` | `ifoodEvents.service.js:138-142`; mig. 101 |
| Lacunas históricas? | Os dados começam em 10/10/2026 (`00000000…`), 18/10 (`6a417349…`) e 21/10 (`4fd38803…`). **Não há histórico anterior.** Os 118 eventos sem `acknowledged_at` de 29/10 07:40Z estão persistidos e processados | [BD] |
| Algum campo relevante se perde na transformação? | Nenhum é descartado (o bruto é integral). Perdas **estruturais**: (a) `ORDER_PATCHED` não atualiza o Details; (b) o horário do CON some da coluna quando o pedido é cancelado depois (6 casos); (c) motivo/origem/estágio de cancelamento e toda a logística ficam só no JSON | ver 03 §8 |
| Podemos reconstruir cronologicamente cada pedido? | **Sim**, a partir de `ifood_eventos` (`order_id` + `event_created_at`, índice `idx_ifood_eventos_tenant_order`). Este relatório reconstruiu PLC→CFM→PRS→RTP→ADR→AAO→CLT→DSP→AAD→CON de 4.406 pedidos concluídos com uma consulta. **Não existe** visão ou tabela de linha do tempo pronta | [BD] consulta Q6 |

### Qualidade da linha do tempo (DELIVERY concluídos, reais) [BD]

| Logística | n | Com PRS | Com RTP | Com AAO/CLT | PLC→DSP p50 / p90 | RTP→DSP p50 | AAO→CLT p50 | DSP→CON p50 | PLC→CON p50 | Anomalias de ordem |
|---|---|---|---|---|---|---|---|---|---|---|
| iFood | 1.793 | 560 | 1.482 | 1.793/1.793 | 16,2 / 35,3 min | 8,0 min | 1,6 min | 13,3 min | 31,7 min | RTP antes do PRS 6; DSP antes do RTP 2 |
| Própria (MERCHANT) | 2.613 | 2.595 | 862 | 181/181 | 11,6 / 31,2 min | 0,3 min | 1,4 min | 8,3 min | 21,0 min | RTP antes do PRS 1; DSP antes do RTP 8 |

Leitura: com logística iFood, ~8 min do "preparo" PLC→DSP são espera pelo entregador depois do pronto (RTP→DSP). Isso só é separável quando há RTP (82,7% dos casos).

## 3. Segurança multi-tenant, RLS e grants

| Tabela | RLS | Policies | Grants para `anon`/`authenticated` [BD] |
|---|---|---|---|
| `ifood_eventos` | ligado (não forçado) | 0 | **SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER** |
| `ifood_pedidos` | ligado | 0 | idem |
| `ifood_disputas` | ligado | 0 | idem |
| `ifood_pedido_acoes` | ligado | 0 | idem |
| `ifood_poller_lease` | ligado | 0 | idem |
| `ifood_credenciais` | ligado | 0 | idem |
| `ifood_oauth_sessoes` | ligado | 0 | idem |
| `ifood_conexoes` | ligado | 1 (`rls_ifood_conexoes_tenant`, ALL para `authenticated` por tenant/superadmin) | idem |
| `ifood_conexao_lojas`, `ifood_loja_credenciais`, `ifood_merchant_vinculos`, `checklist_metas*` | ligado | 0 | **nenhum** (migrations recentes já revogam) |

Avaliação:

- **Isolamento efetivo:** o backend usa `service_role` (ignora RLS) e o isolamento vive na camada de repositório: toda leitura e escrita filtra `organizacao_id + unidade_id` (`ifoodOrder.repository.js:20-24,63-67`; `checklistOperacional.repository.js:26-35`). Funciona e está testado (`ifood-events-isolamento`).
- **Via PostgREST com chave anon/authenticated:** RLS ligado e 0 policies negam SELECT/INSERT/UPDATE/DELETE. Os dados **não** vazam por esse caminho.
- **Achado S-1 (defesa em profundidade, severidade média):** os grants herdados (default privileges do Supabase) dão **TRUNCATE**, e TRUNCATE **não é coberto por RLS**. O PostgREST não expõe TRUNCATE, então o vetor exige outra porta (função `SECURITY DEFINER` mal escrita, conexão direta com esses papéis). Não há evidência de exploração. Mesmo assim, é exatamente o padrão que as migrations 107/108/116+ já corrigiram em outras tabelas (`revoke … from anon, authenticated`). As tabelas da 101/102/103 e as de credenciais ficaram de fora. Correção proposta: migration aditiva só de `REVOKE`, depois de verificar que nenhum fluxo do front lê essas tabelas direto (a busca no código não encontrou).
- **Achado S-2 (LGPD, severidade alta para a escala):** dados pessoais e sensíveis **sem prazo de retenção**:
  - cliente: nome, telefone, localizador, CPF em 159 pedidos, endereço completo com coordenadas;
  - entregador: nome, telefone e foto (ADR);
  - códigos de coleta e entrega: `pickup_code` e `HANDSHAKE_CODE`;
  - dados de transação de pagamento.

  [DOC] o telefone "deixa de ser enviado 3 horas após a data de entrega" e a segmentação é "confidencial". Para analytics **nenhum** desses campos é necessário: bastam agregados, `customer.id` pseudonimizado e região (bairro/cidade). Ver proposta em 09 (retenção em camadas).
- **Achado S-3:** `customer_document_number` e `pickup_code` são **colunas próprias**, o que facilita consulta acidental. O Checklist e a tela de pedidos usam lista positiva e nunca os leem.

## 4. Índices relevantes

`idx_ifood_eventos_tenant_order (organizacao_id, unidade_id, order_id)`, `idx_ifood_eventos_merchant_criado`, `idx_ifood_eventos_pendentes`, `idx_ifood_eventos_sem_ack`, `idx_ifood_pedidos_tenant (org, unid, status_oficial)`, `idx_ifood_pedidos_tenant_criado (org, unid, criado_em)` (128), `idx_ifood_pedidos_details_pendentes`, `idx_ifood_pedidos_action`.

Lacunas para analytics: não há índice por `(unidade_id, event_code, event_created_at)` nem GIN em `details_payload`. Agregações por evento ou campo JSON fazem varredura. Hoje é aceitável (51 mil linhas); com escala, o caminho é uma camada derivada (ver 09), não índices no bruto.

## 5. Achados de integridade

| Id | Achado | Quantidade | Impacto |
|---|---|---|---|
| D-1 | Pedidos sem PLC | 2 | Ficam fora de preparo/vida no Checklist |
| D-2 | CONCLUDED com `status_oficial_em` nulo | 4 | Ficam fora dos tempos de entrega/vida (já registrado na memória do Checklist) |
| D-3 | DELIVERY concluído sem DSP | 6 | Fora do preparo/entrega |
| D-4 | Cancelado depois de concluído | 6 | Horário do CON só no bruto |
| D-5 | Eventos sem `acknowledged_at` | 118 (1 minuto) | Só observabilidade; causa NÃO VERIFICADA |
| D-6 | Disputas sem HSD | 66 de 170 | A disputa existe só pelo settlement: tipo, prazo e mensagem desconhecidos. Causa NÃO VERIFICADA (HSD anterior ao início da coleta? HSD não emitido?) |
| D-7 | Disputas presas em `RESPONDIDA` | 40 (todas ALTERNATIVE_REPLIED, 0 ação nossa) | O estado sugere "respondemos", mas quem respondeu foi outro sistema. O código trata ALTERNATIVE_REPLIED como não final (`ifoodHandshake.service.js:109-111`) e nenhum settlement final chegou depois |
| D-8 | Pedidos com OPA e Details desatualizado | 14 | Totais e itens podem divergir do pedido final |

## Apêndice — consultas executadas

Todas em produção, só leitura, com o comentário `-- SOMENTE LEITURA` no início:

- **Q1** eventos por `event_code/processing_status` com contagem de ACK e datas;
- **Q2** pedidos por unidade (mascarada) × detalhes, tipo, logística, estado, ações;
- **Q3** frequência de **chaves** de `details_payload` e subobjetos;
- **Q4** distribuição de valores categóricos (modo, logística, segmentação, faixas de `ordersCountOnMerchant`, método de pagamento, alvo e patrocinador de benefício, tipo de taxa, tipo e preenchimento de item);
- **Q5** chaves de topo de `payload` e `metadata` por código de evento;
- **Q6** linha do tempo por pedido (percentis por logística);
- **Q7** consistência financeira agregada e somas por patrocinador;
- **Q8** distribuições de metadata de CAN/CAR/CPT/HSD/HSS/CON/ADR/DDD/RDR/OPA/PRS (o campo `CANCEL_USER` foi classificado só por formato; nenhum valor foi transcrito);
- **Q9** catálogo: RLS, policies, grants, tamanho;
- **Q10** disputas, ações, quarentena, pendências, completude de carimbos;
- **Q11** eventos sem ACK por minuto e eventos por dia;
- **Q12** completude das disputas;
- **Q13** taxa de preenchimento das colunas extraídas;
- **Q14–Q16** Comunicação (configuração, volumes por status/tipo, envios ao grupo).

O resultado bruto de uma consulta (Q8, 850 KB, porque `triggerEvent` é único por evento) foi resumido localmente e o arquivo temporário foi apagado.
