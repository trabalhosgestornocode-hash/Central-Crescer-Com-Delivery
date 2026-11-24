# MOVA CORE — F3, F4 isolada, matriz de ferramentas e mapa de conhecimento (F5)

Situação em 24/11/2026. Produção: `main` = 893ed9c. Nada desta fase está em produção.

Pilha de PRs:

| PR | Branch | Conteúdo | Estado |
|---|---|---|---|
| #207 | feat/mova-core-f0 | F0 | não publicar |
| #210 | feat/mova-core-f1 | F1, sobre o #207 | não publicar |
| #211 | feat/mova-core-f2 | F2, sobre o #210 | rascunho |
| #214 | feat/mova-core-f3 | F3, sobre o #211 | rascunho |
| #215 | feat/mova-f4-escritas | F4 isolada, base `main`; inclui o commit do #206 | rascunho, desligado |
| #212 | fix/testes-descoberta-helpers | `test/helpers/` deixa de ser descoberto como teste | — |
| #216 | fix/testes-regex-corrompidas | guardas com regex corrompida voltam a conferir | — |

## 1. Matriz de ferramentas

Legenda:
- **Impl.**: código existe.
- **Adapt.**: passa pelo contrato do MOVA (escopo, permissão, fatos, verificador).
- **Homol.**: testes automatizados e avaliação real no ambiente isolado.
- **Prod.**: disponível no WhatsApp de produção.

### 20 ferramentas principais (catálogo do MOVA CORE)

| Ferramenta | Impl. | Adapt. | Homol. (testes) | Homol. (avaliação real) | Prod. |
|---|---|---|---|---|---|
| listar_unidades | sim | sim | sim | sim | não |
| contas_a_pagar | sim | sim | sim | sim | não |
| detalhe_conta_a_pagar | sim | sim | sim | sim | não |
| contas_a_receber | sim | sim | sim | sim | não |
| resultado_do_mes | sim | sim | sim | sim | não |
| resumo_financeiro | sim | sim | sim | sim | não |
| fluxo_de_caixa | sim | sim | sim | sim | não |
| caixa_e_bancos | sim | sim | sim | sim | não |
| movimentos_do_caixa_fisico | sim | sim | sim | sim | não |
| vendas | sim | sim | sim | sim | não |
| cobertura_de_faturamento | sim | sim | sim | parcial (poucos casos) | não |
| pendencias_de_conferencia | sim | sim | sim | parcial | não |
| documentos | sim | sim | sim | parcial | não |
| categorias | sim | sim | sim | sim | não |
| entregadores_da_semana | sim | sim | sim | sim | não |
| historico_do_entregador | sim | sim | sim | sim | não |
| analisar (F2/F3) | sim | sim | sim | sim | não |
| calcular | sim (local) | sim | sim | sim | não |
| como_funciona | sim (local) | sim | sim | sim | não |
| preparar_registro | sim (só prepara, `executado:false`) | sim | sim | sim | não |

O WhatsApp de produção continua com o MOVA anterior (#203/#209).

### 12 ferramentas do Agente Crescer (condicionadas ao vínculo com a plataforma)

| Ferramenta | Módulo | Impl. | Adapt. | Homol. | Prod. no MOVA |
|---|---|---|---|---|---|
| consultar_dashboard_executivo | ifood_dashboard | sim | sim | testes | não |
| consultar_dashboard_dia | ifood_dashboard | sim | sim | testes | não |
| consultar_evolucao_diaria_financeiro | ifood_dashboard | sim | sim | testes | não |
| consultar_diagnostico | ifood_dashboard | sim | sim | testes | não |
| listar_produtos_cmv | products_cmv | sim | sim (aviso de ficha não conferida) | testes | não |
| consultar_produto_cmv | products_cmv | sim | sim (CMV só com ficha completa e margem atual) | testes | não |
| listar_insumos | ingredients | sim | sim | testes | não |
| consultar_insumo | ingredients | sim | sim | testes | não |
| listar_cancelamentos | parser_food_delivery | sim | sim | testes | não |
| consultar_cancelamento | parser_food_delivery | sim | sim | testes | não |
| consultar_parser_resumo | parser_food_delivery | sim | sim | testes | não |
| consultar_checklist_operacional | checklist_operacional | sim | sim | testes | não |

Em todas as doze:
- o acesso é resolvido de novo a cada chamada;
- o vínculo com a plataforma nunca amplia o que o canal do WhatsApp permite;
- a homologação usa o REGISTRO real com dependências injetadas (AC-01…05). Não houve avaliação real com o modelo.

`sugerir_navegacao` fica fora do WhatsApp.

## 2. F3: resultados

| Conjunto | Rodada | Ferramenta | Decisão | Valores | Certa de primeira | Resolução efetiva |
|---|---|---|---|---|---|---|
| INDEPENDENTE_F3 (41 turnos) | 1, cega, re-correção offline | 100 | 97,6 | 100 | 85,4 | 97,6 |
| INDEPENDENTE_F3 | 2, após correções (**não cega**) | 100 | 95,1 | 97,0 | 90,2 | 92,7 |
| INDEPENDENTE (56 turnos) | 1 (re-correção offline) | 95,8 | 98,2 | 97,3 | 89,3 | 96,4 |
| INDEPENDENTE | 2 | 89,6 | 96,4 | 94,6 | 89,3 | 92,9 |
| AJUSTE (155 turnos, regressão) | 2 | 97,7 | 98,1 | 97,0 | 91,0 | 96,1 |

- Todas as rodadas: 0 vazamentos, 0 escritas indevidas, 0 valores inventados enviados.
- Metas não atingidas em todos os conjuntos: ferramenta ≥ 95, decisão ≥ 98, valores 100. Os critérios não foram alterados.

## 3. F4 isolada (#215, desligada)

1. **Compra já paga:** despesa e baixa atômicas por comprovante (do #206).
2. **Comprovante fotografado de novo:** `FV2_POSSIVEL_DUPLICIDADE`. Só segue com confirmação explícita.
3. **Prestação de contas da sangria** (prazo de 48 h configurável):
   - várias despesas por retirada;
   - parcial;
   - troco no mesmo caixa aberto;
   - caixa fechado recusado;
   - estorno devolve ao pendente;
   - concorrência travada.
4. **Política Açaí R$ 1.000:** só no banco isolado.

Pendente para F4: vínculo despesa-caixa fora da sangria, pagamentos agrupados, conciliações e ferramentas de proposta do MOVA.

## 4. Mapa de conhecimento (F5)

| Conhecimento | Onde está | Origem | Validade | Versão | Escopo | Aprovador |
|---|---|---|---|---|---|---|
| Glossário de conceitos (entrada × reforço, retirada × despesa, linha da DRE etc.) | `mova-core/resolucao.js` | achados das avaliações F1–F3 | até revisão | 2026-11-24.2 | todas as unidades | **pendente (proprietário)** |
| Metodologia da DRE gerencial | núcleo `apurarCompetencia` | Financeiro v2 | oficial | código em `main` | por unidade e competência | Financeiro |
| Regras de CMV (ficha completa, margem atual) | plataforma `products_cmv` e `validarCmv` | plataforma | enquanto a ficha estiver atual | 24/11 | por unidade | Gestor da unidade |
| Plano de contas e categorias | núcleo `consultarPlanoDeContas` | cadastro da unidade | vigente | dados | por unidade | Financeiro |
| Políticas de autonomia | `mova.politica_autonomia` | cadastro com responsável e motivo | vigência da política | registro | empresa ou unidade | quem cadastra (`configurar`) |
| Prazo de prestação da sangria | configuração da unidade (`prazoPrestacaoSangriaHoras`) | padrão de 48 h (§12) | vigente | — | por unidade | **pendente** |
| Explicações de "como funciona" | `como_funciona` (local) | equipe | até revisão | código | geral | **pendente** |
| Matriz métrica × dimensão | `mova-core/analise.js` | F3 | até revisão | código | geral | técnico |

## 5. Comandos padronizados

Executar a partir de `backend/`.

| Para quê | Comando |
|---|---|
| Suítes do MOVA (sem banco não roda) | `SUPABASE_URL=http://127.0.0.1:1 SUPABASE_SERVICE_ROLE_KEY=teste SUPABASE_ANON_KEY=teste MOVA_EXIGIR_BANCO=1 node --test --test-timeout=120000 --test-concurrency=4 test/mova-core/ test/mova-financeiro/` |
| Núcleo no PostgreSQL isolado | acrescentar `FV2_REPOSITORIO=postgres` |
| Avaliação offline (custo zero) | `node scripts/mova-core/avaliacao/avaliar.mjs --conjunto=INDEPENDENTE_F3` |
| Avaliação real (Haiku, chave de teste, teto cumulativo de US$ 1) | `node --env-file=.env.mova-teste scripts/mova-core/avaliacao/avaliar.mjs --real --conjunto=A,B --max-usd=X` |
| Re-correção offline de uma rodada real | `--regradar=<arquivo real-*.json>` (gera `recorrecao-*.json`, registrada à parte) |
