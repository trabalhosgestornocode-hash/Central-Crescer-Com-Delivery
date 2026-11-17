# 41 — Leitor real "Vendas por período" da SAIPOS (Fase 03)

> Documento público: **nenhum pedido, cliente, endereço ou valor real**. Os testes usam uma planilha sintética no mesmo layout.

## O que mudou

### Um leitor só, não um paralelo
- O leitor `SAIPOS_VENDAS` (relatório por pedido) passou a ler também o layout real de 26 colunas (doc 39 §2).
- O layout sintético antigo continua aceito: "Situação", número do pedido como identificador.
- No formato **XLSX**, o leitor está homologado com a amostra real. Em CSV continua sintético.
- O relatório está na lista da importação pela plataforma: **"SAIPOS — Vendas por período (XLSX, por pedido: Presencial e Anota Aí)"**.

### Leitura das linhas
- **Data:** "Data da venda".
- **Cancelamento:** "Está cancelado" = S. A linha cancelada fica no registro e não vira venda.
- **Canal:**
  - "Canal de venda" vazio com "Tipo do pedido" = F (ficha) vira **Presencial** (`BALCAO`).
  - "Anota.ai" vira Anota Aí.
  - "iFood" vira iFood.
  - "99 Food" vira 99Food.
  - Canal vazio **sem** o indício de ficha continua como pendência (nunca vira Balcão por padrão).
- **Valores:** entrega, acréscimo e desconto vazios (fichas) contam como 0. A fórmula do total segue conferida.
- **Pagamento:** a lista de descrições é guardada inteira (`pagamentosOriginais`).

### Identidade e deduplicação
- **Integração:** `CANAL:id do pedido no parceiro`.
- **Ficha:** não tem identificador. Usa a impressão digital de data e hora, tipo, total, itens, desconto, entrega, acréscimo e pagamento, mais o número da ocorrência.
  - Duas fichas idênticas continuam sendo **duas**.
  - Reimportar ou importar períodos sobrepostos reconhece as mesmas linhas, sem duplicar.
- O mesmo arquivo de novo devolve a mesma importação.

### Formação das vendas
- **Presencial e Anota Aí** viram vendas.
- **iFood e 99Food não viram venda.** O pedido fica só como registro para conferência, pela regra do doc 38/39.
  - A mesma regra vale para o total por canal do relatório "desempenho por atendente".
- **Pagamento por descrição** (`pagamentoDaDescricaoSaipos`):

| Descrição SAIPOS | Pagamento |
|---|---|
| Débito/Crédito + bandeira | cartão com bandeira; operadora **pela data da venda** (`operadoraNaData` entre Stone, PagBank e máquina de terceiros) |
| Pago Online via Pix | Pix, operadora **maquininha do iFood** (D2) |
| Pix na Entrega | Pix, Stone (não herda a taxa da maquininha do iFood) |
| Dinheiro | dinheiro no caixa físico |
| Vale | vale, operadora de benefícios |
| Online Anotaai | repasse Anota AI (só em pedido do Anota Aí) |
| Várias descrições | **sem divisão por suposição**: venda sem pagamento + divergência `PAGAMENTO_MULTIPLO_SEM_VALOR` |
| "Online iFood" numa ficha, não cadastrado, desconhecida | sem pagamento automático (a conferir) |

- **Operadora de cartão:**
  - Se nenhuma operadora de **cartão** estiver cadastrada, vale o de-para da loja (Stone).
  - Com operadoras cadastradas, decide a única ativa na data.
  - Duas ativas vão para conferência (`OPERADORA_AMBIGUA`). Nenhuma dá `SEM_OPERADORA`.
- **Taxa estimada:** a de cada pagamento sai da tabela vigente na data da venda (doc 40). Ela não entra na DRE.
- A **descrição original** de cada pagamento fica gravada (auditoria).

### Aplicação em lote
- "Aprovar e aplicar as propostas prontas" processa até 400 por clique e informa quantas faltam (`restantes`).

## Conferência com o arquivo real
- A conferência foi feita localmente, em memória. O arquivo real não está no Git.
- O arquivo foi lido sem erros.
- Os totais por canal e as quantidades bateram com a contagem independente da planilha.
- iFood e 99Food ficaram de fora da receita.
- O Anota Aí entra pela receita bruta (itens + entrega). Os descontos vão para deduções a classificar, como os demais descontos sem financiador comprovado.

## Testes
- `saipos-vendas-por-periodo.test.js`:
  - leitura do layout;
  - formação por canal;
  - pagamentos;
  - operadora pela data e simultâneas;
  - reimportação e sobreposição;
  - isolamento.
- Testes antigos que formavam venda iFood a partir da SAIPOS foram ajustados para a regra (agora usam Anota AI ou demonstrativo oficial):
  - `abertura-persistente`;
  - `reconstrucao-setembro-a-novembro`;
  - `requisitos-operacao-real`;
  - `demonstrativo-ifood`;
  - `taxas-contratadas`.

## Pendências
- Nada foi importado em produção. A importação real depende da D1 (correção dos registros de 16/11). Enquanto as vendas de 16/11 (por forma) estiverem aplicadas, as vendas por pedido dos mesmos dias são recusadas pelo conflito de granularidade, como esperado.
- Para que os cartões tenham taxa estimada, é preciso cadastrar as taxas reais da Stone (D3).
