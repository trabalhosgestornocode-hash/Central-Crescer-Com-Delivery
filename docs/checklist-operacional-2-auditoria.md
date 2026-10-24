# Checklist Operacional 2.0 — Fase 1: auditoria e plano técnico

> Branch `feat/checklist-operacional-2` (a partir de `main` @ `8d32196`). Auditoria feita só no código e nas migrations;
> nenhuma consulta à produção. O Graphify citado no `CLAUDE.md` não está instalado nesta máquina (`graphify-out/` não
> existe), então a navegação foi feita direto nas fontes.

## 1. Telas atuais (seleção, Televisão, Tablet)

| Peça | Arquivo | Papel |
|---|---|---|
| Rota | `frontend/src/router.js` (`checklist-operacional`) → `renderChecklistOperacional` | entrada |
| Controlador | `frontend/src/checklistOperacional.js` | ciclo de vida, tique de 1 s, pulso, paginação, tela cheia, metas |
| Componentes (HTML puro) | `frontend/src/checklistOperacionalVisual.js` | cards, status, listas, diálogo de metas, seleção de modos |
| Modelo (funções puras) | `frontend/src/checklistOperacionalModelo.js` | classificação verde/amarelo/vermelho, status agregado |
| Modos | `frontend/src/checklistOperacionalExibicao.js` | `MODOS_EXIBICAO` (tv, tablet), tela cheia, paginação |
| Adaptador | `frontend/src/checklistOperacionalDados.js` | resposta da API → `ResumoChecklist` |
| Sincronizador | `frontend/src/checklistOperacionalSincronizacao.js` | uma consulta por vez, polling de segurança, recuo em falha |
| Estilos | `frontend/src/checklistOperacional.css` (prefixo `cko-`/`ckm-`) | tela de parede, sempre escura |

Televisão e Tablet são o **mesmo** `conteudoTela`; o modo só troca a classe da raiz (paridade por construção, testada).

## 2. Pedidos e etapas

* Fonte única: `ifood_pedidos` (migrations 101–103), escrita **só** pelo Events/Order do iFood (worker). Carimbos
  oficiais: `placed_event_created_at`, `confirmed_event_at`, `ready_event_at`, `dispatch_event_at`,
  `status_oficial(_em)`, `cancel_event_at`. `order_id` é único (um pedido nunca duplica).
* Leitura: `backend/src/modules/checklist-operacional/` → `GET /api/v1/checklist-operacional/resumo` (só leitura,
  lista positiva de colunas; nenhum dado de cliente).
* Definições (`checklistOperacional.calc.js`): preparo CFM→RTP (sem RTP, CFM→DSP **aproximado**); entrega DSP→CON
  (só DELIVERY, aproximado por definição); vida PLC→CON. Agendados fora de preparo/vida. Durações ≤ 0 ou acima do
  teto são descartadas **e contadas**.

## 3. Metas — onde estão hoje

**Não são persistidas em lugar nenhum.** `estado.metas` vive na memória da aba (`checklistOperacional.js:98`),
inicia em `METAS_EXEMPLO` (12/35/45 min, aviso 80%) e o diálogo avisa: "valem só neste aparelho até recarregar".
Não há `localStorage` (verificado: nenhum uso nos arquivos `checklistOperacional*`). Consequência: **não existe
configuração local para migrar** — a migração da Fase 2 vira "primeiro salvamento da unidade" (versão 1), protegido
pelo controle de versão contra sobrescrever um valor que outro aparelho já tenha gravado.

## 4. Lógica verde / amarelo / vermelho (preservada)

`checklistOperacionalModelo.js`:

* **Preventiva** (etapa em andamento): `< aviso` verde · `aviso ≤ razão ≤ 1` amarelo · `> 1` vermelho.
* **Final** (etapa concluída): `≤ meta` verde · `> meta` vermelho. Nunca amarelo para o que já terminou.
* Pedido ativo assume o **pior** entre a meta da etapa e a vida total (`derivarPedidoAtivo`).
* **Status agregado já existe**: `derivarStatusOperacao` = pior nível entre médias do dia (final), pedidos em
  andamento (preventivo) e alertas do servidor (`critico`/`atencao`). Ordem: `neutro < ok < atencao < critico`.

**Decisão:** o fundo dinâmico usa exatamente `derivarStatusOperacao(...).nivel`. Não foi criado outro agregado. Com
etapas em níveis diferentes, a cor de fundo é a da pior delas (a mesma regra que o card "Status da operação" já usa);
`neutro` (sem medição) dá o fundo padrão da marca.

## 5. Tabelas, eventos, Realtime, permissões e RLS

* **Multi-tenant**: o tenant vem **sempre** de `req.tenant` (Context Token validado por `requireContexto`); nenhum id
  de unidade vem do navegador. Tabelas iFood: RLS ligada **sem policy** (deny-all), acesso só pelo backend
  (`service_role`). As novas tabelas seguem o mesmo padrão.
* **Realtime**: backend publica Broadcast privado por `emitirEventoRealtime` (tópicos `empresa:<org>` /
  `unidade:<id>`; opção `somenteUnidade`). O frontend só reage via `realtimeBus.registrarInteresse`; reconexão injeta
  `_realtime.resincronizado` (refazer a consulta). Realtime **só antecipa**; o polling garante.
* **Permissões**: `/resumo` exige `checklist.visualizar` OU `integracoes.ver`. A edição de metas no frontend já era
  `configuracoes.gerenciar` OU `integracoes.gerenciar` (organization_admin e unit_manager). O perfil de exibição
  (`display_operator`) tem só `checklist.visualizar` e um bloqueio por lista exata de rotas
  (`middlewares/perfilExibicao.js`).

## 6. Dados históricos realmente disponíveis

* Todo pedido gravado em `ifood_pedidos` desde que o Events foi ligado em cada unidade, com os carimbos acima.
  Antes disso: **nada** (não será inferido). `criado_em` = quando a Central registrou o pedido (só delimita janela).
* **Não existem** registros de itens de checklist (tarefas marcadas por pessoas): o "Checklist Operacional" atual é um
  painel de tempos. O indicador "cumprimento dos itens do checklist" fica **indisponível**, com o motivo escrito.
* **Não existe** fuso por unidade: o projeto usa `America/Sao_Paulo` (`FUSO_NEGOCIO`), dia civil (virada 00:00).
* Avaliações do iFood não estão conectadas (`avaliacoes.disponivel = false`).
* Índice existente: `(organizacao_id, unidade_id, status_oficial)`. Consultas por período usam `criado_em` → índice novo.

## 7. Reutilizável

* Cálculos: `medirPreparo/medirEntrega/medirVida/diaOperacional` (backend) — reaproveitados no histórico.
* PDF: `painelAdmPdf.js` (HTML dedicado + `window.print()` em iframe, sem biblioteca) — mesmo padrão.
* Excel: dependência `xlsx` (SheetJS) já no backend.
* Gráficos: Chart.js via CDN no dashboard financeiro; para o Dashboard Operacional foram usados **SVG puros**
  (funcionam também dentro do PDF impresso e podem ser testados sem navegador).
* Agente Crescer: registro de tools só-leitura (`agente.tools.js`) — ponto de integração para interpretar indicadores.

## 8. Limitações conhecidas

1. Sem Postgres local nem `psql` nesta máquina: o SQL das migrations é testado por inspeção estática; os testes de
   banco seguem o padrão do projeto (`*-pg.test.js`) e são **pulados** sem `CHECKLIST_PERFIL_PG_URL`.
2. Fuso único `America/Sao_Paulo` (não há coluna de fuso por unidade).
3. Entrega (DSP→CON) continua **aproximada**: o CON não foi validado como "entregue ao cliente".
4. "Unidade" no Dashboard = a unidade do seletor global (o Checklist é sempre de uma unidade).

## 9. Plano técnico

| Fase | Entrega |
|---|---|
| 2 | Migration `120_checklist_metas.sql`: `checklist_metas` (1 linha por unidade, `versao`), `checklist_metas_historico` (append-only), função `checklist_metas_salvar` (atômica, compara versão, grava histórico). `GET/PUT /checklist-operacional/metas`, `GET .../metas/historico`. Metas embutidas no `/resumo` (a TV já pode ler, sem rota nova para o perfil de exibição). Evento `checklist_metas.atualizadas` no tópico da unidade. |
| 3 | Fundo da área operacional (TV/Tablet) pelo status agregado; transição suave, sem transição com movimento reduzido; selo de status com texto + ícone; histerese só na melhora (piora é imediata). |
| 4 | Terceira opção "Dashboard Operacional"; `GET /checklist-operacional/dashboard` (período, etapa, comparativo); indicadores calculados no backend; gráficos SVG. Migration `121` (índice por período, `CONCURRENTLY`). |
| 5 | Motor determinístico de análises (`checklistOperacional.analises.js`) — fato / hipótese / recomendação separados, com evidências. Tool só-leitura no Agente Crescer. |
| 6 | PDF (HTML + impressão) e Excel (`GET .../dashboard/exportar.xlsx`) a partir do **mesmo** payload do dashboard, com seleção de seções. |
| 8 | Testes `node:test` (backend e frontend). |

**Metas × pedidos:** a tela ao vivo classifica sempre pela meta **vigente agora** (um pedido em andamento é
reavaliado na hora em que a meta muda). O Dashboard avalia cada pedido pela meta **vigente no recebimento** (versões do
histórico), então mudar a meta nunca reescreve um resultado passado. Pedido recebido antes da primeira meta salva fica
"sem meta vigente" (fora do denominador do % dentro da meta, contado à parte) — nunca avaliado pelas metas de exemplo.
