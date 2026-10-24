# Checklist Operacional 2.0 — relatório de entrega

> Branch `feat/checklist-operacional-2`, rebaseada sobre a `main` atual (`origin/main` @ `eeeb1c7`, PR #52). **Nenhuma
> migration foi aplicada em ambiente algum; nenhum merge ou deploy foi feito.** Auditoria e plano: `checklist-operacional-2-auditoria.md`.
> Capturas: `docs/checklist-operacional-2/` (dados de demonstração e payload sintético; `04-tv-tom-verde-referencia` força o
> nível só para mostrar a cor).

## 1. O que foi entregue

| Fase | Entrega | Onde |
|---|---|---|
| 2 — Metas | Tabela por unidade com `versao`; histórico append-only (quem, quando, antes/depois, suporte); função atômica `checklist_metas_salvar` (compara a versão; conflito não grava nada). `GET/PUT /metas`, `GET /metas/historico`. Metas embutidas no `/resumo` (a TV lê sem rota nova). Evento `checklist_metas.atualizadas` só no tópico da unidade → TV, Tablet e Dashboard recarregam; reconexão/polling reconciliam. Diálogo grava no servidor, trata 409 (carrega o valor atual e pede revisão), falha mantém a última configuração válida; sem ler as metas do servidor o salvar fica bloqueado. A referência p75 da `main` continua só preenchendo o formulário. | migration **127**, `checklistOperacional.metas.js`, `service`/`controller`/`routes`, `checklistOperacional.js`, `checklistOperacionalDados.js`, `checklistOperacionalVisual.js` |
| 3 — Fundo dinâmico | Fundo da área operacional (TV e Tablet) pelo status agregado **já existente** (`derivarStatusOperacao`: pior entre médias do dia, pedidos em andamento e alertas). Piora imediata; melhora só depois de 5 s estável. Cor sólida na própria raiz (custo de pintura medido em Chrome real), transição de 900 ms, desligada com movimento reduzido. O status também aparece em texto (veredito do card "Status da operação") e ícone ao lado dele — sem altura nova (TV 1280×720 sem rolagem). | `checklistOperacionalFundo.js`, CSS |
| 4 — Dashboard | Terceira opção na seleção. Filtros: unidade (seletor global), hoje/ontem/semana/mês/personalizado (≤ 92 dias), etapa. KPIs, evolução diária, pedidos por dia, demanda e atraso por horário, dia da semana, distribuição por status, desempenho por etapa, comparativo com o período anterior equivalente (cortado no mesmo horário quando o período termina hoje), atrasos com evidências, metas aplicáveis, cobertura/qualidade, definições. Mesmas medições do resumo ao vivo — régua **"Etapa 2" da `main`**: só DELIVERY; preparo = chegada (PLC) → despacho (DSP); entrega = DSP → conclusão registrada pelo iFood; vida = PLC → conclusão. | `checklistOperacional.indicadores.js`, `.periodos.js`, `checklistOperacionalDashboard*.js`, `checklistOperacionalGraficos.js`, migration **128** |
| 5 — Inteligência | 7 regras determinísticas, com limiares e amostra mínima explícitos (concentração por horário, dias críticos, piora/melhora, preparo anormal, concentração por etapa, reincidência, desempenho contra a meta). Cada análise: fato, indicador+período, referência, ocorrências, evidências, hipótese marcada como não comprovada, recomendação. Regras sem dado suficiente aparecem como "não avaliadas". Tool só-leitura `consultar_checklist_operacional` no Agente Crescer (módulo `checklist_operacional`; aceita `ifood` na transição, a mesma régua do gate da API). | `checklistOperacional.analises.js`, `agente/tools/checklistOperacional.tool.js` |
| 6 — Relatórios | PDF (impressão do navegador, mesmos componentes e SVG da tela) e Excel (backend, `xlsx`), do mesmo payload e do filtro que gerou os números exibidos; escolha de 11 seções. | `checklistOperacionalRelatorio.js`, `checklistOperacional.exportar.js` |

**Metas × pedidos:** a tela ao vivo reavalia na hora os pedidos em andamento pela meta nova. O Dashboard avalia cada pedido
pela meta vigente **no recebimento** — mudar a meta nunca reescreve o passado. Pedido recebido antes da primeira meta salva
fica "sem meta vigente" (fora do % dentro da meta, contado à parte).

## 2. Migrations (NÃO aplicadas — homologar em PostgreSQL real)

A `main` já ocupa 120–126 (Financeiro, módulo `checklist_operacional`, conexões iFood). As desta entrega são as próximas livres:

| Arquivo | Conteúdo | Como aplicar |
|---|---|---|
| `127_checklist_metas.sql` | 2 tabelas + 4 funções; RLS sem policy; anon/authenticated sem privilégio; service_role só `select` + `execute` da função de escrita. 100% aditiva. | Transação única (`lock_timeout` 5 s). Rollback: `127_rollback.sql` (apaga o histórico de metas — exportar antes). |
| `128_ifood_pedidos_indice_periodo.sql` | Índice `(organizacao_id, unidade_id, criado_em)` em `ifood_pedidos`. | `CONCURRENTLY`, **fora de transação** (o worker grava o tempo todo). Rollback: `128_rollback.sql`. |

Sem a 127 o backend continua funcionando: o resumo mostra metas de exemplo marcadas como indisponíveis (salvar fica
bloqueado na tela) e o PUT responde 503 `METAS_INDISPONIVEIS`. Sem a 128 o Dashboard funciona, mais lento em períodos longos.
A numeração só é definitiva se 127/128 continuarem livres no merge.

## 3. Permissões

| Ação | Quem |
|---|---|
| Ver TV/Tablet (resumo, inclui metas) | quem já via (`checklist.visualizar` ou `integracoes.ver`), inclusive o perfil de exibição |
| Ver Dashboard, metas, exportar | idem, **exceto** o perfil de exibição (o bloqueio por lista exata continua permitindo só o resumo) |
| Alterar metas / ver histórico | `configuracoes.gerenciar` ou `integracoes.gerenciar` (organization_admin, unit_manager) — a régua que a tela já usava para o botão "Metas" |

Módulo: as rotas novas ficam sob o gate da `main` (`checklist_operacional` OU `ifood`). Nenhuma permissão nova.

## 4. Testes (código rebaseado; checkout com LF, como no Linux)

| Suíte | Resultado |
|---|---|
| Frontend completo (`node --test test/*.test.js`) | **1598: 1587 ok, 0 falhas, 11 pulados** (navegador). |
| Backend completo (`node --test test/*.test.js`, env fictício) | 5586: 5546 ok, 25 pulados, **15 falhas — todas pré-existentes**: os mesmos arquivos falham igual na `main` limpa (comunicação/central de conversas, frota, financeiro/dominio, sessão/perfil, whatsapp-retry sem dependências do gateway) e a falha intencional `performance-calc` › "distribuições recompõem…" (regra de Novos Clientes — **não alterada**). |
| Backend do escopo (Checklist + Agente) | **240/240**. |
| Banco (`checklist-metas-migration-pg.test.js`) | **Não executado**: sem Postgres/`psql` nesta máquina (pulado, padrão do projeto). Rodar com `CHECKLIST_PERFIL_PG_URL` local. |
| Navegador real (Playwright + Chrome) | `checklistOperacionalModos` 40/40 e `checklistOperacionalUniversal` 7/7 (na 2ª rodada; a 1ª teve 1 falha intermitente de 403 que também ocorre na `main`); `perfilExibicao` 11/11 em duas rodadas. `renovacaoExibicao` › "17 h sem interação" falha nos dois lados (mesma asserção de tempo, `main` incluída). |

O repositório não tem CI configurado (sem `.github/`).

## 5. Limitações

1. Fuso único `America/Sao_Paulo` (não existe fuso por unidade).
2. Só pedidos de entrega entram nos tempos (régua da `main`); a retirada conta como pedido acompanhado, sem tempos.
3. "Cumprimento dos itens do checklist": **indisponível** — a Central não registra itens de checklist.
4. Histórico começa no primeiro pedido gravado pelo Events de cada unidade; nada antes disso é inferido.
5. Não havia metas em `localStorage` para migrar. A API aceita `origem: 'migracao_local'` (só grava com `versao: 0`).
6. Período máximo de 92 dias e 60 000 pedidos por consulta (acima: 422 pedindo intervalo menor).
7. Limiares das análises fixos (`LIMIARES`); ajustá-los é decisão de negócio.
8. Graphify (citado no `CLAUDE.md`) não está instalado; `graphify update .` não foi executado.

## 6. Checklist de homologação das migrations (PostgreSQL real, fora de produção)

1. `CHECKLIST_PERFIL_PG_URL=postgresql://…@127.0.0.1:…/postgres node --experimental-vm-modules --test test/checklist-metas-migration-pg.test.js`
   (schema real base + 068..128; idempotência; RLS/privilégios; versão/conflito; concorrência real; isolamento; append-only; rollback).
2. Ambiente de teste (Supabase de integração), com backup: aplicar 127 numa transação e 128 `CONCURRENTLY`.
3. Conferir: `relrowsecurity` ligado e 0 policies nas duas tabelas; `has_table_privilege` falso para anon/authenticated;
   service_role só `select`; `has_function_privilege('service_role', 'checklist_metas_salvar(...)', 'execute')` verdadeiro;
   `indisvalid` verdadeiro em `idx_ifood_pedidos_tenant_criado`.
4. Duas abas na mesma unidade: salvar numa → a outra atualiza (com e sem Realtime); salvar nas duas com a mesma versão → a
   segunda recebe o aviso de conflito; o histórico mostra as versões com antes/depois.
5. Perfil de exibição: a TV mostra as metas salvas; `/dashboard` e `PUT /metas` devolvem 403. Unidade B não vê metas nem eventos da A.
6. Dashboard: conferir 2–3 números contra uma consulta manual em `ifood_pedidos` de um dia conhecido; PDF e Excel do mesmo
   filtro iguais à tela.
7. Rollback ensaiado (`128_rollback.sql`, depois `127_rollback.sql`) e reaplicação.

## 7. Ordem recomendada para a publicação controlada

1. Revisão do PR (Draft) e testes locais acima.
2. Homologação das migrations (§6) em ambiente de teste.
3. Produção, em janela, com backup: **127** (transação) → **128** (`CONCURRENTLY`) → conferências da §6.3.
4. Merge → deploy do **backend** → deploy do **frontend** (manual no Render). Backend antes: o frontend novo sem o backend
   novo mostra metas "indisponíveis" (salvar bloqueado), sem quebrar a TV.
5. Uma unidade piloto: salvar metas, abrir TV/Tablet/Dashboard, conferir números; depois liberar às demais.

Cada passo depende de autorização explícita.
