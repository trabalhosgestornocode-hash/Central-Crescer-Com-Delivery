# 33 — Abertura em 09/2026 e requisitos prioritários da operação real

> Documento público (o repositório é público): **nenhum valor, nome ou identificador real**. Os totais de setembro ficam
> só nos documentos privados, fora do Git.

Decisão do proprietário: **competência inicial 09/2026, data de corte 31/08/2026**. Objetivo: reconstruir setembro,
outubro e novembro de 2026 do Açaí no Grau Saci com resultados confiáveis.

## 1. Abertura em 09/2026 — compatibilidade

Produção (leitura em 15/11/2026):

- abertura gravada: nenhuma;
- lançamentos: nenhum, portanto **nenhum lançamento de resultado até 31/08**;
- competência 09/2026: inexistente, portanto **não homologada**.

**A configuração `09/2026` é aceita pelo núcleo.** O ensaio sintético (`reconstrucao-setembro-a-novembro.test.js`)
configura 09/2026 e confere:

- corte = 31/08;
- saldo de abertura com data 31/08, fim do dia;
- títulos anteriores patrimoniais, fora da DRE;
- recusa abertura incompatível (venda em 31/08);
- recusa título "anterior" com data depois do corte.

## 2. Plano de contas ACAITERIA — complemento

O modelo ganhou os destinos que a operação real já usava no plano gerencial anterior. São só categorias, sem regra nova:

| Grupo | Categorias novas |
|---|---|
| Insumos | distribuidora de açaí, outros insumos |
| Pessoal | benefícios, férias e rescisões, exames, diárias extras |
| Administrativas | aluguel, energia, água, sistemas, contabilidade, jurídico, associação, material de escritório, manutenção, serviços de terceiros |
| Financeiras | seguro prestamista |
| Patrimoniais (fora da DRE) | parcelamento tributário (principal), operações entre empresas, valores de terceiros |

Mapeamentos sem categoria nova:

| Item do plano anterior | Destino no ACAITERIA |
|---|---|
| Simples Nacional | tributos sobre vendas (dedução) |
| taxas iFood | comissões iFood |
| antecipação | taxas de antecipação (exige documento) |
| tarifa Stone | taxas Stone |
| descartáveis | embalagens |
| juros e tarifas | juros e tarifas bancárias |
| empréstimos | empréstimos (principal) |
| aportes e retiradas | aportes e retiradas |

A implantação continua idempotente: cria só o que falta.

## 3. Requisitos prioritários

### 3.1 Faturamento bruto por canal (Balcão, iFood, Anota AI)

Já existia no núcleo e na tela:

- a DRE separa o bruto por canal; a soma dos canais é o total;
- a Visão Geral mostra os canais e a participação de cada um;
- cada canal lista os registros que o compõem;
- repasse posterior (iFood, Stone) liquida o recebível e nunca é receita de novo;
- reimportar o mesmo relatório devolve a mesma importação.

**Bloqueio real é de dado, não de código.** Só o relatório SAIPOS **por pedido** traz o canal de cada venda. Esse leitor
está validado apenas com arquivo sintético.

Os relatórios SAIPOS conferidos com amostra real não trazem canal:

- **faturamento por dia:** agregado sem canal, vira "sem canal identificado" e nunca é distribuído por suposição;
- **formas de pagamento:** forma, não canal.

O que falta:

- a exportação SAIPOS de vendas detalhadas por pedido de setembro, para homologar o leitor;
- os relatórios oficiais do iFood, para comissões e repasses; o leitor do iFood também é só sintético.

### 3.2 Dinheiro em espécie recebido (novo)

Novo bloco `dinheiroEmEspecie` no resumo da Visão Geral (`dominio/tesouraria.js`) e card "Dinheiro em espécie
recebido". Ele separa:

| Valor | O que é |
|---|---|
| vendas pagas em dinheiro | pela data do pagamento |
| recebido no caixa físico | pagamento com entrada no caixa |
| vendas em dinheiro **sem entrada no caixa** | pendência de conferência |
| depositado no banco | transferência interna, nunca receita |
| sangrias e retiradas | — |
| pagamentos em espécie | — |
| suprimentos e outras entradas | não são venda |

O bloco também traz o detalhe **por dia**. Movimento estornado não conta. Dinheiro não é canal: a venda já está no
faturamento do canal. Sem registros, o card mostra "sem registros", nunca R$ 0,00.

### 3.3 Baixa de contas a pagar pela conciliação do extrato

Já existia:

- **importação do extrato:** cada linha vira **uma** movimentação, sem despesa;
- **vínculo saída × contas** (`/obrigacoes/vincular-extrato`):
  - prévia, trava, versão e idempotência;
  - pagamento parcial;
  - várias contas por saída e várias saídas por conta;
  - nenhuma saída nem despesa nova;
  - estorno.
- **candidatas conta × saída:** só por valor (fracas), sem rota nem botão.

Corrigido nesta etapa:

1. **Rota e botão.** `/conciliacoes/gerar-contas-a-pagar` ganhou o botão "Procurar contas a pagar pagas no extrato".
2. **Força da candidata.** Ela é **forte** só quando o par é **inequívoco**: a saída casa com uma única conta, a conta casa
   com uma única saída, e o histórico do extrato traz o número do documento da conta ou o nome completo do
   beneficiário. Os demais casos seguem fracos, e os ambíguos não se confirmam.
3. **Confirmar com baixa.** `confirmarConciliacao` aceita `baixar`: confirma e dá a baixa **na mesma transação**, com a
   permissão própria `vincular_pagamento`. Na tela, aparece uma caixa marcada no detalhe da conciliação.
4. **Número do documento.** A conta a pagar passa a aceitar o número da NF ou do boleto (campo novo no formulário). Antes
   isso valia só para os títulos da abertura.

A baixa **automática sem clique** não foi ligada. Ela depende de uma política aprovada pelo proprietário (critério,
limite de valor, quem responde).

## 4. Testes (dados sintéticos)

- `reconstrucao-setembro-a-novembro.test.js`:
  - abertura 09/2026 e posições em 31/08;
  - barreira contra importação anterior ao corte;
  - venda recebida no mês seguinte e recebida em parte;
  - despesa de setembro paga em novembro;
  - título anterior quitado;
  - estorno posterior;
  - reimportação;
  - boleto a classificar fora da DRE;
  - DRE dos três meses;
  - conservação dos valores;
  - isolamento da unidade.
- `requisitos-operacao-real.test.js`:
  - três canais somando o total e repasse posterior;
  - dinheiro em espécie;
  - baixa pela conciliação: forte, ambígua, parcial, agrupada, sem par, reimportação, despesa de setembro paga em
    outubro, permissão, saídas do banco inalteradas.
- `frontend/test/financeiroV2OperacaoReal.test.js`: card de dinheiro, caixa "dar baixa" e contrato com as rotas.

## 5. Sequência para a abertura real (cada passo com autorização)

1. **Ligar a escrita** (`FV2_ESCRITA_HABILITADA=1`). Homologação e cofre seguem desligados.
2. **Publicar** esta branch (PR, merge e deploy). Sem migração: os campos novos vão para `extras`.
3. **Implantar o plano ACAITERIA.**
4. **Criar as contas** Unicred e Caixa da loja.
5. **Configurar a abertura** em 09/2026.
6. **Registrar as posições de 31/08:**
   - saldo Unicred, pelo saldo anterior declarado no extrato de setembro;
   - contagem do caixa;
   - contas a pagar em aberto;
   - recebíveis de iFood, Stone e Anota AI.
7. **Conferir** com um validador e **concluir** a abertura.
8. **Importar setembro:**
   - SAIPOS por pedido, quando houver;
   - Stone vendas;
   - extrato Unicred.
9. **Conferir e aplicar as propostas.** Procurar as contas pagas no extrato e confirmar com baixa.
10. **Repetir** para outubro e novembro.
