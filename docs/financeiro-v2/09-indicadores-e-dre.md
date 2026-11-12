# Financeiro v2 — 09. Motor de indicadores e DRE Gerencial (Execução 04)

Data: 12/11/2026. Branch local `feat/financeiro-v2-indicadores`, derivada de `5d85030`.

> Público: sem valores, nomes ou identificadores reais.

## 1. Diagnóstico (Fase A) e correção antes das fórmulas

- **Problema conceitual corrigido.** Na 03B, um desconto marcado como financiado por terceiro gerava **recebível do terceiro automaticamente**, só pelo campo. Isso inflaria o "a receber" e esconderia uma dedução possível.
  - Agora o recebível só nasce com **documento que comprove o ressarcimento** (`documentoId` do desconto).
  - Sem documento, o desconto vira dedução **a classificar**, com financiador `TERCEIRO_NAO_COMPROVADO`, sem recebível.
- **Nome da categoria.** A categoria de entregadores passou a se chamar **"Entregadores Próprios (Motoboys)"**. O nome genérico "Frete" não é usado.
- **Plano de contas, vendas, obrigações e competências:** a revisão dos testes existentes não mostrou outras inconsistências. Os 198 testes anteriores continuam passando.

## 2. Arquitetura

O motor tem duas camadas:
- **`dominio/apuracao.js`** é **puro**. Recebe os registros de um escopo e uma competência e devolve:
  - todos os indicadores;
  - a DRE;
  - "cada R$ 100";
  - as pendências;
  - as entradas usadas.
- **`aplicacao/apuracao.js`** carrega os registros e calcula a **impressão** (SHA-256 das entradas e da metodologia), que torna a apuração reprodutível.

Consultas expostas:
- `apurarCompetencia` — DRE completa;
- `apurarVisaoGeral` — os **mesmos objetos** da DRE;
- `composicaoDoIndicador` — "Ver composição completa".

Nenhuma tela calcula fórmula. A Visão Geral consome os objetos da apuração; um teste garante bruto, resultado e impressão idênticos aos da DRE.

**Cada indicador traz:**
- código, nome, descrição, competência, organização e unidade;
- fórmula e valor (em centavos, ou **nulo** quando desconhecido);
- unidade, componentes (a árvore), metodologia (`DRE_GERENCIAL_SEM_AJUSTE_DE_ESTOQUE`, versão `v1`);
- situação, pendências, data da apuração e percentual sobre o bruto.

## 3. Situação de confiabilidade

A situação é avaliada **por indicador**: só o que é afetado pela pendência perde confiabilidade. Da mais grave para a menos grave:

| Situação | Quando |
|---|---|
| BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE | Nenhum registro econômico na competência (o valor é **nulo**, não zero), ou sobreposição agregado × pedidos |
| PENDENTE_DE_CLASSIFICACAO | Desconto a classificar ou saída bancária sem obrigação |
| PARCIAL | Proposta de venda, agregado ou outra operação ainda não aplicada (inclui agregado com metodologia desconhecida) |
| CONFIRMADO | Competência homologada, sem pendências |
| CALCULADO_AGUARDANDO_CONFERENCIA | Fechamento com pendências |
| PRELIMINAR | Competência aberta ou em fechamento preliminar, sem pendências |

O cálculo correto, a evidência documental e a homologação são coisas separadas: um valor pode ser calculado e continuar preliminar.

## 4. Fórmulas e DRE

Cada lançamento ativo entra **uma** vez, na linha da sua classificação. A natureza vem da categoria.

| Linha | Composição |
|---|---|
| (+) Faturamento Bruto Próprio | receitas de `RECEITA_OPERACIONAL` (bruto próprio da composição; agregado = bruto recuperado) |
| (−) Deduções Comerciais | todos os lançamentos de natureza DEDUÇÃO (descontos da loja, descontos a classificar, devoluções, tributos de natureza dedução) |
| (=) Receita Líquida Comercial | bruto − deduções |
| (−) Custos Operacionais Gerenciais | despesas de `CUSTOS_OPERACIONAIS` (insumos pela competência da compra) |
| (=) Resultado Após Custos | |
| (−) Despesas Operacionais e Comerciais | comerciais (inclui Entregadores Próprios (Motoboys) e comissões), recebimento e processamento (taxas Stone), administrativas, pessoal, marketing (anúncios), plataformas (mensalidades), tributos de natureza despesa |
| (+/−) Resultado Financeiro | receitas − despesas de `DESPESAS_FINANCEIRAS` (juros, tarifas, antecipação comprovada) |
| (+/−) Demais Efeitos Gerenciais | receitas − despesas de `OUTROS_EFEITOS_GERENCIAIS` |
| **(=) Resultado Gerencial — Sem Ajuste de Estoque** | soma algébrica das linhas acima; **não** é lucro contábil auditado |

**Fora do resultado:**
- lançamentos patrimoniais (principal de empréstimo, aportes, imobilizado), listados à parte;
- movimentações, recebimentos, pagamentos, transferências, recebíveis e saldos bancários.

**Tributos:** a posição segue a natureza da categoria. O regime tributário não é presumido.

## 5. Faturamento bruto por canal (indicador principal)

- **Canais:** os principais são Balcão, iFood e Anota AI, mais os que aparecerem.
- **Receita sem canal comprovado** (relatório agregado) fica em **`NAO_IDENTIFICADO`**, com `comprovado: false`. Nunca vai para Balcão por exclusão.
- **Componentes da receita:** produtos, acréscimos próprios e serviços próprios (da composição da venda). O agregado aparece como "agregado sem detalhe", e vendas antigas sem composição aparecem como "sem composição".
- **Valores de terceiros** não entram, porque o contrato da venda os recusa.
- **Descontos, cancelamentos e devoluções** são deduções ou cancelamentos e não reduzem o bruto.

## 6. Faturamento líquido gerencial por canal

- **Fórmula, por canal:** bruto do canal − deduções do canal − despesas atribuídas ao canal. As despesas atribuídas são os ajustes de recebível do canal (comissões, taxas, anúncios, mensalidades, antecipação), cada um pela sua classificação.
- **É uma leitura analítica:** não cria lançamento.
- **Sem dupla contagem:** resultado gerencial = Σ líquidos dos canais − despesas sem canal (testado).
- **Recebíveis e repasses** por processador são apresentados **à parte** (`reconciliacaoComRepasses`). O líquido gerencial não é o depósito bancário.

## 7. Composição hierárquica

A árvore desce em cinco níveis: indicador → categoria → subcategoria (pelo plano de contas) → lançamento → documentos de origem.

Cada nó traz: identificador, nome, natureza, valor com sinal, percentual do bruto, origem, situação, filhos e referências (registro, fonte, proposta e documentos).

As folhas também podem trazer o **detalhe**:
- a composição da venda;
- para **Entregadores Próprios (Motoboys)**: as obrigações com valor reconhecido, pago, saldo e vencimento, mais os pedidos, as taxas rejeitadas e as canceladas, quando vieram de proposta.

A soma dos filhos é **exatamente** o valor do nó, em centavos inteiros (testado em toda a árvore). Não existem nós vazios e nada é inventado.

## 8. Cada R$ 100

- **Grupos:** deduções, custos, despesas operacionais, resultado financeiro, demais efeitos e resultado gerencial.
- **Cálculo:** a participação de cada grupo é calculada sobre o faturamento bruto, em centésimos de ponto percentual, arredondada por **maior resto**. A soma é exatamente 100,00%.
- **Prejuízo** aparece como parte negativa (por exemplo, custos 150,00% e resultado −50,00%). Nada é forçado a ser positivo.
- **Bruto zero ou desconhecido:** não há percentuais, e a limitação é informada.

## 9. Descontos, subsídios e competência

- **Descontos e subsídios:**
  - desconto da loja → dedução;
  - subsídio de terceiro **com** documento → recebível do terceiro, sem dedução;
  - subsídio sem documento, ou financiador desconhecido → dedução **provisória** a classificar, com pendência explícita e situação PENDENTE_DE_CLASSIFICACAO. Não prova que a loja suporta o desconto.
  - Nenhum lançamento compensatório artificial é criado.
- **Competência:**
  - a despesa pertence à competência reconhecida;
  - pagamento em outro mês é liquidação, e o mês do pagamento continua **desconhecido** (nulo) se não houver outros lançamentos;
  - competência homologada sem pendências é a única CONFIRMADA.

## 10. Testes e mutações

`apuracao.test.js` tem 9 testes que cobrem os 30 itens obrigatórios. A numeração está no nome de cada teste. Rodam em memória e no PostgreSQL isolado.

**Teste de mutação**, com cópia de segurança, restaurado byte a byte. Todos os mutantes foram pegos:
1. taxas contadas duas vezes;
2. desconto subtraído duas vezes;
3. recebimento tratado como receita;
4. pagamento tratado como despesa;
5. sobreposição agregado × pedidos ignorada.

## 11. Prévia privada de setembro (resultado técnico, sem valores)

A prévia gerou propostas a partir dos arquivos reais, **sem aplicar nenhuma**, e apurou a competência:
- **SAIPOS:** os 30 dias agregados têm composição comprovada (valor líquido = componentes − descontos), sem dupla dedução.
- **Stone:** as transações ficaram **aguardando evidência**, porque não há vendas por pedido aplicadas; nenhuma gerou faturamento.
- **Unicred:** as movimentações viraram propostas sem efeito econômico.
- **Divergência SAIPOS** (faturamento × formas de pagamento): continua **aberta**, com as formas atípicas rastreadas.
- **Apuração financeira:** faturamento e resultado **desconhecidos** (BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE), enquanto o controle operacional agregado existe à parte. Isso demonstra a diferença entre o indicador operacional e o financeiro confirmado.

Os números ficam no relatório privado, fora do Git.

## 12. Limitações e condições para a interface (Execução 05)

- Setembro **não** está homologado e nenhuma proposta real foi aplicada.
- **Financiador dos descontos SAIPOS:** não está documentado, então as deduções seguem a classificar.
- **Documentos que faltam:** SAIPOS por pedido (para o canal e para a investigação da divergência), recebimentos Stone, apuração iFood e Foody reais.
- **Faturamento por canal** em setembro depende do relatório por pedido; o agregado fica em NAO_IDENTIFICADO.
- **Para a interface:**
  - consumir só `apurarCompetencia`, `apurarVisaoGeral` e `composicaoDoIndicador`;
  - exibir a situação e as pendências de cada indicador;
  - mostrar "desconhecido", e não zero, quando o valor for nulo;
  - a ordem de destaque é: faturamento bruto por canal, depois o faturamento líquido gerencial.
