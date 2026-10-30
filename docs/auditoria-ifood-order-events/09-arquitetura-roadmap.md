# 09 — Arquitetura evolutiva e roadmap

## 1. Princípios aplicados

1. **Reutilizar antes de criar.** `ifood_eventos` já é o *event store* (imutável, deduplicado, com bruto integral). `ifood_pedidos` já é a projeção de estado. O Checklist já é o motor de indicadores e análises. A comunicação já é o canal com política. O Agente já é a camada de IA.
2. **A homologação não muda:** o poller, o ACK, as flags e o escopo de piloto ficam intactos. Toda evolução proposta **lê** o que o poller já grava. A Crescer continua **observadora** (não confirma nem despacha).
3. **Multi-tenant em toda camada:** toda tabela derivada nova carrega `organizacao_id + unidade_id`, com RLS ligado e **sem grants** para `anon/authenticated` (padrão das migrations 116+), e leitura no backend sempre filtrada por tenant.
4. **Nada de PII na camada analítica.** Pseudônimo (`hash(customer.id + segredo por organização)`), região agregada e nenhum telefone, nome, endereço ou dado de entregador.

## 2. Arquitetura proposta (camadas)

```
[iFood] ── polling 30 s ──> poller (INALTERADO) ──> ifood_eventos (bruto, event store)
                                             └──> ifood_pedidos (estado + Details bruto)
                                                     │
                     ┌───────────────────────────────┘
                     ▼
   (A) PROJETOR assíncrono (novo passo, idempotente, por cursor de received_at/id)
         lê eventos/pedidos NOVOS do tenant ──> camada derivada SEM PII:
           • linha do tempo por pedido (1 linha/pedido: plc, cfm, prs, rtp, adr, aao, clt, dsp, aad, con, can,
             previsao_entrega, delivery_by, modo, cancel_code/origin/stage, tem_opa, ...)
           • itens/complementos normalizados (pedido, externalCode, nome, qtd, valor, é_adicional)
           • benefícios (pedido, campanha, alvo, valor por patrocinador)
           • agregados diários por loja (pedidos, GMV operacional, cancelamentos por motivo/origem/estágio,
             percentis de tempo, promoções, novos/recorrentes)
                     │
   (B) INDICADORES: Checklist (montarDashboard) passa a ler também a camada derivada
                     │
   (C) DETECTOR (níveis 1 e 2): regras + analisadores do Checklist rodando em segundo plano por loja
         ──> achados persistidos (acompanhamento) ──> comunicacao_alertas (novo tipo/categoria)
                     │                                          │
   (D) IA: Agente Crescer + relatório semanal                  (E) WhatsApp: pipeline atual (política, limites, idempotência)
         (só lê achados e indicadores; nunca o banco)
```

Decisões de arquitetura:

- **Onde roda o projetor:** como passo do worker de Events **depois** do ACK e fora do caminho crítico, ou num passo do worker de comunicação. Em nenhum caso pode atrasar o polling ou o ACK. Idempotência por chave natural (`order_id`), com reprocessamento total possível a partir do bruto, que é a vantagem de ter o event store.
- **Projetor × consultas diretas no JSON:** hoje (51 mil eventos) consultas diretas funcionam. Com 30+ lojas, ~20 GB/ano, a camada derivada é o que mantém o custo e a latência estáveis e permite **apagar o bruto** depois do prazo de retenção sem perder analytics.
- **Retenção em camadas (LGPD):**
  - bruto de eventos e Details por **N dias** (proposta: 90; precisa de decisão jurídica e de produto);
  - logo após o pedido ser concluído, anonimizar `customer`, `delivery.deliveryAddress`, `customer_document_*`, `pickup_code` e os dados do entregador no bruto (o telefone, por regra do iFood, só é necessário até 3 h após a entrega);
  - agregados e linha do tempo sem PII **sem prazo**.
- **Webhook:** não necessário agora. O polling atende ao volume, e trocar de método é mudança de homologação (P3).
- **Observabilidade:** expor no status da integração (já existe) os contadores do projetor e do detector (atraso do cursor, achados abertos) e corrigir o carimbo de ACK (I-2).

## 3. Roadmap

| Etapa | Objetivo | Funcionalidades | Reaproveitamento | Dependências | Alterações propostas | Riscos | Testes | Critérios de aceite | Dificuldade | Prioridade | Nova homologação/permissão? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **E0 — Higiene** | Fechar riscos antes de crescer | REVOKE de `anon/authenticated` nas tabelas iFood (S-1); política de retenção/anonimização definida (S-2); investigar os 118 sem ACK (I-2) | Padrão das migrations 107/116 | Decisão de retenção (jurídico/produto) | 1 migration só de REVOKE; documento de retenção; (depois) job de anonimização | REVOKE quebrar algum leitor direto do front (a busca não encontrou) | Teste de catálogo (grants), regressão das suítes iFood | 0 grants de cliente nas tabelas iFood; prazo aprovado | P | **P1** | Não |
| **E1 — Relatórios com dados atuais** | Entregar valor sem nova API | Resumo diário e semanal por loja (pedidos, GMV operacional, ticket, cancelamentos, tempos vs meta, promoções por patrocinador, novos × recorrentes, disputas); seção "Pedidos/Cancelamentos/Promoções" no Checklist | `montarDashboard`, `analises`, exportação PDF/Excel do Checklist, `relatorioDashboardGrupo` (padrão de envio) | Nenhuma API | Extratores no service do Checklist sobre colunas/JSON (lista positiva, sem PII) | Confundir operacional com financeiro | Testes puros com fixtures reais anonimizadas; conferência com [BD] | Números batem com as consultas de auditoria; rótulos "operacional" visíveis | M | **P0** | Não |
| **E2 — Alertas imediatos (piloto)** | Primeiros alertas operacionais | Disputa aberta; integração parada (grupo interno); atrasos agregados; cancelamento atribuído à loja | Pipeline de comunicação, categorias (104), política | Opt-in de destinatários; templates | Novo `tipo_alerta` + categoria + detector | **Banimento do número** (Baileys); ruído | SIMULACAO por ≥ 1 semana; teste de limites e idempotência | 0 duplicados; ≤ 2 alertas/loja/dia; latência < 2 min | M | **P0** (disputa e integração parada) / **P1** (demais) | Não |
| **E3 — Camada derivada** | Escalar e estruturar | Linha do tempo por pedido, itens, benefícios, agregados diários; logística decomposta (cozinha × espera do entregador); OPA → rebuscar Details | event store existente | E0 (retenção) | Migrations aditivas (tabelas derivadas com RLS/sem grants); projetor idempotente; `detalhesDevidos` reabrir em OPA | Concorrência com o poller (rodar fora do ciclo); custo do backfill | Projetor determinístico (reprocessar = mesmo resultado); paridade com consultas diretas | Paridade 100% com [BD] em 3 lojas; poller sem degradação | G | **P1** | Não |
| **E4 — Acompanhamento** | Fechar o ciclo | Achados persistidos, ações registradas, reavaliação automática | Ids estáveis do Diagnóstico; `comunicacao_alertas` | E3 (ideal) | Tabelas achado/ação/reavaliação | Burocracia para o gerente | Testes de máquina de estados | Achado → ação → "resolvido/persiste" visível | M | **P1** | Não |
| **E5 — IA nos relatórios** | Texto e priorização | Resumo semanal redigido pelo Agente sobre os achados; recomendações da biblioteca | Agente Crescer, tool do Checklist | E1/E4 | Tool "achados da semana"; verificador de números | Alucinação (mitigada pelas travas de 08 §2) | Teste de verificação de números; revisão humana no piloto | 0 números fora da entrada em 100% dos testes | M | **P1** | Não |
| **E6 — Review** | Avaliações/NPS | Nota, comentários, respostas pendentes (prazo de 5 dias [DOC]) | Arquitetura de auth por conexão | App com escopo Review + homologação | Módulo novo | Homologação; dado pessoal em comentários | Homologação iFood | — | M–G | **P2** | **Sim** (Review) |
| **E7 — Financial no relatório** | Operacional × financeiro lado a lado | Repasse, taxas efetivas, estornos de cancelamento | Módulo Financial existente | Homologação Financial (ticket enviado em 07/10, aguardando) | Ligação por `order_id` | Divergência de conceitos | Conciliação por pedido | Diferença explicada item a item | M | **P2** | **Sim** (Financial em andamento) |
| **E8 — Analytics (opcional)** | Histórico anterior à ativação e KPIs agregados | KPIs D-1 | — | App BI + homologação | — | Dado D-1 muda até 15 dias | — | — | M | **P2** | **Sim** |
| **E9 — Escala de canal** | WhatsApp oficial | Cloud API, templates, custo por conversa | Pipeline e política | Decisão de produto/custo | Novo provider por trás de `WhatsAppService` | Custo; migração de números | — | — | G | **P3** | Meta Business |
| **E10 — Webhook iFood** | Latência/eficiência | Recebimento por webhook | `processarLote` | Mudança de homologação | Endpoint + validação de assinatura | Nova homologação | — | — | M | **P3** | **Sim** |
| **E11 — Agir sobre pedidos** | Crescer operadora | Confirm/ready/dispatch/disputa pela Central | Código já implementado e testado (inativo) | Decisão de produto; conflito com o PDV | Rotas + UI | **Conflito com o PDV** que já opera; responsabilidade operacional | Homologação já cobre Order | — | M | **P3** | Possivelmente (escopo de uso) |

### Classificação das oportunidades

- **P0** (dados e infraestrutura atuais): E1 (relatórios), E2 parcial (disputa aberta, integração parada).
- **P1** (ajustes internos, sem nova API): E0, E2 completo, E3, E4, E5.
- **P2** (outros módulos oficiais): E6 Review, E7 Financial, E8 Analytics.
- **P3** (produto/homologação/infraestrutura): E9 WhatsApp oficial, E10 webhook, E11 agir sobre pedidos.

Nenhuma oportunidade foi rebaixada de requisito para caber em P0. E0 é P1, mas **deve vir antes de ampliar** o número de lojas (o risco S-2 cresce linearmente).
