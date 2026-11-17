# 50 — Correção de entrada em conta e preparação das taxas (17/11/2026)

> Documento público: **nenhum valor, identificador ou taxa contratual real**. A prévia dos registros reais e as taxas
> ficam fora do Git, no relatório privado ao proprietário. Nada foi executado em produção.

## 1. Por que
O plano de correção da importação de 16/11 (docs 45 §7, 46 §3 e 49 §4) exige estornar as entradas em dinheiro **antes** de
cancelar as vendas. Cancelar uma venda com dinheiro em conta é recusado (`ESTORNO_EXIGE_COMPENSACAO`).

Os docs anteriores citavam uma "rota de estorno de pagamento", mas **ela não existia**:
- o estorno de pagamento (`estornarPagamentoDeVenda`) só era usado internamente, pela substituição do faturamento provisório;
- pela plataforma não havia como chamá-lo.

## 2. Solução
### Motor único
O corpo do estorno virou `estornarNaTransacao(cx, tx, c)`, em `aplicacao/vendas.js`, e é usado por três caminhos:
- o estorno genérico do núcleo (`estornarPagamentoDeVenda`);
- a substituição do faturamento provisório, que continua chamando o mesmo método;
- a nova correção de entrada.

O comportamento existente não mudou: é a mesma função, só extraída.

### Operação nova: `corrigirEntradaDePagamentoDeVenda`
- **Rota:** `POST /api/v1/financeiro-v2/acoes/vendas/pagamento/corrigir-entrada`.
- **Campos:** `venda`, `pagamento` e `justificativa`. Valor, conta, data e motivo não são aceitos.
- **Efeito:** sempre estorno **total** com motivo `CORRECAO_DE_PAGAMENTO`, sem efeito no resultado.
  - A entrada em conta fica `ESTORNADA`, sem ser apagada.
  - O pagamento passa a ter `estornadoCentavos = valor`.
  - A venda continua `ATIVA`, com valor pendente, pronta para ser cancelada pelo passo seguinte do plano.

## 3. Restrições de segurança
- **Autenticação, unidade e CSRF:** os mesmos de todas as ações da plataforma (sessão do Crescer, unidade da sessão, gateway). A ação só aceita JSON e recusa campos fora da lista.
- **Permissões:** exige `financeiro_v2.corrigir` **e** `financeiro_v2.cancelar`.
  - O banco grava o estorno pela ação `cancelar` (matriz da migração 0013), por isso não há migração nova.
  - A concessão persistida de `corrigir` também é conferida dentro da transação.
- **Escopo:** venda e pagamento de outra unidade não são encontrados no escopo da sessão (`NAO_ENCONTRADO`), em memória e pela RLS.
- **Pagamento × venda:** o pagamento precisa pertencer à venda informada.
- **Só entrada direta em conta:** o pagamento precisa ter movimentação e não ter recebível. Cartão e repasse de processador são recusados.
- **Conciliação:** entrada `PARCIAL` ou `CONCILIADA` é recusada por esta rota.
- **Estorno anterior:**
  - estorno parcial é recusado, porque a correção é sempre total;
  - estorno total por outro motivo (devolução) é recusado;
  - o mesmo pedido repetido devolve o estorno já gravado (`repetido: true`), sem gravar nada.
- **Transação:** tudo numa transação. Uma falha no meio desfaz caixa, pagamento e venda.
- **Trilha:** o histórico da movimentação e do pagamento registra o evento `ESTORNO` com usuário, justificativa, antes e depois. Nasce também um registro `ESTORNO` com motivo e justificativa.
- **Escrita desligada:** com `FV2_ESCRITA_HABILITADA` desligada, a rota fica desligada, como as demais ações.

## 4. Testes
O arquivo `test/financeiro-v2/correcao-entrada-pagamento.test.js` tem 12 casos, em memória e no PostgreSQL local:
- estorno válido;
- cancelamento recusado antes da correção;
- operação repetida;
- pagamento já estornado (devolução);
- estorno parcial anterior;
- entrada conciliada;
- venda inexistente;
- pagamento de outra venda;
- pagamento com repasse;
- outra unidade;
- sem `corrigir`, sem `cancelar` e só leitura;
- justificativa ausente e campos fora do contrato;
- falha intermediária (repositório que falha ao gravar o estorno: nada muda, e a correção ainda funciona depois);
- integridade do caixa (outra entrada da mesma conta não muda);
- histórico.

A suíte completa do Financeiro v2 também roda nos dois modos: **528/528 em memória e 525/525 no PostgreSQL local**. O ensaio do plano (`correcao-importacao-forma-dia`) continua passando.

O teste HTTP (`integracao-http`, PostgreSQL) cobre a rota pela plataforma:
- desligada sem a chave de escrita;
- campo extra recusado;
- venda inexistente não encontrada;
- pessoa sem concessão recusada (403).

Não há tela nova, por isso não há roteiro de navegador.

## 5. Taxas: configuração planejada (nada gravado em produção)
### Operadoras confirmadas pelo proprietário (17/11)
- **Maquininha do iFood:** Pix presencial ("Pago Online via Pix"), vigência confirmada. A receita é do Presencial. **Não** é o marketplace iFood.
- **Stone:** cartões (débito e crédito à vista) de 01 a 16/11. Os percentuais por bandeira vêm das capturas "Taxas e Prazos".
  - A **data de início da vigência ainda não foi informada**.
  - Débito Amex não foi informado e fica **sem taxa** (pendente), nunca zero.
  - Não há parcelamento.
- **PagBank:** não operou de 01 a 16/11.

### Compatibilidade com o relatório SAIPOS
- O relatório traz débito e crédito de Master, Visa e Elo, Pix da maquininha do iFood, dinheiro e vale.
- `bandeiraNormalizada` converte "Master" em `MASTERCARD`, que é a chave da tabela. As bandeiras da tabela que não aparecem no período não afetam nada.

### Simulação local com o arquivo real (em memória, fora do Git)
- Todos os pagamentos de cartão e Pix ficaram `CALCULADA`.
- A taxa gravada é igual, centavo a centavo, a um cálculo independente: **0 divergências**.
- O vale fica `SEM_OPERADORA`, porque não há operadora de benefícios cadastrada (pendente).

### Pré-requisito encontrado
A unidade em produção **não tem a configuração "nome de exibição"**. Sem ela, o cadastro de operadoras é recusado. Esse é o primeiro passo do cadastro, pela tela Configurações.

### Ordem do cadastro (pela interface, com autorização específica)
1. Configurações: nome de exibição da unidade.
2. Operadora **Maquininha do iFood**: processador `MAQUININHA_IFOOD`, modalidade PIX, início pela vigência confirmada.
3. Tabela da Maquininha do iFood: Pix com o percentual confirmado e a mesma vigência.
4. Operadora **Stone**: DEBITO, CREDITO_A_VISTA e PIX. O início depende da **data a confirmar**.
5. Tabela Stone: percentuais das capturas; vigência = **data a confirmar**; prazo "mesmo dia". Sem débito Amex.

Tudo isso precisa estar gravado **antes** da reimportação, porque a taxa estimada é gravada no momento da venda.

## 6. Publicação desta mudança
1. PR desta branch, com autorização. Nenhuma migração.
2. O merge na `main` dispara o auto-deploy do `crescercomdelivery`.
3. Conferir `/health` e os logs.
4. **Teste de leitura apenas:** a rota existe e recusa uma requisição sem sessão ou sem CSRF. Nenhum estorno real nesta etapa.

**Reversão:** voltar o deploy anterior na Render. O código antigo não conhece a rota, e nada no banco mudou.

## 7. Procedimento futuro: os 15 estornos (com autorização específica)
1. Backup verificado e uma nova leitura das 15 entradas. Conferir:
   - venda ativa;
   - pagamento válido sem estorno;
   - movimentação válida, não conciliada e sem alocação;
   - mesma versão da prévia privada.
   Qualquer diferença interrompe o procedimento.
2. Para cada entrada, uma chamada à rota, com a sessão do proprietário e a justificativa da prévia. Conferir `repetido: false` e o total acumulado.
3. Conferir que nenhuma entrada SAIPOS de novembro em dinheiro continua `VALIDA` e que o caixa físico reduziu exatamente o total da prévia.
4. Só então seguem os demais passos do doc 45 §7:
   - rejeitar as propostas pendentes;
   - cancelar as vendas;
   - cadastrar as taxas;
   - reimportar por pedido;
   - conferir.
