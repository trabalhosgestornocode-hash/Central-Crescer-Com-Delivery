# Checklist Operacional 2.0 — relatório de entrega

> Branch `feat/checklist-operacional-2` (base `main` @ `8d32196`). **Nada foi commitado, nenhuma migration foi
> aplicada em ambiente algum, nenhum merge ou deploy foi feito.** Auditoria e plano: `checklist-operacional-2-auditoria.md`.
> Capturas: `docs/checklist-operacional-2/`.

## 1. O que foi entregue

| Fase | Entrega | Onde |
|---|---|---|
| 2 — Metas | Tabela por unidade com `versao`; histórico append-only (quem, quando, antes/depois, suporte); função atômica `checklist_metas_salvar` (compara a versão; conflito não grava nada). `GET/PUT /metas`, `GET /metas/historico`. Metas embutidas no `/resumo` (a TV lê sem rota nova). Evento `checklist_metas.atualizadas` só no tópico da unidade → TV, Tablet e Dashboard recarregam; reconexão/polling reconciliam. Diálogo grava no servidor, trata 409 (carrega o valor atual e pede revisão), falha mantém a última configuração válida; sem leitura do servidor o salvar fica bloqueado. | migration 120, `checklistOperacional.metas.js`, `service`/`controller`/`routes`, `checklistOperacional.js`, `checklistOperacionalDados.js`, `checklistOperacionalVisual.js` |
| 3 — Fundo dinâmico | Fundo da área operacional (TV e Tablet) pelo status agregado **já existente** (`derivarStatusOperacao`: pior entre médias do dia, pedidos em andamento e alertas). Piora imediata; melhora só depois de 5 s estável (sem piscar). Selo no cabeçalho com texto + ícone. Transição de cor de 900 ms; sem transição com movimento reduzido. Cards e textos mantêm as superfícies e o contraste originais. | `checklistOperacionalFundo.js`, CSS |
| 4 — Dashboard | Terceira opção na seleção. Filtros: unidade (seletor global), hoje/ontem/semana/mês/personalizado (≤ 92 dias), etapa. KPIs, evolução diária, pedidos por dia, demanda e atraso por horário, dia da semana, distribuição por status, desempenho por etapa, comparativo com período anterior equivalente (cortado no mesmo horário quando o período termina hoje), atrasos com evidências, metas aplicáveis, cobertura/qualidade, definições. Todo cálculo no backend. | `checklistOperacional.indicadores.js`, `.periodos.js`, `checklistOperacionalDashboard*.js`, `checklistOperacionalGraficos.js`, migration 121 |
| 5 — Inteligência | 7 regras determinísticas com limiares e amostra mínima explícitos (concentração por horário, dias críticos, piora/melhora, preparo anormal, concentração por etapa, reincidência, desempenho contra a meta). Cada análise: fato, indicador+período, referência, ocorrências, evidências (pedidos/dias/horas), hipótese marcada como não comprovada, recomendação. Regras sem dado suficiente são listadas como "não avaliadas". Tool só-leitura `consultar_checklist_operacional` no Agente Crescer, com instrução para não estimar nem atribuir causa. | `checklistOperacional.analises.js`, `agente/tools/checklistOperacional.tool.js` |
| 6 — Relatórios | PDF (impressão do navegador, mesmos componentes e SVG da tela) e Excel (backend, `xlsx`), ambos do mesmo payload e do filtro que gerou os números exibidos; escolha de seções (11). | `checklistOperacionalRelatorio.js`, `checklistOperacional.exportar.js` |

**Regra metas × pedidos (documentada na tela):** a tela ao vivo reavalia na hora os pedidos em andamento pela meta
nova. O Dashboard avalia cada pedido pela meta vigente **no recebimento** — mudar a meta nunca reescreve o passado.
Pedido recebido antes da primeira meta salva fica "sem meta vigente" (fora do % dentro da meta, contado à parte).

## 2. Migrations (não aplicadas)

| Arquivo | Conteúdo | Como aplicar |
|---|---|---|
| `120_checklist_metas.sql` | 2 tabelas + 4 funções; RLS sem policy; anon/authenticated sem privilégio; service_role só `select` + `execute` da função de escrita. 100% aditiva. | Transação única (`lock_timeout` 5 s). Rollback: `120_rollback.sql` (apaga o histórico de metas — exportar antes). |
| `121_ifood_pedidos_indice_periodo.sql` | Índice `(organizacao_id, unidade_id, criado_em)` em `ifood_pedidos`. | `CONCURRENTLY`, **fora de transação** (o worker grava o tempo todo). Rollback: `121_rollback.sql`. |

Ordem segura: 120 e 121 (independentes) → deploy do backend → deploy do frontend. Sem a 120, o backend continua
funcionando: o resumo mostra metas de exemplo marcadas como indisponíveis e o PUT responde 503 (`METAS_INDISPONIVEIS`).

## 3. Permissões

| Ação | Quem |
|---|---|
| Ver TV/Tablet (resumo, inclui metas) | quem já via (`checklist.visualizar` ou `integracoes.ver`), inclusive o perfil de exibição |
| Ver Dashboard, metas, exportar | idem, **exceto** o perfil de exibição (bloqueio por lista exata continua permitindo só o resumo) |
| Alterar metas / ver histórico | `configuracoes.gerenciar` ou `integracoes.gerenciar` (organization_admin, unit_manager) — a mesma regra que a tela já usava para o botão "Metas" |

Nenhuma permissão nova foi criada (sessões abertas continuam válidas).

## 4. Testes executados

| Suíte | Resultado |
|---|---|
| Backend completo (`node --test test/*.test.js`, env fictício) | 5340 testes: **5312 ok, 25 pulados, 3 falhas** na 1ª execução → 2 eram as listas de "migrations posteriores conhecidas" (120/121 registradas; agora passam). **1 falha pré-existente e intencional**: `performance-calc` › "distribuições recompõem…" (pendência de negócio em `central-performance-novos-clientes-impacto.md`). |
| Backend novos | `checklist-operacional-2.test.js` (36) e catálogo do Agente — todos ok. |
| Banco (`checklist-metas-migration-pg.test.js`) | **Não executado**: sem Postgres/`psql` nesta máquina (pulado, padrão do projeto). Rodar com `CHECKLIST_PERFIL_PG_URL` local. |
| Frontend completo (`node --test test/*.test.js`) | 1531: **1520 ok, 0 falhas, 11 pulados** (navegador). |
| Navegador real (TV/Tablet, Playwright + Chrome) | 40 testes. **Instáveis também na `main` limpa** nesta máquina (orçamento de ~360 ms de relógio real por passo): `main` falhou em 4 de 5 execuções seguidas. Na branch final, 3 execuções seguidas sem falha. |

Cobertura dos itens pedidos: persistência, sincronização (evento + resumo), edição simultânea (409; concorrência real
no teste de banco), reconexão (resincronização → mesma consulta), isolamento por unidade, permissões, verde/amarelo/
vermelho e fundo, acessibilidade/responsividade (estático + capturas sem rolagem horizontal em 390 px), indicadores,
períodos e comparativos, exportação, dados ausentes, regressões TV/Tablet.

## 5. Limitações

1. Fuso único `America/Sao_Paulo` (não existe fuso por unidade).
2. Entrega continua aproximada (DSP→CON); preparo sem "pronto" é aproximado — sinalizado nos números.
3. "Cumprimento dos itens do checklist": **indisponível** — a Central não registra itens de checklist.
4. Histórico começa no primeiro pedido gravado pelo Events de cada unidade; nada antes disso é inferido.
5. Não havia metas em `localStorage` para migrar (eram só memória da aba). A API aceita `origem: 'migracao_local'`
   (só grava com `versao: 0`, nunca sobrescreve).
6. Período máximo de 92 dias e 60 000 pedidos por consulta (acima: 422 pedindo intervalo menor).
7. A análise "aumento anormal de preparo" e as demais usam limiares fixos (`LIMIARES`); ajustá-los é decisão de negócio.
8. Graphify (exigido no `CLAUDE.md`) não está instalado; `graphify update .` não foi executado.

## 6. Arquivos de usuário tocados

`frontend/test/checklistOperacionalModos.test.js` já tinha alteração local não commitada (normalização de CRLF);
esta entrega mudou **uma linha** dele (versão do CSS `v=4` → `v=5`). Os demais arquivos com alterações prévias
(`backend/testes-seguros/`, `backend/package.json` etc.) não foram tocados.

## 7. Homologação sugerida (antes de produção)

1. Rodar `checklist-metas-migration-pg.test.js` contra um Postgres local.
2. Aplicar 120 e 121 num ambiente de teste (Supabase de integração) e conferir: RLS/privilégios, índice válido.
3. Duas abas/aparelhos na mesma unidade: salvar metas numa → a outra atualiza (com e sem Realtime); salvar nas duas
   com a mesma versão → a segunda recebe o aviso de conflito.
4. Perfil de exibição: TV mostra metas salvas; `/dashboard` e `PUT /metas` devolvem 403.
5. Unidade B não vê metas nem eventos da unidade A.
6. Dashboard: conferir 2–3 números contra uma consulta manual em `ifood_pedidos` de um dia conhecido.
7. Gerar PDF e Excel do mesmo filtro e comparar com a tela.
8. TV real (navegador da TV/stick): fundo trocando sem engasgo; movimento reduzido.

## 8. Para publicar

Revisar → commit → PR → CI → aplicar 120/121 (janela, backup) → merge → deploy backend → deploy frontend (manual no
Render) → homologação acima. Cada passo depende de autorização explícita.
