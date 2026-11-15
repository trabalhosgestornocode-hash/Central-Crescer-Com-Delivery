# 35 — Taxas contratadas da Stone × taxas cobradas

> Documento público: **nenhuma taxa, valor ou transação real**. A conferência de setembro está no relatório privado.

## O que existe

- **Tabela contratada** por modalidade e bandeira (débito, crédito à vista e Pix na maquininha).
  - Tem vigência (início e fim), fonte documental e prazo de recebimento.
  - Fica gravada na configuração da unidade: histórico e versão, sem migração.
  - Rota `/configuracoes/taxas-contratadas`, com uma linha por taxa (`MODALIDADE;BANDEIRA;PERCENTUAL`).
  - Repetir a mesma tabela não faz nada. Vigências sobrepostas são recusadas.
  - Percentual 0% é recusado: modalidade sem taxa fica fora da tabela.
- **Conferência** `consultarTaxasContratadas` (rota `/taxas-contratadas`; tela Configurações → Taxas Stone), sobre os
  registros importados do relatório de vendas Stone.
  - Cada transação recebe: modalidade, bandeira, bruto, taxa cobrada (milionésimos informados pela Stone), taxa contratada
    (bruto × percentual, centavo meio-para-cima), líquido informado e líquido esperado.
  - Cada transação fica numa situação: `CONFERE`, `DIFERENTE_DO_CONTRATADO`, `SEM_TAXA_CONTRATADA` (nunca 0%),
    `SEM_TABELA_VIGENTE` ou `PARCELADA_A_CONFERIR` (o crédito é só à vista: parcelada vira divergência, sem descartar).
  - A composição sai por modalidade × bandeira.
  - Os totais saem em duas leituras: soma **exata** dos milionésimos (arredondada uma vez) e soma das taxas
    **arredondadas por transação**. A diferença é fração de centavo e fica explícita.

## Regras

- A referência principal é o que a Stone informou. O contratado serve para conferir e nunca substitui o valor cobrado.
- O cálculo é individual, por transação. Nunca se usa taxa média.
- Pix da maquininha (produto Pix no relatório Stone) não se confunde com Pix direto na conta bancária, que vem do extrato.
- Vendas processadas, líquido informado e depósito efetivo são coisas diferentes. O depósito vem do extrato.

## Limites conhecidos

- **Fim da vigência:** ainda não existe ação para encerrar uma tabela já registrada. Uma tabela nova precisa de vigência
  que não se sobreponha.
- **Taxa da Stone na DRE:** ela entra quando a transação Stone é ligada a uma venda (vendas por pedido). Com o faturamento
  por **total do período por canal** (doc 34), não há venda individual para ligar. A taxa do período precisa de um
  lançamento próprio, que ainda não foi implementado.

## Testes

`taxas-contratadas.test.js`:

- validação da tabela;
- vigência e idempotência;
- conferência por transação: contratado = cobrado;
- Pix truncado;
- vale sem taxa;
- soma exata × arredondada;
- parcelada;
- sem tabela vigente.

Tela: `frontend/test/financeiroV2OperacaoReal.test.js`.
