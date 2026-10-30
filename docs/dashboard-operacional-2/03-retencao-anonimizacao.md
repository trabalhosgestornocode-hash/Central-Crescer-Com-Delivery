# Proposta — Retenção e anonimização de dados pessoais da integração iFood

> **PROPOSTA. Nada foi executado.** Nenhum dado real foi apagado ou alterado. Executar exige aprovação específica da política (prazos) e uma migration/rotina revisada.

## 1. Situação atual (auditoria, `docs/auditoria-ifood-order-events/04`, achado S-2)

Ficam guardados **sem prazo**, no bruto (`ifood_eventos.payload`, `ifood_pedidos.details_payload` e colunas `customer`/`delivery`):

- **Cliente:** nome, telefone, localizador do 0800, CPF (159 pedidos também em coluna própria), endereço completo com coordenadas, segmentação (confidencial segundo o iFood).
- **Entregador:** nome, telefone e foto (evento ADR).
- **Códigos:** coleta e entrega (`pickup_code`, `HANDSHAKE_CODE`).
- **Pagamento:** dados da transação (`authorizationCode`).

O próprio iFood deixa de enviar o telefone 3 h após a entrega.

## 2. O que a plataforma precisa (e o que não precisa)

| Uso | Precisa de dado pessoal? |
|---|---|
| Checklist, Dashboard 2.0, Ficha 360°, fechamento | **Não**: usam `operacional_pedidos`, que já nasce sem PII |
| Recorrência de clientes | **Não**: usa `ordersCountOnMerchant` (contagem) |
| Order Details e operação do pedido em andamento | Sim, só durante o ciclo do pedido (horas) |
| Disputas em aberto | O texto do cliente, só até o desfecho |
| Auditoria e reprocessamento do bruto | Os campos de tempo, valores e códigos; **não** a identidade |

## 3. Proposta em camadas

| Camada | Prazo proposto | Ação |
|---|---|---|
| PII do cliente e do entregador no bruto | **24 h após a conclusão/cancelamento** | Anonimizar no lugar: substituir nome/telefone/documento/endereço/foto por `null` (ou hash irreversível onde a contagem importar), mantendo o restante do JSON |
| Códigos de coleta/entrega e dados de transação | 24 h | Remover |
| Texto das disputas (`ifood_disputas.message`/`evidences`) | 30 dias após o desfecho | Remover |
| Bruto completo de eventos e Details | **90 dias** | Apagar (depois de garantir a projeção atualizada) |
| `operacional_pedidos` (sem PII) | Sem prazo (ou conforme política contábil) | Manter |
| `operacional_fechamentos` e simulações | Sem prazo | Manter (são registros versionados) |

## 4. Como executar com segurança (quando aprovado)

1. **Projetar antes de anonimizar:** a rotina chama `sincronizarProjecao` na janela e só anonimiza pedidos com projeção da regra vigente. A projeção não depende dos campos removidos.
2. **Rotina em lotes pequenos** (ex.: 500 por execução), fora do horário de pico, idempotente e com marcação `anonimizado_em` (coluna nova). Não roda no poller nem bloqueia o ACK.
3. **Dry-run obrigatório:** primeiro só conta o que seria afetado por tabela e campo, publicado no log.
4. **Recuperação:** anonimizar é irreversível por definição. Por isso exige backup prévio (`pg_dump` das tabelas afetadas, guardado fora do OneDrive) e aprovação escrita do prazo.
5. **Verificação:** depois de cada lote, uma consulta só de chaves (como na auditoria) prova que não há PII nos pedidos anonimizados.

## 5. Decisões necessárias

- Prazos (24 h / 30 dias / 90 dias são **propostas**), com validação jurídica (LGPD: finalidade e necessidade).
- Se o CPF em coluna própria (`customer_document_number`, usado só para nota fiscal) deve deixar de ser gravado já na extração.
- Se a segmentação do cliente (confidencial) deve ser descartada na extração.
