# Financeiro v2 — 08. Composição de vendas, descontos e receitas agregadas (Execução 03B)

Data: 12/11/2026. Branch local `feat/financeiro-v2-composicao`, derivada de `1760c5d`.

> Documento público: sem valores, nomes ou identificadores reais.

## 1. Fórmulas

| Componente | Definição |
|---|---|
| Receita própria (faturamento bruto da venda) | itens + acréscimos + serviços que pertencem à empresa (`brutoCentavos`) |
| Descontos próprios | descontos financiados pela LOJA + descontos com financiador PENDENTE |
| Subsídios de terceiros | descontos financiados por TERCEIRO (iFood, outro) |
| Valor cobrado do consumidor | receita própria − descontos próprios − subsídios de terceiros |
| Devido por intermediários | pagamentos com processador (Stone, iFood…) + subsídios de terceiros (recebíveis) |
| Pendente da venda | receita − descontos próprios − devolvido − pago (o subsídio entra como pago: é recebível do terceiro) |

**Efeitos de cada componente:**
- **Receita própria:** uma única receita ativa por venda válida.
- **Descontos próprios:**
  - da LOJA: lançamento de **dedução comercial** (`DESCONTOS_COMERCIAIS`);
  - PENDENTE: dedução em `DESCONTOS_A_CLASSIFICAR`, a categoria de sistema para "financiador não comprovado".
- **Subsídio de terceiro:** **não** é dedução nem receita adicional; vira um pagamento do terceiro (recebível dele).
- **Taxas** (Stone, comissões, transação): despesas, como ajuste do recebível. Ficam sempre separadas do desconto comercial.

**Proteções no banco** (migração `0005_composicao_venda.sql`):
- `descontos_centavos ≥ 0`;
- `pago + devolvido + descontos ≤ receita`;
- a receita da venda continua única e do valor bruto próprio. A conferência do banco só conta lançamentos de **receita**, então as deduções ligadas à venda não a afetam.

A composição original fica gravada na venda (`composicao`).

## 2. Contrato e compatibilidade

- `registrarVenda` aceita `composicao` (opcional): itens, acréscimos, serviços e `descontos[]`, cada desconto com `financiador` (LOJA, TERCEIRO ou PENDENTE) e, para terceiro, o `terceiro`.
- O contrato recusa:
  - `brutoCentavos` diferente de itens + acréscimos + serviços ("nunca o valor após descontos");
  - descontos acima da receita;
  - terceiro indicado em desconto que não é de terceiro;
  - pagamentos que não fecham com o valor a cobrar.
- **Venda sem composição** segue exatamente o contrato anterior: todos os testes anteriores passam sem alteração.
- **Valores cobrados em nome de terceiros:** são **recusados** por enquanto, porque exigem uma obrigação com o terceiro. É uma pendência explícita.

## 3. Descontos por pedido (SAIPOS)

- A proposta de venda recupera o **bruto próprio** dos componentes do pedido: itens + acréscimo + taxa de entrega. Nunca usa o total cobrado.
- O relatório não informa quem financia o desconto. Por isso ele entra como **PENDENTE**, com a divergência `FINANCIADOR_DO_DESCONTO_NAO_COMPROVADO`, e nunca é presumido da loja.
- **Taxa de entrega em pedido iFood:** a proposta vai para revisão (`TITULARIDADE_DA_TAXA_DE_ENTREGA_A_CONFIRMAR`), porque não se presume se a taxa é da loja ou do iFood.

## 4. Agregados SAIPOS (faturamento por dia)

**O que o valor do dia representa.** Na exportação real de setembro, em **todos** os dias, vale:

itens + entrega + serviço + acréscimos − descontos = valor das vendas

Ou seja, o valor do dia é **líquido de descontos**. A comprovação foi feita na análise privada da 02B e é refeita **em cada dia** de cada arquivo.

**Metodologia por dia:**

| Metodologia | Quando | Efeito |
|---|---|---|
| `VALOR_LIQUIDO_COMPOSICAO_COMPROVADA` | a identidade fecha | receita = bruto recuperado; dedução = descontos (a classificar). O valor líquido do relatório **não** sofre nova dedução. |
| `DESCONHECIDA` | faltam componentes (ex.: relatório só com totais) ou a identidade não fecha | proposta AGUARDANDO_EVIDENCIA. O registro de origem fica como **controle agregado**, sem efeito econômico; aprovar e aplicar são recusados. |

**O que nunca acontece com o agregado:**
- não ganha pedido, canal, pagamento nem processador inventados;
- a receita usa a categoria de sistema `VENDAS_AGREGADAS_SEM_CANAL`;
- não coexiste com os pedidos do mesmo dia: a aplicação recusa.

**Substituição atômica** (`substituirAgregadoPorPedidos`). Numa única transação, com trava exclusiva do dia:
1. os lançamentos do agregado são cancelados (não apagados) e o agregado fica SUBSTITUÍDO, com justificativa no histórico;
2. cada pedido **aprovado** do mesmo dia é aplicado.

Falha no meio desfaz tudo. Substituições concorrentes: só uma vence, e a outra encontra o agregado já substituído e é recusada (testado).

**Taxa de entrega no agregado:** entra como componente da receita bruta, mas a titularidade (loja × plataforma) dos pedidos iFood segue como pendência documental (§ 9).

## 5. iFood

- A **receita** é a venda própria.
- A **promoção financiada pela loja** é dedução comercial.
- A **promoção financiada pelo iFood ou outro terceiro** é subsídio: vira recebível do terceiro e não reduz a receita. Na apuração, é só informativa.
- **Comissão, transação, serviços (entrega sob demanda), mensalidade e anúncios** são despesas, cada uma pela sua natureza.
- **Antecipação** é encargo financeiro, contado uma vez, porque já está na apuração.
- **Ajustes, serviços descontados e taxa adicional cobrada do consumidor** ficam **a classificar**. A taxa ao consumidor não vira receita automática da loja.
- **Repasse** é liquidação, nunca resultado.
- `composicaoIfood(componentes)` calcula o **líquido gerencial do canal** somando cada componente **uma vez**, pela sua natureza, e confere com o repasse previsto. O detalhamento por natureza (receita, dedução, despesa, a classificar) é o que a futura DRE usa.
- O iFood real continua **não homologado**: não há documento compatível.

## 6. Stone

- A cadeia é preservada: venda econômica → pagamento processado (forma, processador STONE) → recebível bruto → repasse (liquidação) → crédito bancário.
- **Taxa Stone:** despesa de recebimento (`TAXAS_STONE`), como ajuste do recebível. Os milionésimos originais ficam na proposta, e o centavo é arredondado explicitamente.
- **Desconto comercial:** pertence à **venda** (composição) e nunca é confundido com a taxa (testado).
- **Canal:** nunca é deduzido da maquininha.

## 7. Cancelamentos e ajustes

- **Estorno de pagamento:**
  - parcial ou total, por devolução ao cliente: dedução `DEVOLUCOES_E_ESTORNOS`; se o dinheiro tinha entrado em conta, também uma saída;
  - por correção: a venda volta a ter valor pendente.
- **Cancelamento de venda:**
  - com dinheiro já recebido, exige primeiro a compensação (estorno do pagamento ou da liquidação);
  - ao cancelar, são cancelados **juntos** a receita, as devoluções e **os descontos** da venda, e os recebíveis em aberto (com suas taxas).
- **Fonte corrigida:** a nova proposta fica AGUARDANDO_REVISAO, e a composição aplicada permanece intacta até a reversão explícita.
- **Competência homologada:** bloqueia venda e aplicação de proposta.
- Nenhum ajuste artificial é usado para fazer números coincidirem.

## 8. Testes

`composicao.test.js` tem 10 testes que cobrem os 18 itens obrigatórios. A numeração está no nome de cada teste:
- venda sem desconto e com desconto da loja;
- subsídio integral e dividido;
- pagamento misto;
- taxa Stone × desconto;
- iFood com múltiplas deduções e composição gerencial;
- bruto recuperado de pedido com desconto;
- agregado líquido, comprovado e desconhecido;
- substituição atômica e concorrente;
- estorno parcial e cancelamento após recebimento;
- competência homologada;
- fonte corrigida;
- rastreabilidade da composição até a coluna original do documento.

Os testes rodam em memória e no PostgreSQL local isolado. Os resultados estão no relatório da execução. Os 188 testes anteriores continuam passando sem alteração.

## 9. Pendências

- **Valores cobrados em nome de terceiros:** o modelo recusa até existir a obrigação com o terceiro.
- **Financiador dos descontos:** o SAIPOS não informa (pedido e agregado). As deduções ficam `DESCONTOS_A_CLASSIFICAR` até haver documento (por exemplo, a apuração iFood para promoções).
- **Taxa de entrega em pedidos iFood:** titularidade a confirmar.
- **Documentos que faltam:** SAIPOS por pedido real, apuração iFood real e recebimentos Stone real.
- **iFood:** a composição da apuração ainda não forma propostas automaticamente; só o cálculo gerencial está pronto.
