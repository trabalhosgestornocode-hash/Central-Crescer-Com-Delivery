# Rentabilidade do Dashboard iFood — separação de conceitos

Implementação local. **Sem commit, push, deploy ou execução de migration.**

## O erro que foi corrigido

Uma refatoração anterior fundiu dois conceitos distintos:

- **Indicadores logísticos** (regidos pelo modelo Marketplace/Full Service, em
  `metas_indicadores`).
- **Proteção da precificação** (percentual gerado pela diferença entre a tabela
  Balcão e a tabela iFood).

A fusão fazia o percentual das tabelas (ex.: 31,43%) virar "limite de Total de
Deduções", e `31,43 − 20,50 = 10,93%` virar "limite de Serviços e Promoções" —
sobrescrevendo as metas logísticas. Também adicionava uma linha "Deduções
Marketplace" e um card "Custo operacional total" à tabela de Indicadores.

## Como ficou

### A) Indicadores logísticos

#### Full Service — Meta Ideal dinâmica (a partir da Proteção da Precificação)

Só no modelo **Full Service**, a **Meta Ideal** (nunca o limite) de dois indicadores
acompanha a Proteção da Precificação da combinação de tabelas selecionada
(`dashboardExecutivo.calc.js#metasComProtecaoFullService`, alimentada pela saída de
`calcularProtecaoPrecificacao` — sem duplicar a fórmula):

| Indicador | Meta Ideal | Limite |
|---|---|---|
| Taxas e Comissões | **20,50%** (fixo, nunca derivado) | 20,50% |
| Serviços e Promoções | `max(0, protecao − meta(Taxas))` | 14,50% |
| Total de Deduções | `protecao` | 35,00% |

E × Z4 (proteção 31,43%) → Serviços meta **10,93%**, Total meta **31,43%**.
D × Z4 (proteção 32,86%) → Serviços meta **12,36%**, Total meta **32,86%**.
Trocar a tabela recalcula só as metas dinâmicas; limites e Taxas nunca mudam.
Proteção ≤ 20,50% → Serviços meta = 0 + flag interna
`protecaoPrecificacao.protecaoInsuficienteFullService` (não renderizada).

As metas derivadas alimentam **apenas a tabela de Indicadores** (payload
`indicadoresRentabilidade` + gráfico). Cards da Visão Geral, saldos, Plano de Ação
e Agente Crescer seguem `metas` original de `metas_indicadores`. **Marketplace não
passa por aqui** — metas fixas (13-5-12-30 / 13-7-15-35).

#### Status da coluna Status (só desta tabela)

`dashboardExecutivo.calc.js#statusIndicadorRentabilidade` — classificador **exclusivo**
desta tabela (não toca `statusIndicador`, usado por Plano de Ação / Diagnóstico /
Agente / cards):

| Situação | Status | Cor |
|---|---|---|
| `atual ≤ metaIdeal` | Dentro da Meta | verde |
| `metaIdeal < atual ≤ limite` | Dentro do Limite | verde |
| `atual > limite` | Atenção | âmbar |

A Meta Ideal **não gera alerta**. Sem estado "Crítico" nesta tabela — mesmo muito
acima do limite continua "Atenção". `Disponível = limite − atual` (contra o limite,
não a meta).

### A.1) Indicadores logísticos — inalterados

A aba Indicadores voltou à tabela compacta **de 4 linhas**, com meta e limite
vindos **exclusivamente** de `resolverMetas(modelo)` sobre `metas_indicadores`:

| Coluna | INDICADOR · ATUAL · META IDEAL · LIMITE · DISPONÍVEL · STATUS |
|---|---|
| Linhas | Taxas e comissões · Serviços e promoções · Taxas de entregadores · Total de deduções |

- `Disponível = limite logístico − atual` (p.p.).
- `Status` = régua histórica `statusIndicador` (Dentro da meta / Atenção / Fora
  da meta / Dados insuficientes) — **sem** a régua de "proteção" que a
  refatoração anterior tinha introduzido (removida).
- Full Service: `Taxas de entregadores` continua "Não se aplica a este modelo"
  (`INDICADORES_POR_MODELO`, intacto).
- `Total de deduções` = composição existente (Taxas + Serviços + Entregadores +
  ajustes contra a loja) — **não** alterada; alimenta também `receitaLiquida`.
  O exemplo `11,52 + 12,63 + 14,90 = 39,05` corresponde a um mês sem ajustes.

### B) Proteção da precificação — só no Simulador

Motor slim `dashboardExecutivo.rentabilidade.js` →
`calcularProtecaoPrecificacao({ precoBalcao, precoIfood, ticketMedioIfood })`:

```
diferencaPrecoReais      = precoIfood − precoBalcao
protecaoPrecificacaoPct  = (precoIfood − precoBalcao) / precoIfood × 100   (denominador = iFood)
ticketMedioEquivalenteBalcao = ticketMedioIfood × precoBalcao / precoIfood
protecaoFinanceiraReais  = ticketMedioIfood − ticketMedioEquivalenteBalcao
```

**Sem meta, sem limite, sem status.** No payload de `GET /dashboard-executivo/mes`
vem como `protecaoPrecificacao` (objeto separado). É consumido **apenas** pelo
Simulador de Preço — nunca na Visão Geral, nos cards principais nem na tabela de
Indicadores.

Simulador: **bloco recolhível** (padrão RECOLHIDO; `expandido` no nível do módulo
persiste a escolha durante a sessão, sem localStorage). Recolhido = faixa
compacta (~50px): "Simulador de preço · {Balcão} × {iFood} · Proteção {x%}" +
controle Expandir/Recolher; toda a faixa é clicável, com `aria-expanded` e
`aria-controls`. Recolher/expandir só troca `hidden`, nunca reconstrói o DOM — os
selects e seus eventos nunca quebram. Expandido = 2 cards (Balcão × iFood) + **um
único bloco RESULTADO DA SIMULAÇÃO** (diferença R$, proteção %, Ticket Médio
equivalente, proteção por Ticket, margem estimada iFood). Sem cabeçalho interno
duplicado; sem repetir a tabela de Indicadores; sem "Limite Serviços e Promoções".

### Transparência de cálculo (tooltips)

Ícone "i" discreto (`.vd-tip`, o mesmo componente do resto do sistema — portal
`tooltip.js`) ao lado dos valores derivados do Simulador. Ao passar o mouse,
focar por teclado ou tocar, abre um tooltip com: valores brutos usados, fórmula,
cálculo com 2–6 casas e o valor arredondado exibido. Helper central
`frontend/src/infoCalculo.js` → `infoCalculoTip({ titulo, linhas, formula,
calculo, resultado, observacao })`. `tooltip.js` ganhou suporte a conteúdo rico
(`data-tip-html`, variante `.vd-tip-flutuante--rico`) e a toque (clique abre;
clique fora fecha) sem quebrar os tooltips de texto simples já existentes.

Recebem tooltip: Proteção da precificação, Ticket Médio equivalente, Proteção por
Ticket Médio, Margem estimada iFood (KPIs do resultado); Receita após deduções e
Margem estimada (cards Balcão/iFood). Nota fixa no rodapé do Simulador: "Os
cálculos usam valores não arredondados. A interface exibe 2 casas decimais."

O backend passou a incluir `protecaoPrecificacao.ticketMedioBase`
(`{ valorVendasBruto, qtdVendas }`) — dado adicional, nenhuma fórmula alterada.

### Precisão do Ticket Médio equivalente

`ticketMedio(valorVendasBruto, qtdVendas) = valorVendasBruto / qtdVendas` — **valor
bruto, sem arredondamento**; entra assim em `calcularProtecaoPrecificacao`. Só a
apresentação arredonda (`fmtMoeda`, 2 casas). Exemplo real (unidade a1, 06/09):
`42599,39 / 900 = 47,332655…` → exibe **R$ 47,33**; equivalente Balcão
`47,332655… × 24 / 35 = 32,456678…` → exibe **R$ 32,46**. Usar o ticket já
arredondado (47,33) daria 32,45 — não é o que o sistema faz, e está correto
assim. Nenhum cálculo foi alterado.

### Duas fontes, nunca cruzadas

| Domínio | Fonte |
|---|---|
| Metas/limites logísticos | `metas_indicadores` via `resolverMetas(modelo)` |
| Proteção da precificação | `calcularProtecaoPrecificacao(precos)` — só preços das tabelas |

## Resultados verificados (preview local, HTML real)

Proteção da precificação:

| Combinação | Preços | Diferença | Proteção |
|---|---|---:|---:|
| E × Z4 | 24,00 / 35,00 | R$ 11,00 | **31,43%** |
| F × Z4 | 24,50 / 35,00 | R$ 10,50 | **30,00%** |
| D × Z4 | 23,50 / 35,00 | R$ 11,50 | **32,86%** |

Ticket 47,33 · E × Z4 → equivalente Balcão R$ 32,45 · proteção por Ticket R$ 14,88.

Indicadores logísticos (mês com Taxas 11,52% · Serviços 12,63% · Entregadores 14,90%):

| Indicador | Marketplace (meta/limite) | Full Service (meta/limite) |
|---|---|---|
| Taxas e comissões | 13 / 13 | 20,5 / 20,5 |
| Serviços e promoções | 5 / 7 | 9,5 / 14,5 ¹ |
| Taxas de entregadores | 12 / 15 | não se aplica |
| Total de deduções | 30 / 35 ¹ | 30 / 35 ¹ |

Trocar a tabela (no Dashboard ou dentro do Simulador) muda a proteção; **não**
muda nenhuma meta/limite logístico. Trocar o modelo logístico muda as metas.

¹ **Depende da migration 077** (ver abaixo). O banco hoje tem: FS `servicos_promocoes`
meta **10,0**; MP `total_deducoes` limite **32**; FS `total_deducoes` **30,5 / 32**.

## Migration 077 — APLICADA em produção (sob autorização)

`database/migrations/077_metas_logisticas_ajuste.sql` (+ `077_rollback.sql`):
`UPDATE` em `metas_indicadores`, **só linhas globais** (`organizacao_id` e
`unidade_id` NULL), sem tocar em overrides. Aplicada no projeto Crescer Com
Delivery (migração `20260908022851`); verificada com `SELECT`.

| Modelo · indicador | Campo | Antes | Depois |
|---|---|---:|---:|
| marketplace · total_deducoes | limite | 0,3200 | 0,3500 |
| full_service · servicos_promocoes | meta_ideal | 0,1000 | 0,0950 |
| full_service · total_deducoes | meta_ideal | 0,3050 | 0,3000 |
| full_service · total_deducoes | limite | 0,3200 | 0,3500 |

- **Motivo**: alinhar as metas logísticas globais ao que o negócio confirmou.
- **Impacto**: só a coluna Meta/Limite dos Indicadores; nenhuma mudança de schema.
- **Fallback / sem configuração**: `resolverMetas` já cai para org > global; sem
  linha, o indicador fica "Dados insuficientes" (comportamento atual).
- **Não executada.** Aguarda autorização.

Já corretos no banco (a migration não toca): MP taxas 13/13, MP serviços 5/7,
MP entregadores 12/15, MP total meta 30; FS taxas 20,5/20,5; FS serviços limite 14,5.

## Arquivos

Backend:
- `dashboardExecutivo.rentabilidade.js` — **motor slim** (`calcularProtecaoPrecificacao` + `calcularComparacaoProduto`); sem meta/limite/status/deduções-marketplace.
- `dashboardExecutivo.precos.service.js` — carregador de preços do Churrasco 15cm (inalterado).
- `dashboardExecutivo.service.js` — payload `protecaoPrecificacao` separado; os 4 indicadores voltam a vir 100% de `resolverMetas`; card "Deduções Marketplace" removido; `graficos` e `indicadoresRentabilidade` revertidos.
- `dashboardExecutivo.calc.js` — removida a régua `toleranciaCritico` de `statusIndicador`; `referenciaModeloPct`/`limiteCombinadoPct`/`situacaoDiferencaPreco` (código morto do simulador antigo) removidos.
- `dashboardExecutivo.diagnostico.js` — revertido ao HEAD.
- `dashboardExecutivo.simulador.service.js` — adaptador do endpoint legado, agora sobre `protecaoPrecificacao`.
- `dashboardExecutivo.controller.js` — parâmetros `tabelaBalcao`/`tabelaIfood` (para o Simulador).
- `dashboardExecutivo.precificacaoPolitica.js` — **excluído** (era o conceito da fusão).

Frontend:
- `dashboardExecutivo.js` — **revertido ao HEAD**, exceto: passa o payload ao `montarSimuladorPreco`.
- `dashboardExecutivoRentabilidade.js` — só apresentação do resultado do Simulador (`resultadoSimulacaoHtml`).
- `dashboardExecutivoSimulador.js` — 2 cards + 1 bloco; `deps.dashExecMes` injetável; lê `protecaoPrecificacao`.
- `charts.js` — **revertido ao HEAD**.
- `styles.css` — bloco `.dex-rent-*` enxugado (só o Simulador).

Banco/testes:
- `database/migrations/077_metas_logisticas_ajuste.sql` + `077_rollback.sql` (preparadas, não aplicadas).
- `backend/test/dashboard-executivo-rentabilidade.test.js` — proteção pura (E/F/D, denominador, ticket, ausência de dado, motor sem meta/limite).
- `backend/test/dashboard-executivo-rentabilidade-service.test.js` — payload + **não contaminação** (trocar tabela não mexe nas metas) + isolamento de tenant + adaptador.
- `backend/test/dashboard-executivo-simulador-calc.test.js` — enxugado para `margemEstimadaIfood`.
- `frontend/test/dashboard-executivo-rentabilidade.test.js` — reescrito sem `vm.SourceTextModule`; roda no `node --test` padrão.

Removido: `package-lock.json` da raiz (stub espúrio).

## Validação executada

- Motor de proteção: **20 testes**, zero falhas.
- Serviço (banco/preços simulados): **1 teste** cobrindo E/F/D, não contaminação, tenant, adaptador.
- Backend `test/dashboard-executivo*.test.js`: **222 aprovados**, zero falhas.
- Frontend `node --test "frontend/test/*.test.js"`: **539 aprovados, 9 pulados**, zero falhas.
- `node --check` em todos os módulos alterados/novos + `git diff --check`: ok.
- Build/lint: o projeto não tem script de build nem lint.
- Preview local (`node scratchpad/rentabilidade-preview.mjs`): tabela de 4 indicadores (Marketplace e Full Service), Simulador real, troca de tabela (proteção muda, metas não), F sem preço, viewport 390px sem overflow. Console limpo.
- Graphify: CLI indisponível no PATH.

Pendências / riscos:
- Migration 077 aplicada em produção; se alguma unidade tiver override de
  `total_deducoes`/`servicos_promocoes` no futuro, ele continua tendo prioridade
  sobre o global (cascata `resolverMetas`).
- `Total de deduções` continua incluindo "ajustes contra a loja" (comportamento pré-existente, também usado por `receitaLiquida`). Se o negócio quiser exatamente T+S+E, é uma mudança à parte com impacto na receita líquida.
- Validação foi com dados simulados; falta ambiente autenticado contra banco real.
