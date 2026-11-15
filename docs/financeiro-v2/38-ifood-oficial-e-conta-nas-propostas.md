# 38 — iFood pelo demonstrativo oficial e conta da unidade nas propostas

> Documento público: **nenhum valor real**.

## Faturamento do iFood pelo demonstrativo oficial

**Decisão do proprietário:** o canal iFood usa o **relatório do iFood**, não a integração SAIPOS.

`registrarDemonstrativoIfood` (rota `/vendas/demonstrativo-ifood`; formulário em Configurações → Taxas Stone) faz tudo
numa transação:

- **Receita do canal iFood:** o valor das vendas do demonstrativo.
- **Recebível iFood com as retenções:**
  - comissões;
  - taxa do pagamento online;
  - mensalidade;
  - serviços e promoções, como "a classificar", porque o demonstrativo não decompõe.
- **Ajuste positivo:** como outras receitas.
- **Saldo do recebível:** é o faturamento líquido da plataforma, liquidado pelos repasses. **Nunca é depósito.**

Regras:

- O demonstrativo precisa fechar (vendas − taxas − serviços e promoções + ajustes = líquido informado).
- É idempotente por período.
- **Granularidade única:** não convive com vendas ou agregado iFood da SAIPOS no período, e é recusado nos dois sentidos.
  O agregado SAIPOS iFood é **rejeitado** (fica só para conferência) ou, se já tiver sido aplicado, **revertido** antes.
- A diferença entre SAIPOS e iFood fica como pendência documental. Nada é lançado para fazer as fontes coincidirem.

## Conta da unidade ao gerar propostas pela plataforma

`/propostas/gerar` usa a conta da unidade quando ela é **inequívoca**:

- extrato Unicred: a única conta bancária "Unicred" ativa;
- dinheiro de pedidos SAIPOS: o único caixa físico ativo.

Se a conta for ambígua ou não existir, a geração é recusada. Também é possível informar a conta explicitamente.
