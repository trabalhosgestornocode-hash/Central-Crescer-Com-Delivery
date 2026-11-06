# DRE Gerencial de Referência — especificação (protótipo)

Status: **PROTÓTIPO**. Regras parametrizáveis e **não aprovadas**. Roda só em banco descartável. Não substitui nenhum relatório existente.

## 1. Três visões separadas (nunca misturadas)
| Visão | Critério | Fonte | Situação |
|---|---|---|---|
| **Fluxo de Caixa** | caixa (data do movimento) | `fin_lancamentos` (extrato/livro-caixa) | em produção (Gestão Financeira) |
| **DRE Gerencial de Referência** | misto **por categoria**: caixa, competência ou fora do DRE, com rateios | contas a pagar (`fin_obrigacoes`/`fin_pagamentos`, migration 151) + vendas registradas | protótipo (`financeiro-calculos/dreGerencialReferencia.js`) |
| **DRE por Competência** | competência contábil | — | só depois de a contadora validar a metodologia (INC-013) |

Cada visão tem a sua tela e a sua rota, e cada resultado sai rotulado com a visão e a versão das regras. A Visão de Referência nunca altera lançamentos nem o Fluxo de Caixa.

## 2. Fórmula
```
Linha(L, mês) = Σ pagamentos do mês          (categorias com critério "caixa",       linha L)
              + Σ valor ORIGINAL das contas  (critério "competencia", competência = mês, sem rateio, linha L)
              + Σ rateios do mês             (contas rateadas, linha L)
              + fontes informadas            (ex.: faturamento bruto das vendas)
```
- O acréscimo presumido (pago acima do original) **não** entra pela competência: ele só entra quando a contadora o classificar.
- Conta cancelada não entra.
- Categoria sem regra deixa o resultado marcado como **PARCIAL**.

Indicadores:
- deduções;
- faturamento líquido = bruto − deduções;
- CMV;
- custos totais = CMV + entregas;
- despesas variáveis;
- despesas fixas;
- MC = líquido − custos totais − variáveis;
- MC% = MC ÷ bruto;
- resultado = MC − fixas;
- margem líquida;
- PE = fixas ÷ MC%;
- PE financeiro = (fixas + parcelas de dívida) ÷ MC%. Sem cadastro de dívidas, fica **indisponível**, nunca zero.

## 3. Parâmetros (`regras`)
- `versao` e `aprovada` (a contadora aprova uma versão; o resultado informa qual versão usou).
- `linhas`: código, descrição e grupo.
- `porCategoria`: `{ linha, criterio }`, com critério `caixa`, `competencia` ou `fora`.
- `grupos`: quais linhas compõem receita, deduções, CMV, entregas, variáveis e fixas.
- `fontes`: linhas alimentadas por fontes informadas (vendas, descontos, taxas retidas).
- `rateios`: hoje chegam como parâmetro, porque o sistema ainda não tem tabela de rateios.

## 4. Rastreabilidade
Cada linha devolve a lista das parcelas (`origens`): tipo (pagamento, obrigação, rateio ou fonte), identificador de origem (`central:CP:<ID>`, `central:PAG:<ID>`) e valor.

## 5. Limitações conhecidas e decisões pendentes
1. **Regras por categoria do sistema × categoria de origem.** Quando duas categorias de origem com linhas ou critérios diferentes caem na mesma categoria do sistema, a regra por categoria não as separa. Duas soluções, que dependem de decisão:
   - (a) criar categorias distintas no plano de contas;
   - (b) guardar a "linha gerencial" em cada conta a pagar.
2. **Rateios** (dias de consumo, produção): precisam de uma tabela própria e de aprovação.
3. **Dívidas** (PE financeiro, parcelas), **terceiros** (retenções) e **entre empresas**: precisam de cadastros próprios. Hoje ficam indisponíveis.
4. **Descontos e cancelamentos de vendas:** o sistema não os registra separadamente.

## 6. Publicação
O protótipo não tem rota nem tela. A publicação exige:
- regras aprovadas (versão `aprovada: true`);
- decisões dos itens 5.1 e 5.2;
- testes;
- uma rota de leitura protegida pela mesma permissão de leitura financeira, atrás do flag do Financeiro 2.0.
