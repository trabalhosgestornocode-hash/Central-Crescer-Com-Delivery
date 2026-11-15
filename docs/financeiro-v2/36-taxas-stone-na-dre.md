# 36 — Taxas Stone na DRE quando o faturamento é por total do período

> Documento público: **nenhum valor real**.

## Problema

A tarifa Stone entrava na DRE só por venda: o pagamento Stone aplicado gera um ajuste no recebível da venda. Com o
faturamento importado como **total do período por canal** (doc 34), não há venda individual a que ligar a transação.
A tarifa ficava fora da DRE.

## Solução (sem migração)

`reconhecerTaxasDoPeriodo` (rota `/importacao/reconhecer-taxas`; botão em Configurações → Taxas Stone) cria, **uma vez
por importação Stone e competência**, um lançamento de despesa:

- **Valor:** soma EXATA das tarifas efetivamente cobradas, em milionésimos de real informados pela Stone, arredondada uma
  única vez. Não há arredondamento prematuro por transação nem lançamento artificial de fração de centavo.
- **Categoria:** `TAXAS_STONE` (despesa de recebimento/processamento); sem o plano ACAITERIA, `TAXAS_DE_PROCESSAMENTO`.
- **Competência:** a da transação (data da venda na Stone).
- **Rastreabilidade:**
  - origem: a importação;
  - fonte: STONE, com chave própria;
  - composição por modalidade × bandeira guardada no lançamento;
  - critério e natureza explícitos.
- **O que não vira receita:** nem o bruto Stone nem o líquido Stone. O faturamento continua sendo o dos canais.
- **Vale com tarifa efetiva cobrada:** entra pelo valor cobrado, mesmo sem taxa contratada (que segue como pendência na
  conferência).

### Uma única vez

| Situação | Comportamento |
|---|---|
| Reconhecer de novo, ou reimportar o mesmo arquivo | repetido, nada novo |
| Transações cuja tarifa já entrou por venda (pagamento Stone aplicado) | excluídas do total do período |
| Aplicar um pagamento Stone por venda da mesma importação com as taxas do período ativas | **recusado** |
| Substituição por pedidos | estornar as taxas do período (`/importacao/estornar-taxas`, lançamento cancelado, nunca apagado); aplicar por venda; reconhecer de novo |

Na substituição, o novo reconhecimento é uma versão nova, que cobre só o que ficou sem venda.

Trava por competência entre total do período, pagamentos Stone e vendas.

## Testes

`taxas-contratadas.test.js`:

- soma exata uma vez;
- bruto e líquido Stone não viram receita;
- repetição;
- reimportação da Stone e dos canais;
- estorno;
- substituição por pedidos (recusa, estorno, venda e período só com o resto).

Ensaio privado com os arquivos reais de setembro: a tarifa reconhecida é igual à soma exata da conferência por
transação.
