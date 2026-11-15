# 34 — Faturamento de setembro por canal: total do período por canal

> Documento público: **nenhum valor real**. A conferência de setembro, com valores, está num relatório privado fora do
> Git.

## Problema

O requisito é mostrar setembro separado em Balcão, iFood e Anota Aí. Os relatórios reais disponíveis são três, e não
são equivalentes:

| Relatório SAIPOS | Granularidade | Canal | Uso |
|---|---|---|---|
| Faturamento por dia (PDF) | total do dia, líquido de descontos (identidade comprovada) | não | controle |
| Formas de pagamento (XLSX) | total por forma e por dia | não (forma ≠ canal) | dinheiro e conferência |
| **Desempenho por atendente** ("Canais de Venda", XLSX) | **total do período por atendente**; as integrações identificam o canal | **sim** | **faturamento por canal** |
| Vendas por pedido | pedido a pedido, com canal | sim | conciliação detalhada (sem amostra real) |

## Solução mínima (sem pedidos inventados)

1. **Leitor `SAIPOS_DESEMPENHO_POR_ATENDENTE`**, conferido com o layout real.
   - Gera um registro por atendente. O total se repete em cada item e as repetições ficam como duplicadas, nunca somadas.
   - `integration-ifood` é iFood; `integration-api-int-sale` é Anota Aí.
   - Atendente humano é Balcão, anotado como "canal deduzido do atendente".
   - Integração desconhecida fica a classificar.
2. **Proposta `VENDA_AGREGADA` com `metodologia: TOTAL_DO_PERIODO_POR_CANAL`.**
   - Uma receita por canal, datada no último dia do período e marcada como total do período.
   - Sem pedido, forma de pagamento ou recebível.
   - Entra pelo fluxo normal: importar, gerar, aprovar e aplicar.
3. **Granularidade única.** A aplicação recusa receita duplicada nestes casos:
   - total do período de um canal × pedidos desse canal no período;
   - total do período × agregado diário sem canal no período;
   - dois totais do mesmo canal com períodos sobrepostos.

   As vendas da competência entram em fila: há uma trava por competência.
4. **Substituição explícita.** `reverterPropostaAgregada` cancela o lançamento (nunca apaga) e então os pedidos do
   relatório detalhado podem ser aplicados. Isso fica no histórico e na auditoria.

O relatório por pedido **não é indispensável para iniciar**. Ele é necessário para:

- a conciliação venda a venda (Stone, iFood);
- os descontos por canal;
- explicar as diferenças entre fontes.

## Testes

- `requisitos-operacao-real.test.js` (1b):
  - três canais;
  - duplicatas do arquivo;
  - canal deduzido;
  - reimportação;
  - pedido do mesmo canal recusado;
  - reversão e substituição.
- Quadro de compatibilidade: o leitor novo é "amostra real" só em XLSX.
- Ensaio privado com os arquivos reais de setembro, só em memória local:
  - a soma dos canais é igual ao total do faturamento por dia;
  - o saldo do extrato Unicred fecha;
  - reimportar não duplica.
