# Financeiro v2 — 07. Formação de operações financeiras (Execução 03)

Data: 12/11/2026. Branch local `feat/financeiro-v2-formacao`, derivada de `244c47f`.

> Público: sem valores, nomes ou identificadores reais. A divergência SAIPOS de setembro aparece só pela estrutura; os números estão nos documentos privados.

## 1. Diagnóstico (Fase A) e lacunas encontradas

- **O que já existia:** o núcleo já tinha as operações aprovadas.
  - Venda (com vários pagamentos), pagamento complementar, recebível, obrigação parcelada, ajuste de título, movimentação, liquidação parcial e N:M, transferência e conciliação.
  - Cada uma abre a própria transação.
- **Lacuna 1 — não dava para compor operações numa transação só.**
  - A proposta precisa criar a operação e marcar-se como aplicada **atomicamente**.
  - Solução sem reescrever os módulos aprovados: `baseNaTransacao(b, tx, escopo)` instancia as **mesmas** operações dentro da transação corrente, com as mesmas checagens de contexto, escopo e permissão. Uma operação composta fora do escopo da transação é recusada.
- **Lacuna 2 — receita agregada sem canal.** O núcleo só tinha receita por canal. Foi criada a categoria de sistema `VENDAS_AGREGADAS_SEM_CANAL`, porque o relatório agregado nunca ganha canal inventado.
- **Lacuna 3 — desconto do pedido.** O modelo de venda registra o valor cobrado; dedução separada **por pedido** continua pendente (§ 11). No caminho agregado, o desconto já tem efeito próprio.
- **Que fonte suporta o quê:**

| Fonte | Suporta |
|---|---|
| SAIPOS por pedido | Operação econômica: venda e receita |
| SAIPOS faturamento por dia | Receita **agregada**, sem canal, e controle de total |
| SAIPOS formas de pagamento | Só controle e divergência; não forma operação |
| Stone vendas | Pagamento, recebível e taxas de uma venda existente; **não** é venda e **não** prova depósito |
| Foody | Obrigação ao entregador (o valor devido); **não** prova pagamento |
| Unicred | Movimentação da conta, sem efeito econômico |

## 2. Arquitetura do motor de formação

Fluxo: documento → registro importado → **interpretação** (`aplicacao/formacao.js`, uma regra por fonte) → **proposta** (`fv2_proposta`) → revisão e aprovação → **aplicação autorizada** → operação.

Cada proposta guarda:
- fonte, tipo de relatório, importação e documentos originais;
- registros usados, competência, data da operação e natureza econômica;
- valor, categoria sugerida e o **comando exato** da operação;
- duplicidades e divergências, confiança (ALTA, MÉDIA ou BAIXA) e justificativa;
- os efeitos criados (tipo e id).

## 3. Estados e transições

| De | Para | Condição |
|---|---|---|
| PROPOSTA, AGUARDANDO_REVISAO | APROVADA | permissão `financeiro_v2.revisar`; AGUARDANDO_REVISAO exige justificativa |
| AGUARDANDO_EVIDENCIA | — | não aprova: falta evidência |
| APROVADA | APLICADA | `aplicarProposta`, com permissão de revisar **e** a permissão da própria operação (registrar; corrigir, para taxas) |
| não aplicada | REJEITADA | exige justificativa |
| não aplicada | SUBSTITUIDA | fonte retificada |
| APLICADA (só venda agregada) | SUBSTITUIDA | `reverterPropostaAgregada`: os lançamentos são cancelados, não apagados |

**No banco (`FV013`):**
- aplicada não volta atrás nem troca os efeitos;
- rejeitada e substituída são finais;
- só aprovada vira aplicada;
- proposta aprovada não muda de conteúdo.

**Reavaliação.** Gerar propostas de novo para a mesma importação:
- não duplica nada;
- atualiza (com versão e histórico) as propostas **ainda não decididas** quando a evidência muda. Exemplo: uma venda passou a ter valor pendente igual ao da transação Stone.

## 4. Idempotência e transação

- **Chave da proposta:** operação + origem + impressão do conteúdo dos registros. A mesma origem com o mesmo conteúdo nunca gera duas propostas, e o banco garante isso com chave única por escopo.
- **Transação única:** a aplicação roda numa transação só, com trava exclusiva por dia. Ela:
  1. relê a proposta com bloqueio de linha;
  2. confere o estado;
  3. confere o conflito de granularidade;
  4. cria a operação;
  5. marca a proposta como aplicada.
- **Falha no meio:** desfaz tudo (testado).
- **Reaplicar:** devolve o resultado anterior (`repetido`).
- **Concorrência:** aplicações simultâneas geram um efeito só; as perdedoras recebem conflito de versão, e nunca há duplicidade.
- **Fonte retificada:**
  - proposta não aplicada vira SUBSTITUIDA;
  - se já havia efeito aplicado, a nova proposta nasce AGUARDANDO_REVISAO, com a duplicidade `EFEITO_ANTERIOR_APLICADO`, e **não pode ser aprovada** até o efeito anterior ser revertido. Nada é sobrescrito.

## 5. Regras por fonte

### 5.1 Vendas (SAIPOS)

**Por pedido**
- Cada pedido vira uma proposta `VENDA`: um canal, uma receita, `fonte = SAIPOS + número do pedido`.
- Pagamentos:
  - **dinheiro:** pagamento direto no caixa físico (com a conta informada);
  - **online iFood ou Anota AI:** pagamento com o processador da plataforma, que gera o recebível;
  - **cartão, Pix, vale ou "múltiplas":** sem processador conhecido; a venda nasce com pagamento parcial e a proposta registra `PAGAMENTO_A_EVIDENCIAR`. O pagamento entra depois, por evidência (Stone) ou registro manual.
- Pedido cancelado não forma venda e continua no registro de origem.
- Canal não reconhecido leva a AGUARDANDO_REVISAO.

**Agregado por dia** (`VENDA_AGREGADA`)
- Gera receita bruta (itens + entrega + serviço + acréscimos) na categoria `VENDAS_AGREGADAS_SEM_CANAL`, mais a dedução `DESCONTOS_COMERCIAIS` pelos descontos do dia.
- Não cria pedido, canal, forma nem venda.
- Se a composição do dia não fecha, a proposta vai para AGUARDANDO_REVISAO.

**Política agregado × por pedido**
- Nunca as duas receitas no mesmo dia: a aplicação recusa com conflito.
- Quando chegar o relatório por pedido, o agregado do dia é revertido (`reverterPropostaAgregada`, com justificativa) e então os pedidos são aplicados.

### 5.2 Transações Stone

- Cada transação aprovada vira uma proposta `PAGAMENTO_STONE` contra uma venda **já aplicada** do mesmo dia. Critérios de vínculo:
  - autorização em comum: confiança ALTA;
  - valor pendente da venda igual ao bruto: confiança MÉDIA;
  - mais de uma venda possível: AGUARDANDO_REVISAO (ambíguo);
  - nenhuma venda: AGUARDANDO_EVIDENCIA (`SEM_PEDIDO_CORRESPONDENTE`). A transação fica preservada, e não há venda nem canal inventados.
- **Ao aplicar:**
  1. pagamento da venda (forma pelo produto, processador STONE), que gera o **recebível bruto**;
  2. **taxa informada** como ajuste do recebível na categoria `TAXAS_STONE` (despesa de recebimento);
  3. antecipação, quando existir, em `TAXAS_ANTECIPACAO` (encargo financeiro, com o relatório como documento).
- **Frações de centavo:**
  - a taxa original em milionésimos fica na proposta;
  - o centavo do lançamento é arredondado meio para cima, **explicitamente** (`ARREDONDAMENTO_DE_TAXA`);
  - o total de conferência da operadora continua reproduzível pelos milionésimos guardados (doc 06).
- Não se aplica taxa contratual estimada.

### 5.3 Recebíveis

- Nascem do pagamento com processador (Stone, iFood, Anota AI, vale, máquina de terceiros ou outro).
- Uma venda pode ter vários recebíveis, e um crédito pode liquidar vários (liquidação com várias alocações).
- Liquidação parcial é aceita; o saldo nunca fica negativo (`LIQUIDACAO_EXCEDE_SALDO`).
- A **data prevista fica nula** sem previsão confiável.
- Recebível não é saldo bancário: só a liquidação contra uma movimentação real move a conta. O relatório de vendas Stone não é tratado como recebimento.

### 5.4 Contas a pagar e entregadores (Foody)

- **Obrigação:**
  - pode ter várias parcelas, mas a despesa é lançada **uma** vez;
  - o pagamento é **liquidação**, inclusive parcial, e nunca um novo lançamento;
  - pagar em outro mês não move a competência.
- **Foody:** uma proposta `OBRIGACAO_ENTREGADOR` por entregador e período:
  - cada entregador ganha uma contraparte própria, criada uma vez, com chave estável;
  - a proposta lista as entregas devidas, as taxas rejeitadas e as canceladas; o valor devido é a soma das entregas válidas;
  - pagamentos vinculados e saldo vêm das liquidações;
  - o vencimento adotado (fim do período apurado) está marcado como `VENCIMENTO_A_CONFIRMAR`;
  - um Pix ao entregador só quita a obrigação por liquidação explícita ou candidata confirmada.
- **Foody real não homologado:** só contrato e testes sintéticos.

### 5.5 Movimentações bancárias (Unicred)

- Cada lançamento do extrato vira uma proposta `MOVIMENTACAO_BANCARIA`. Ela exige a conta bancária informada; sem conta, fica AGUARDANDO_REVISAO.
- Guarda: data, valor, sentido, descrição (completa na proposta), documento, saldo informado, página, categoria bancária **preliminar** e situação de conciliação.
- **Nunca** cria venda, receita, despesa, compra ou obrigação.
- Parcela de empréstimo recebe a pendência `PRINCIPAL_E_JUROS_NAO_SEPARADOS`: principal e juros exigem o demonstrativo do contrato.
- `listarPendenciasDeClassificacao` mostra:
  - saídas sem obrigação, como "pagamento a classificar";
  - entradas sem origem, como "crédito a classificar";
  - empréstimos sem detalhamento.
- Fechar o saldo do extrato não significa ter classificado as movimentações.

## 6. Tratamento de taxas

| Natureza | Categoria | Origem |
|---|---|---|
| Desconto comercial | `DESCONTOS_COMERCIAIS` (dedução) | agregado SAIPOS; por pedido, fica pendente (§ 11) |
| Taxa de processamento Stone | `TAXAS_STONE` (despesa de recebimento) | desconto informado pela Stone |
| Antecipação | `TAXAS_ANTECIPACAO` (encargo financeiro) | só se informada e documentada |

## 7. Conciliação inicial

- Continuam valendo as relações da Execução 02 (SAIPOS × Stone, Stone × recebimento, recebimento × Unicred, iFood × Unicred, Foody × Unicred).
- Nova relação: **`OBRIGACAO_X_MOVIMENTACAO`**, conta a pagar × saída bancária.
  - Critério: saldo igual à saída, com a saída depois da emissão. É sempre FRACA e sempre leva o documento do extrato como evidência.
- Ambiguidade (mais de uma conta disputando a mesma saída) impede a confirmação até a concorrente ser rejeitada com justificativa.
- Confirmar exige `financeiro_v2.conciliar`.
- Confirmar uma correspondência não liquida o título: a liquidação é uma operação explícita.
- Nenhuma conciliação de dados reais foi feita nesta execução.

## 8. Divergência entre fontes (SAIPOS)

`registrarDivergenciaEntreFontes` (faturamento por dia × formas de pagamento) grava em `fv2_divergencia_fonte`:
- os totais de cada fonte e a diferença total e **por dia**;
- as formas atípicas, com os registros de origem intactos.

O registro é idempotente.

`explicarDivergencia` acrescenta explicações:
- só as **confirmadas, com documento de evidência,** somam;
- hipóteses ficam registradas, mas não resolvem;
- a divergência só fica RESOLVIDA quando as confirmadas cobrem a diferença inteira.

Nenhum ajuste é criado e nenhuma causa é presumida. A investigação definitiva depende do relatório por pedido.

## 9. Competência e datas

São datas distintas:
- da venda ou operação (`dataOperacao`);
- de competência (`competencia`);
- de vencimento, de pagamento e de liquidação bancária (`dataEfetiva` da movimentação);
- de importação (`recebidoEm` do documento).

Regras:
- **Insumos:** seguem a metodologia gerencial aprovada (competência da compra, sem CMV por inventário).
- **Pagamento em mês posterior:** só liquida e não duplica o custo.
- **Competência homologada:** bloqueia a aplicação (testado); só a reabertura autorizada libera.

## 10. Testes

`formacao.test.js` tem 14 testes que cobrem os 26 itens obrigatórios. A numeração está no nome de cada teste, mais o caso de fonte retificada. Rodam em memória e no PostgreSQL local isolado.

Também cobrem: reavaliação, conflito agregado × pedido, rollback com falha injetada, concorrência, permissões, isolamento, competência homologada e rastreabilidade até o documento original.

A migração `0004_formacao.sql` é conferida no teste de migrações: tabelas, RLS forçado e privilégios.

## 11. Limitações e pendências

- **SAIPOS por pedido** ainda não existe em amostra real. A formação por pedido está testada só com dados sintéticos. A dedução de desconto **por pedido** depende de decidir o modelo de venda: valor bruto com dedução, ou valor cobrado.
- **Foody e iFood reais** não estão homologados. Os recebíveis iFood nascem de pedidos com "online iFood", mas a apuração iFood ainda não forma propostas.
- **Stone:**
  - só vincula a vendas **já aplicadas** do mesmo dia;
  - transações sem venda ficam aguardando evidência;
  - não há relatório de recebimentos real, então nenhum valor Stone é dado como recebido.
- **Empréstimos:** principal e juros dependem do demonstrativo.
- **Reversão aplicada:** existe só para a venda agregada. As demais operações usam os cancelamentos e estornos do núcleo.
- **Setembro real:** nenhuma proposta foi aplicada sobre dados reais nesta execução, e nada foi homologado.
