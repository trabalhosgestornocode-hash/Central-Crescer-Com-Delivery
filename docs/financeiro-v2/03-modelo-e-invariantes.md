# Financeiro v2 — Execução 01 · Modelo, invariantes, contratos e pendências

Regra-mãe: **todo valor financeiro tem origem, natureza, competência, composição, evidência disponível e histórico.**

## 1. Entidades

Todo registro tem `id` próprio, `organizacaoId`, `unidadeId`, `versao`, `criadoEm/Por`, `atualizadoEm/Por`.

| Entidade | O que representa | Campos centrais |
|---|---|---|
| **Conta financeira** | Onde o dinheiro da empresa está | tipo (`BANCARIA`, `CAIXA_FISICO`), nome, instituição, ativa |
| **Contraparte** | Fornecedor, operadora, cliente, prestador | tipo, nome |
| **Lançamento econômico** | Fato de resultado | natureza (`RECEITA`, `DEDUCAO`, `DESPESA`), valor, moeda, categoria, descrição, data da operação, competência, fonte, situação, **origem** (venda, obrigação, recebível ou ajuste) |
| **Venda** | Venda de um canal | canal, data, competência, bruto, pagamentos[forma, processador, valor], fonte externa |
| **Obrigação** | Conta a pagar (uma por parcela) | contraparte, valor base, liquidado, ajustes, **saldo**, competência, emissão, vencimento, parcela n/N, grupo, recorrência, documentos, situação |
| **Recebível** | Direito de receber | processador **ou** contraparte, canal, venda de origem, bruto, deduções[], líquido esperado (= valor base), liquidado, ajustes, **saldo**, data prevista, situação |
| **Movimentação** | Entrada ou saída em uma conta | conta, data efetiva, sentido, valor, natureza, fonte externa, documento, alocado, situação de conciliação, transferência |
| **Liquidação** | Ligação movimentação → título | movimentação, alvo (obrigação/recebível), valor, situação (`VALIDA`, `ESTORNADA`) |
| **Transferência** | Par saída + entrada entre contas da unidade | contas, valor, data, ids das duas movimentações |
| **Ajuste** | Alteração documentada do saldo de um título | alvo, valor (±), motivo, categoria, documento, lançamento gerado |
| **Documento** | Ficha de um arquivo original | origem, id do arquivo no cofre, SHA-256, tipo, competência, recebido em, responsável, versão, substitui/substituído por |
| **Vínculo documental** | Documento ↔ registro financeiro | documento, tipo e id do registro |
| **Correspondência** | Conciliação entre registros | lado A[], lado B[], diferença, evidências, situação (`CANDIDATA`, `CONFIRMADA`, `DIVERGENTE`, `REJEITADA`), responsável, data da decisão |
| **Competência** | Estado de fechamento do mês | competência, estado, metodologia, pendências, revisões |
| **Histórico** | Trilha de auditoria (somente acréscimo) | registro, evento, antes, depois, usuário, data, justificativa |

## 2. Relacionamentos

```
Venda 1 ──── 1 Lançamento(RECEITA)
Venda 1 ──── N Recebível                  (um por pagamento com processador)
Obrigação N ─ 1 Lançamento(DESPESA)       (parcelas de um mesmo grupo)
Recebível 1 ─ N Lançamento(DEDUCAO)       (uma por dedução informada)
Ajuste 1 ──── 1 Lançamento                (despesa ou dedução, com sinal)
Movimentação 1 ─ N Liquidação N ─ 1 Obrigação | Recebível
Transferência 1 ─ 2 Movimentação          (saída + entrada; sem lançamento)
Documento N ─ M registros                 (via Vínculo documental)
Correspondência N ─ M registros           (movimentação, recebível, obrigação, venda)
```

Lançamento **nunca** nasce de movimentação, liquidação ou transferência — é o que separa resultado de caixa.

## 3. Invariantes protegidas (todas com teste)

| # | Invariante | Onde é garantida |
|---|---|---|
| I1 | Dinheiro é inteiro de centavos; número fracionário, texto e valores fora do intervalo seguro são recusados | `dominio/dinheiro.js` |
| I2 | Arredondamento só acontece em `proporcao` (modo explícito) e `ratear` (soma das partes = total) | `dominio/dinheiro.js` |
| I3 | **Conservação:** `saldo = valor base − liquidações válidas + ajustes`, e `saldo ≥ 0` | `dominio/titulos.js` + `verificarConservacao` |
| I4 | Total alocado de uma movimentação ≤ valor da movimentação | `aplicacao/caixa.js` |
| I5 | Saída só liquida obrigação; entrada só liquida recebível | `aplicacao/caixa.js` |
| I6 | Pagar/receber não cria lançamento; cada fato econômico tem um único lançamento | `aplicacao/economico.js`, `caixa.js` |
| I7 | Soma das formas de pagamento = bruto da venda; uma venda tem um único canal | `contratos/comandos.js` |
| I8 | Só sistemas de origem criam venda; a mesma origem externa nunca gera dois registros | `contratos/comandos.js`, `aplicacao/base.js` |
| I9 | Transferência = saída + entrada de mesmo valor, contas diferentes, mesma unidade, gravadas juntas; não liquida títulos nem entra em indicadores | `aplicacao/caixa.js`, `dominio/indicadores.js` |
| I10 | Operação composta é atômica: falhou uma parte, nada é gravado | porta `transacao` |
| I11 | Não existe exclusão; correção, cancelamento e estorno preservam antes/depois, autor, data e motivo | porta sem `remover` + `aplicacao/base.js` |
| I12 | Alteração concorrente é detectada por versão | porta `atualizar` |
| I13 | Toda leitura e escrita é filtrada por organização + unidade; id de outro escopo responde "não encontrado" | adaptador da porta |
| I14 | Sem permissão própria, sem contexto válido ou fora da lista de escopos, nada é lido nem gravado | `dominio/contexto.js` |
| I15 | Competência homologada recusa toda escrita; reabertura exige permissão `revisar` e justificativa | `dominio/fechamento.js`, `aplicacao/base.js` |
| I16 | Documento só se vincula a registro existente do mesmo escopo; o mesmo arquivo (SHA-256) não se registra duas vezes | `aplicacao/documentos.js` |
| I17 | Um registro não é conciliado acima do próprio valor; lados que não fecham não são confirmados | `aplicacao/conciliacao.js` |
| I18 | Indicadores vêm de uma única definição e sempre trazem os registros que os compõem | `dominio/indicadores.js` |

### Arredondamento

- Padrão: **metade para cima** (meio centavo se afasta do zero). Alternativa explícita: **metade par**.
- Rateio (parcelas, proporções): método dos maiores restos; centavos restantes vão para os maiores restos, empate para a posição mais antiga.
- Apresentação (`formatarBRL`) nunca é reconvertida para cálculo.

## 4. Contratos internos

| Operação pedida | Função do núcleo | Permissão |
|---|---|---|
| Registrar venda | `registrarVenda` | registrar |
| Registrar obrigação | `registrarObrigacao` | registrar |
| Registrar recebível | `registrarRecebivel` | registrar |
| Registrar liquidação | `registrarLiquidacao` / `estornarLiquidacao` | registrar / cancelar |
| Registrar movimentação | `registrarMovimentacao` | registrar |
| Registrar transferência | `registrarTransferencia` | registrar |
| Registrar ajuste | `registrarAjuste` | corrigir |
| Vincular documento | `registrarDocumento`, `vincularDocumento` | registrar |
| Consultar composição | `consultarComposicao` | ver |
| Consultar competência | `consultarCompetencia`, `alterarEstadoDaCompetencia` | ver / fechar · homologar · revisar |
| Criar correspondência candidata | `criarCorrespondenciaCandidata` | conciliar |
| Confirmar conciliação | `confirmarConciliacao`, `registrarDivergencia`, `rejeitarCorrespondencia` | conciliar |
| Consultar histórico | `consultarHistorico` | ver |
| (apoio) | `configurarContaFinanceira` (configurar), `registrarContraparte`, `corrigirObrigacao`, `cancelarObrigacao`, `reclassificarLancamento`, `consultarRegistros`, `verificarConservacao` | — |

Todas recebem `(contexto, entrada)`. O contexto é montado por um adaptador confiável a partir da sessão. Nenhum endpoint foi criado.

Indicadores definidos: `RECEITA_BRUTA`, `DEDUCOES`, `DESPESAS`, `RESULTADO_ECONOMICO`, `ENTRADAS_DE_CAIXA`,
`SAIDAS_DE_CAIXA`, `VARIACAO_DE_CAIXA`, `SALDO_A_PAGAR`, `SALDO_A_RECEBER`. São a base mínima; a DRE e a Visão Geral
acrescentarão definições **neste mesmo arquivo**.

## 5. Estados de fechamento

`ABERTA → FECHAMENTO_PRELIMINAR → FECHAMENTO_COM_PENDENCIAS → FECHAMENTO_HOMOLOGADO`
(preliminar pode ir direto a homologado). Com pendências exige a lista; homologado exige metodologia e permissão
`homologar`; voltar para `ABERTA` exige justificativa e, a partir de homologado, permissão `revisar`.

## 6. Testes (63, todos passando)

| Fase E | Arquivo |
|---|---|
| 1, 15 | `isolamento-autorizacao.test.js` (10) |
| 2, 13, 14 | `dinheiro-datas.test.js` (6), `transferencias-validacoes.test.js` (6) |
| 3, 11 | `vendas-canais.test.js` (9) |
| 4, 5, 6, 7, 8 + conservação e atomicidade | `titulos-liquidacoes.test.js` (10) |
| 9 | `transferencias-validacoes.test.js` |
| 10 + fechamento | `historico-fechamento.test.js` (7) |
| 12 + conciliação | `documentos-conciliacao.test.js` (7) |
| isolamento do código | `isolamento-estatico.test.js` (8) |

Execução: `cd backend` e `node --test test/financeiro-v2/`. Não precisam de banco, rede nem `.env`.

## 7. Pendências objetivas

| # | Pendência | Impacto | Quando |
|---|---|---|---|
| P1 | **Persistência PostgreSQL** (tabelas `fv2_*`, RLS, restrições, adaptador da porta) não existe. Depende de um banco de teste isolado, que não há hoje | Sem ela o núcleo não guarda dados reais | Antes de qualquer importação real |
| P2 | **Testes de integração** pendentes: atomicidade e concorrência reais (duas transações simultâneas), unicidade de origem externa e isolamento por RLS no banco | As garantias I10, I12, I13 estão provadas só no adaptador em memória | Junto com P1 |
| P3 | Adaptador de contexto (sessão → contexto v2) e tabela de concessões `financeiro_v2.*` por unidade | Sem ele não há rota | Quando houver a primeira rota |
| P4 | Identificadores reais da organização/unidade autorizada, em configuração | Núcleo não opera em ambiente real | Com P3 |
| P5 | Cofre de documentos (armazenamento privado e imutável dos originais) | Hoje só existe a ficha do documento | Execução 02 |
| P6 | Cancelamento/estorno de venda, recebível e movimentação; recorrência gerando obrigações futuras | Estruturas existem; operações não | Execuções seguintes |
| P7 | Plano de contas/categorias como cadastro (hoje é texto livre validado) | Necessário para a DRE | Antes da DRE |

Decisões materiais que dependem do responsável:

1. **Onde criar o banco de teste** do v2 (projeto Supabase separado ou Postgres local descartável).
2. **Destino do `02-referencia-setembro.md`** (repositório é público).
3. **Fechamento preliminar aceita escrita?** Hoje só o homologado bloqueia; preliminar e com pendências aceitam, sempre com histórico.
4. **Taxas de processador** entram como `DEDUCAO` da receita (adotado) ou como despesa financeira na DRE — é classificação, pode mudar sem alterar o modelo.

## 8. Preparação para a Execução 02 — Importações e fontes financeiras

O que já está pronto para receber as fontes:

- Catálogo de sistemas de origem (`SAIPOS`, `IFOOD`, `ANOTA_AI`, `STONE`, `UNICRED`, `FOODY`, `MANUAL`) e a regra de quais originam venda.
- Idempotência por origem externa em venda, obrigação, recebível, movimentação e transferência.
- Ficha de documento com SHA-256 e versão, para registrar cada arquivo antes de ler qualquer linha.
- Correspondência candidata/confirmada/divergente para ligar SAIPOS ↔ Stone ↔ extrato Unicred ↔ demonstrativo iFood.

Ordem sugerida: (1) P1 + P2 em banco de teste; (2) cofre de documentos; (3) leitores por fonte que produzem
**comandos** do núcleo (nunca gravam direto); (4) importação de setembro/2026 em banco de teste e conferência contra
`02-referencia-setembro.md`.
