# Financeiro v2 — 11. Contas a Pagar e Receber, Caixa e Bancos e Fluxo de Caixa (Execução 06A)

Data: 12/11/2026. Branch local `feat/financeiro-v2-contas-caixa-fluxo`, derivada de `df55fb4`.

> Público: só dados sintéticos. Nada foi publicado; nenhuma rota do aplicativo foi criada ou alterada; produção não foi acessada.

## 1. Diagnóstico (Fase A)

| Já existia no núcleo (Execuções 01–04) | Faltava para as consultas |
|---|---|
| Contas financeiras (`BANCARIA`, `CAIXA_FISICO`) | Saldo de conta: não havia ponto de partida (saldo inicial) |
| Obrigações com parcelas (um lançamento pelo total), recorrência mensal declarada, ajustes, cancelamento | Situações de gestão (vencido, aguardando classificação) e projeção de recorrências |
| Recebíveis (de venda com processador; avulsos com retenções e data prevista) | Distinção recebimento direto × operadora × repasse; “sem previsão confiável” |
| Liquidações 1:N e N:1 (uma movimentação quita vários títulos), estornos | Leitura do vínculo de cada movimentação |
| Movimentações e transferências internas (par saída + entrada) | Sessão de caixa físico: abertura, operações, fechamento com contagem |
| Correspondências com divergência | Consultas de lista, calendário, fluxo realizado/previsto, resumo da Visão Geral |
| Competências, homologação, concessões `financeiro_v2.*` | — |

**Nenhuma operação aprovada foi reescrita.** As novidades são uma camada de **consulta** (pura) e duas escritas novas e pequenas, com auditoria: o saldo informado de conta e a sessão de caixa.

## 2. Contratos implementados

### 2.1 Consultas (somente leitura, ação `financeiro_v2.ver`)

| Operação do núcleo | Entrada | Devolve |
|---|---|---|
| `consultarContasAPagar` | competencia?, vencimentoDe?, vencimentoAte?, contraparteId?, categoria?, situacao?, pagina, tamanho (≤ 100) | itens, totais do **conjunto filtrado**, porFornecedor, filtros disponíveis, paginação, recorrências sem registro |
| `detalharContaAPagar` | id | título, parcelas do grupo, o **único** lançamento econômico, pagamentos, documentos, histórico |
| `consultarContasAReceber` | competencia?, previstoDe?, previstoAte?, processador?, canal?, tipo?, situacao?, pagina, tamanho | itens, totais (com previsão, sem previsão, atrasado, em divergência), porDevedor |
| `detalharContaAReceber` | id | título com composição (bruto, retenções, ajustes, esperado), recebimentos, evidências, histórico |
| `consultarCaixaEBancos` | inicio, fim (≤ 400 dias), contaId?, pagina, tamanho | contas no período, consolidado, movimentos legíveis, pendências |
| `consultarCalendarioFinanceiro` | mes | um registro por dia + totais |
| `consultarFluxoDeCaixa` | inicio, fim, granularidade (`DIA`, `SEMANA`, `MES`) | realizado, previsto, sem previsão, projeção, série |
| `consultarResumoFinanceiro` | competencia | indicadores da Visão Geral (seção 8) |

Campos desconhecidos são recusados. **Organização e unidade vêm do contexto autenticado**: um filtro com `organizacaoId` é rejeitado e não amplia o escopo.

### 2.2 Escritas novas (com permissão, auditoria e histórico)

| Operação | Permissão | Regra |
|---|---|---|
| `registrarSaldoDeConta` | `registrar` | Saldo **informado** (extrato ou contagem) no início de um dia. Idempotente por conta e dia; um valor diferente no mesmo dia é conflito. Caixa físico não aceita saldo negativo. Nunca é reescrito. |
| `abrirCaixa` | `registrar` | Só em conta de caixa físico ativa, com uma sessão aberta por caixa. A abertura precisa ser posterior ao último fechamento e cair em competência editável. |
| `registrarOperacaoDeCaixa` | `registrar` | Entrada, saída, sangria ou suprimento. Sem conta de contrapartida, gera uma **movimentação sem vínculo**, que fica pendente de classificação. Com conta de contrapartida, gera uma **transferência interna** (ex.: depósito no banco). Tudo numa transação. |
| `fecharCaixa` | `registrar` | Exige `confirmar: true`. Calcula o teórico, que é a abertura mais as movimentações da conta no período. A diferença entre contado e teórico é registrada e, quando diferente de zero, exige justificativa. **Nenhum ajuste automático.** |

**Persistência.** Migração `0006_tesouraria.sql`, aplicada **apenas** no PostgreSQL local isolado, cria duas tabelas: `fv2_saldo_conta` e `fv2_sessao_caixa`. O próprio banco garante as regras:

- uma única sessão aberta por caixa (índice único parcial);
- `diferenca = contado − teorico`, `teorico = abertura + entradas − saídas` e justificativa obrigatória quando há diferença (CHECK);
- sessão fechada imutável e saldo informado não reescrito (gatilho, FV014);
- sem exclusão, histórico obrigatório e RLS por escopo.

## 3. Fórmulas e regras

### Títulos

```
saldo = valor original − pago (liquidações válidas) + ajustes documentados
```

**Situação a pagar**, verificada nesta ordem (vale a primeira regra que se aplicar):
1. CANCELADO, se o título foi cancelado;
2. PAGO, se o saldo é zero;
3. VENCIDO, se o vencimento é anterior a hoje e ainda há saldo;
4. AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA, se a categoria é provisória (`OUTRAS_DESPESAS`);
5. PARCIALMENTE_PAGO, se há pagamento parcial;
6. EM_ABERTO, nos demais casos.

**Vencer nunca marca como pago.**

**Situação a receber**, também na ordem:
1. CANCELADO;
2. RECEBIDO;
3. EM_DIVERGENCIA, se há correspondência DIVERGENTE;
4. ATRASADO, se a data prevista passou;
5. SEM_PREVISAO_CONFIAVEL, se falta data **com documento**;
6. PARCIALMENTE_RECEBIDO;
7. A_RECEBER.

**Tipo de recebível:**

| Tipo | Quando |
|---|---|
| RECEBIMENTO_DIRETO | Devedor é uma contraparte |
| RECEBIVEL_DE_OPERADORA | Nasceu de pagamento de venda |
| REPASSE | Demonstrativo avulso da processadora |

Stone, iFood e Anota AI são **devedores, não contas**. O recebível só aumenta o saldo da conta quando existe a movimentação de entrada correspondente.

**Sem dupla despesa.** Pagar parcelas, antecipar ou pagar parcialmente só cria liquidação. O lançamento econômico continua sendo um só, testado contra a DRE.

### Recorrências

A série é identificada por fornecedor, categoria, dia do mês e descrição, e projetada a partir da última obrigação real:

- o mês que **já tem** a obrigação real não recebe projeção, o que evita duplicidade;
- mês **passado** sem registro vira alerta (`recorrenciasSemRegistro`), nunca valor previsto;
- mês **futuro** entra no previsto como **estimado** e torna a projeção parcial;
- nada é gravado.

### Saldos de conta

```
saldo no início do dia D = último saldo informado até D + movimentações válidas desde ele até D−1
```

Sem saldo informado, o saldo é `null` ("Valor desconhecido"), **nunca zero**. Cada saldo informado posterior é comparado com o calculado; a diferença é **mostrada** (conciliação de saldos) e não corrige nada.

No consolidado de todas as contas, as duas pernas de cada transferência interna se anulam e não contam como entrada nem saída.

### Vínculo de movimentações (texto para o gestor)

Cada movimentação é explicada pelo que ela **liquida ou representa**: transferência, venda recebida, devolução, pagamento de conta(s), recebimento ou repasse agrupado. O que não tem vínculo fica como "Entrada/Saída sem vínculo identificado", pendente. **Nada vira receita ou despesa pelo sinal.** A descrição original do extrato é preservada como evidência.

## 4. Fluxo de caixa

| Bloco | Conteúdo |
|---|---|
| **Realizado** | Movimentações válidas do início do período até `min(fim, hoje)`, **sem** transferências internas (o valor anulado é informado à parte), agrupadas por natureza do vínculo |
| **Previsto** (só quando `fim ≥ hoje`) | **Saldo em aberto** das contas a pagar, pela data de vencimento. As vencidas e ainda em aberto entram na data de **hoje**, com o vencimento original indicado. Somam-se os recebíveis com previsão **documentada** e as recorrências estimadas. |
| **Sem previsão** | Recebíveis em aberto sem data documentada, atrasados ou em divergência: **fora** da projeção, listados à parte |
| **Projeção** | `saldo disponível hoje + entradas previstas − saídas previstas` |

A projeção não duplica nada porque o previsto usa só o saldo em aberto: o que já foi pago ou recebido está no saldo disponível. A projeção é **parcial** quando falta saldo informado, quando há recebíveis sem previsão ou quando inclui recorrências estimadas, e os motivos são listados.

**Série por dia, semana (segunda a domingo) ou mês.** O saldo disponível existe até hoje; no período atual, é o saldo de hoje. O saldo projetado é um campo separado. Previsão nunca se mistura com dinheiro já disponível. Datas de repasse Stone e iFood **não são presumidas**.

## 5. Páginas e componentes

A navegação ganhou **Contas a Pagar**, **Calendário**, **Contas a Receber**, **Caixa e Bancos** e **Fluxo de Caixa**. Continuam "em construção": Vendas e Recebimentos, Importações e Conferências, Configurações.

| Arquivo | Papel |
|---|---|
| `backend/src/modules/financeiro-v2/dominio/tesouraria.js` | Regras puras: situações, saldos, vínculos, recorrências, calendário, fluxo e resumo |
| `backend/src/modules/financeiro-v2/contratos/tesouraria.js` | Validação de filtros e comandos |
| `backend/src/modules/financeiro-v2/aplicacao/tesouraria.js` | Consultas, detalhes, saldo informado e sessão de caixa |
| `database/financeiro-v2/migracoes/0006_tesouraria.sql` | Tabelas e garantias no banco isolado |
| `frontend/financeiro-v2/telasTesouraria.js` | Telas puras (dados → HTML escapado) |
| `frontend/financeiro-v2/app.js` | Rotas, filtros locais, paginação, calendário, painel de detalhe |
| `frontend/financeiro-v2/formatar.js` | Rótulos de situação, devedores, naturezas e descrição legível |

**Detalhamento (Fase G)**, sempre no painel lateral com teclado (o foco vai para o fechar, Esc fecha e devolve o foco):

- **Contas a pagar:** fornecedor (agrupamento) → conta → parcelas do grupo → pagamentos (data, conta, se a saída foi agrupada) → documentos → histórico (saldo antes e depois, justificativas).
- **Contas a receber:** devedor → título → composição (bruto − retenções ± ajustes = esperado) → recebimentos (indica repasse agrupado) → evidências → histórico.
- **Caixa e Bancos:** conta → movimentação → vínculo (títulos quitados, com valores) → descrição original e documento do extrato.

Documentos aparecem por tipo, descrição e referência opaca, como "registrado, não acessível nesta versão". **Não há link, arquivo nem caminho.** Documento ausente vira a pendência "sem documento"; nenhum é inventado.

**Descrições.** Textos técnicos viram linguagem de gestor ("Venda BALCAO" → "Venda — Balcão", datas ISO → dd/mm/aaaa). A original fica disponível como evidência no `title` ou em "Original: …".

## 6. Calendário

O calendário é a grade do mês (segunda a domingo). Cada dia é um **botão** utilizável por toque e por teclado, com `aria-label` completo e marcadores para contas vencendo, vencidas, pagamentos feitos e recorrências previstas, além do valor em aberto. Tocar no dia mostra os títulos dele, com acesso ao detalhe.

- A navegação de mês (‹ ›) acompanha a competência.
- Hoje fica destacado.
- Recorrências do mês seguinte aparecem como "estimadas".

## 7. Caixa físico

O caixa físico funciona por sessão:

1. **Abertura** com o valor contado.
2. **Operações** durante a sessão: entradas, saídas, **sangria** (com conta de destino, vira transferência interna) e **suprimento**. Vendas em dinheiro entram como movimentação da conta, mas **não substituem a contagem**.
3. **Fechamento:** teórico × contado e diferença com justificativa.

A tela mostra as sessões (aberta e fechadas), as operações e as **diferenças de contagem não ajustadas** do período. O saldo da conta segue o calculado; nenhuma diferença é "zerada" automaticamente. Se uma movimentação for lançada depois do fechamento com data dentro da sessão, a sessão sinaliza que o teórico mudou e a contagem registrada é preservada.

## 8. Integração com a Visão Geral

Os cards secundários que eram "Indisponível nesta versão" agora vêm de `consultarResumoFinanceiro`, que chama **as mesmas funções** das telas detalhadas (testado igual, valor a valor):

| Card | Mostra |
|---|---|
| Saldo bancário | Posição em hoje. Sem conta mostra "Nenhuma conta deste tipo cadastrada"; sem saldo informado mostra "Valor desconhecido". |
| Caixa físico | Mesma regra do saldo bancário |
| Contas a pagar | Em aberto e vencido |
| Contas a receber | Saldo e o que não tem previsão confiável |
| Fluxo de caixa | Realizado na competência e saldo projetado em 30 dias, com a marca "parcial" quando for o caso |

Sem registros, aparece "Sem contas registradas" ou "Sem títulos registrados", **nunca R$ 0,00**. Faturamento Bruto, Líquido Gerencial e DRE **não foram alterados**; a ordem obrigatória da Execução 05 continua testada.

## 9. Segurança e autorização

- **Isolamento do módulo.** Os testes estáticos continuam **sem nenhuma exceção nova**: o módulo não importa nada de fora e não é importado por `backend/src`.
- **Exposição.** Nenhuma rota do aplicativo foi criada ou alterada.
- **Demonstração.** O servidor local (`127.0.0.1:5179`) continua **somente leitura**. As escritas novas existem no núcleo, com permissão, confirmação e auditoria, mas **não são expostas** na demonstração, porque a sessão ali é simulada por um seletor e uma escrita "funcionando" seria sucesso simulado. **Bloqueio documentado:** formulários reais de abertura, fechamento e saldo informado dependem da integração com o login real (mesmo bloqueio do doc 10).
- **Respostas.** Identificadores internos saem como referências opacas e voltam a ser ids **dentro** do tratador. Um título de outra unidade não abre (404), porque o escopo da sessão prevalece.

## 10. Testes

| Arquivo | Cobre |
|---|---|
| `backend/test/financeiro-v2/tesouraria.test.js` (memória e PostgreSQL) | Itens 1–25 e 28–30 da Fase J com o núcleo real: aberta, parcial, paga, vencida e sem documento; parcelada (uma despesa na DRE, antecipação); recorrência sem duplicidade e calendário; recebível pendente, parcial, sem previsão, repasse agrupado e divergência; saldo bancário, transferência e movimentação sem vínculo; caixa físico, fechamento e diferença; fluxo realizado, previsto e projetado; isolamento, permissões e competência homologada; resumo × consultas; desconhecido ≠ zero; paginação |
| `backend/test/financeiro-v2/postgres-tesouraria.test.js` | O **banco** recusa segunda sessão aberta, diferença fora da conta, sessão fechada alterada, saldo reescrito e exclusão |
| `frontend/test/financeiroV2Tesouraria.test.js` | Telas sobre o motor real e o cenário sintético: detalhe até o documento sem link, operadora ≠ conta, sessões, calendário (30 dias e recorrência estimada), fluxo parcial explicado, Visão Geral = consultas, 401/403/escopo e ausência de UUID em todas as consultas novas, troca rápida de filtros (26), regras responsivas (27), descrições legíveis |

**Inspeção visual** no navegador integrado (demo local, dados sintéticos):

- **Desktop:** Contas a Pagar com filtros e detalhe pelo teclado; calendário com clique no dia; Contas a Receber; Caixa e Bancos com sessões e diferença; Fluxo com série semanal; Visão Geral com os novos cards.
- **Celular (375 px):** todas as 7 telas sem rolagem horizontal; tabelas em cartões; calendário tocável.
- **Problemas encontrados e corrigidos na inspeção:**
  1. a semana atual mostrava saldo disponível desconhecido;
  2. aparecia "projeção parcial" em período passado;
  3. transbordamento no celular por um seletor de fornecedor longo e pelo cabeçalho oculto da tabela;
  4. descrições de entregas com data ISO.

## 11. Limitações e pendências

- **Integração com login real e formulários de escrita:** bloqueada (§ 9). As operações de caixa e saldo informado só são exercidas pelos testes.
- **Previsão de recebimentos:** não existe regra validada de prazo de repasse Stone, iFood ou Anota AI. Sem documento, tudo fica "sem previsão confiável".
- **Recorrência:** projetada pelo **último valor** da série (estimada); apenas a periodicidade mensal existe no núcleo.
- **Conciliação de saldos:** a comparação informado × calculado é só exibição. Tratar a diferença (ex.: tarifa não lançada) é tarefa de classificação.
- **Classificação provisória:** usa a categoria `OUTRAS_DESPESAS` como sinal. Uma marca explícita de "provisória" por título pode substituí-la.
- **Documentos:** continuam não acessíveis, porque não há cofre de produção.
- **Áreas restantes:** Vendas e Recebimentos, Importações e Conferências e Configurações continuam em construção (Execução 06B em diante).
