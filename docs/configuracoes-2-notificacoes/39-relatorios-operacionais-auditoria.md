# 39 — Relatórios DIÁRIOS e SEMANAIS do Dashboard Operacional na Central (auditoria + etapa segura)

Escopo: o D-1 do Dashboard iFood (pendências de lançamento) **não é tocado** (outra categoria `pendencia_d1`, outra fila, mesmas cotas e horários). Os relatórios operacionais usam as categorias `fechamento_operacional_diario` e `resumo_semanal`, já cadastradas (migration 133) e **inativas**.

## Respostas da auditoria
| # | Pergunta | Achado (arquivo) |
|---|---|---|
| 1 | Ativação por unidade | Módulo `checklist_operacional` (migration 123). Acesso efetivo = interseção `organizacao_modulos` ∩ `unidade_modulos` (`shared/modulos.js#modulosEfetivosDaUnidade`). Produção hoje: 8 unidades com o módulo, de 53. |
| 2 | Onde os dados ficam | `ifood_pedidos`/eventos → projeção `operacional_pedidos` (130; 716 linhas em produção) → `operacional_fechamentos` (versões imutáveis, hash; 1 em produção) → `operacional_mensagens_simuladas` (só `noop`). |
| 3 | Cálculo dos indicadores | `checklistOperacional.operacional.service.js` + `indicadores.js`/`fechamento.js`: 11 indicadores, três competências (entrada/conclusão/cancelamento), estados PRELIMINAR→CONSOLIDADO/REVISADO/INCOMPLETO (arquitetura em `docs/dashboard-operacional-2/01-arquitetura.md`). |
| 4 | Geradores existentes | **Diário: existe** (`gerarFechamento` + `whatsapp.js#gerarMensagem`, ≤1500 caracteres, validada; `agendador.js` não ligado, travado por duas variáveis). **Semanal: não existia** (só a categoria `resumo_semanal`, `EM_BREVE`). |
| 5 | Ligação à Central | **Diário já ligado, em simulação**: `notificacoes.fechamento.js` cria, após cada versão CONSOLIDADO/REVISADO, uma linha por destinatário autorizado (escopo da unidade + convite/OTP + consentimento + cota consultada) com chave idempotente. Falta apenas o transporte: `criarTransporte` aceita só `noop` (decisão registrada: trocar exige mudança de código revisada). |
| 6 | Só unidades com Checklist e dados válidos | Diário: a geração é por rota com módulo; o **agendador recebe uma lista** sem filtro de módulo. Faltava o filtro → **`filtrarUnidadesComChecklist`** (novo). Dado válido: só CONSOLIDADO/REVISADO notificam (já existia); semanal exige ≥ 5 de 7 dias válidos. |
| 7 | Destinatários e periodicidade | Destinatários: escopos por unidade/categoria + consentimento (Central existente). Periodicidade: diário = **ao consolidar** (evento, não relógio); semanal = **segunda-feira, semana encerrada** (nova regra). Preferência de horário por destinatário **não existe** (decisão pendente). |

## Implementado nesta branch (puro, sem envio, sem escrita, sem migration)
- `checklistOperacional.semanal.js`: semana segunda–domingo, só semana encerrada; usa **apenas fechamentos armazenados** válidos (última versão de cada dia); médias **ponderadas por amostra**; cobertura mínima 5/7 (abaixo disso INCOMPLETA e **sem mensagem**); dias ausentes declarados; hash muda se qualquer diário for revisado; mensagem ≤1500 sem dado pessoal.
- `notificacoes.relatorios.js`: elegibilidade (módulo efetivo + dado válido), destinatários autorizados (mesmas regras do diário), `planejarResumoSemanal` (linhas `SIMULATED/BLOCKED`, chave `wa:sem:<unidade>:<semana>:<destinatário>:<hash>`).
- `notificacoes-relatorios-operacionais.test.js`: 14 testes, inclusive pureza e ausência de qualquer referência ao D-1.

## O que falta (cada item precisa de decisão/autorização)
1. **Persistência do semanal**: `operacional_mensagens_simuladas.fechamento_id` é `NOT NULL` → migration nova (tabela de resumos semanais + simulações) — **não criada**.
2. **Agendamento**: ligar o agendador ao worker com filtro de módulo (travas hoje por duas variáveis de ambiente) e disparar o semanal na segunda.
3. **Transporte real (Baileys)**: reutilizar `whatsapp.service#enviarTexto` pela Central (kill switch + conta confirmada, como o OTP), com cota por categoria (135), allowlist e idempotência — sem passar pela fila do D-1.
4. **Fuso por unidade**, **termo v2 aprovado** (consentimento real), **ativar as categorias** e **M3** (escopo por unidade para legados): continuam desligados.

## Correção de critério: "unidade ativa" = integração iFood REAL (implementado)
O módulo Checklist habilitado é só permissão de acesso. Em produção (somente leitura): **8 unidades têm o módulo; só 1 tem conexão de pedidos ativa e pedidos reais projetados**. O critério anterior selecionaria 8.

Como o sistema já identifica (reaproveitado, sem duplicar): conexão de PEDIDOS (`ifood_conexoes`, finalidade `pedidos_producao`; conexão só de Financial não conta) → credencial `order` → lease do recebimento renovado há ≤ 120 s e último evento da loja (`derivarEstadoIntegracao`, do Checklist). Vínculo pedido↔unidade: `operacional_pedidos`/`ifood_pedidos` por organização + unidade (trigger de tenant); pedidos de teste ficam fora. Disponibilidade dos indicadores: status e `cobertura` do fechamento (`semCobertura`, `semSinalDeRecebimento`, detalhes, projeção).

Motivos distintos (`notificacoes.relatorios.js`), na ordem em que são avaliados:
| Motivo | Quando |
|---|---|
| `SEM_MODULO_CHECKLIST_NA_UNIDADE` | módulo inativo na empresa ou na unidade |
| `INTEGRACAO_NAO_ATIVADA` | sem loja vinculada, sem credencial Order, ou recebimento nunca ligado |
| `INTEGRACAO_DESCONECTADA` | recebimento parado (lease vencido) ou autorização expirada |
| `INTEGRACAO_NAO_VERIFICADA` | falha ao ler (fail-closed) |
| `DADOS_INSUFICIENTES` | fechamento ausente/PRELIMINAR/INCOMPLETO, sem sinal de recebimento ou cobertura; semana com < 5 de 7 dias válidos |
| `SEM_PEDIDOS_NO_PERIODO` | integração viva, dado válido, mas 0 pedidos reais no dia/semana |

`notificacoes.relatorios.integracao.js`: `lerIntegracaoDaUnidade` e `unidadesComIntegracaoViva` (funil módulo → integração viva). 21 testes (integração ao vivo/parada/reautorização/só Financial/falha de leitura, funil com 4 unidades, diário, semanal). Nada envia, nada grava, D-1 intocado.
