# Auditoria iFood Order/Events e Inteligência Operacional

Auditoria **somente leitura** feita em 29/10/2026, na noite de Brasília (consultas ao banco por volta de 30/10/2026 01:30 UTC).

| # | Documento | Conteúdo |
|---|---|---|
| 01 | [Inventário técnico Order/Events](01-inventario-tecnico-order-events.md) | Componentes, fluxos, arquivos, handlers, flags e estado real em produção |
| 02 | [Matriz completa dos eventos](02-matriz-eventos.md) | Eventos oficiais × reconhecidos × observados × persistidos × utilizados |
| 03 | [Dicionário de dados dos pedidos](03-dicionario-dados-pedidos.md) | Order Details campo a campo: documentado, recebido, persistido, utilizado |
| 04 | [Auditoria do banco e persistência](04-auditoria-banco-persistencia.md) | Tabelas, histórico, deduplicação, ordem, RLS/grants, LGPD, lacunas |
| 05 | [Catálogo de indicadores](05-catalogo-indicadores.md) | Fórmulas, fontes, disponibilidade, limitações |
| 06 | [Comparativo Avalyo × Crescer](06-comparativo-avalyo-crescer.md) | As 12 seções do relatório de referência |
| 07 | [Plano de automação WhatsApp](07-plano-automacao-whatsapp.md) | Gateway atual, alertas e relatórios viáveis, controles |
| 08 | [Motor de inteligência operacional](08-motor-inteligencia-operacional.md) | Níveis determinístico, estatístico e IA; diagnóstico e acompanhamento |
| 09 | [Arquitetura e roadmap](09-arquitetura-roadmap.md) | Evolução modular, P0–P3, homologação |
| 10 | [Resumo executivo e matriz de decisão](10-resumo-executivo-decisao.md) | Consolidação para aprovar a próxima fase |

## Base auditada

- **Código:** `origin/main` em `a035750` (merge do PR #53), lido no worktree `crescer-auditoria-order-events`, branch `docs/auditoria-ifood-order-events`, criada só para esta documentação. O checkout principal (`feat/ifood-servicos-sinal`) estava 105 commits atrás da `main` e **não** foi usado como referência.
- **Banco:** produção (`uqybgauuxcrqzquultfu`). Só `SELECT`, com resultados agregados. Unidades aparecem pelos 8 primeiros caracteres do UUID. Nenhum nome, telefone, documento, endereço ou id de pedido foi copiado para estes documentos.
- **Documentação oficial:** portal iFood Developer, lido no navegador em 29/10/2026:
  - Order › Eventos de pedido — `https://developer.ifood.com.br/pt-BR/docs/food/guides/modules/order/events`
  - Order › Detalhes de pedido — `.../modules/order/details`
  - Events › Introdução — `.../modules/events/intro`
  - Review › Introdução — `.../modules/review/intro`
  - Analytics › Introdução — `.../modules/analytics/intro`
- **Documentação interna:** `docs/ifood-*.md`, `docs/checklist-*.md`, `docs/agente-crescer.md` e `docs/comunicacao-*.md`.

## O que NÃO foi feito (por regra da missão)

Nenhum código funcional alterado, nenhuma migration aplicada, nenhum dado escrito, nenhum serviço reiniciado, nenhum deploy, nenhuma variável alterada, nenhum ACK, nenhuma chamada à API do iFood, nenhuma mensagem de WhatsApp, nenhum worker ou poller iniciado.

## Convenções de evidência

- `arquivo:linha` refere-se ao código em `a035750`.
- **[BD]** = consulta agregada somente leitura em produção (o SQL está em [04](04-auditoria-banco-persistencia.md#apêndice--consultas-executadas)).
- **[DOC]** = documentação oficial do iFood (página e data acima).
- **NÃO VERIFICADO** = não comprovado. A ausência de evidência nunca virou PASS.
