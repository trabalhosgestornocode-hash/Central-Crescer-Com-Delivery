# Correção: saldo de abertura negativo quebrava os relatórios financeiros

## Problema
O cadastro de saldo de abertura aceita valor negativo, por exemplo conta em cheque especial ou carteira de plataforma devedora (`cadastros.service.js`, `definirAbertura`). Mas `aberturasComoLancamentos` (`financeiro-calculos/relatorios.js`) gerava um lançamento "entrada" com valor **negativo**, e o motor recusa valores negativos (`valorCentavos deve ser inteiro >= 0`).

Resultado: com qualquer abertura negativa, falhavam na unidade:
- Visão Geral;
- Indicadores;
- DRE (inclusive a comparação entre períodos);
- pré-fechamento do mês.

Saldos por conta, extrato e tabelas não quebravam, porque usam outro caminho.

## Correção
A abertura negativa passa a ser uma "saída" do papel `saldo_anterior`, com o valor absoluto. O motor já calcula `saldoAnterior = entradas − saídas` desse papel, e a variação do caixa o exclui. Então o saldo final e a ponte resultado→caixa ficam corretos, e a abertura não entra como receita nem como despesa.

Aberturas positivas e iguais a zero continuam exatamente como antes.

## Testes
- `backend/test/financeiro/aberturaNegativa.test.js` (unitário): sinal, saldo anterior, variação, saldo final e saldos por conta.
- Teste integrado `backend/testes-seguros/financeiro-abertura-negativa/abertura_negativa_integrado.mjs` (serviços reais, banco descartável só com as migrations 120–122, dados sintéticos, duas organizações). Para rodar:
  `PG_CLUSTER_DIR=<cluster descartável> bash backend/testes-seguros/financeiro-abertura-negativa/preparar_banco.sh fin20neg` e depois `node backend/testes-seguros/financeiro-abertura-negativa/abertura_negativa_integrado.mjs`.
- Resultado:
  - **25/25 com a correção**;
  - **10 falhas sem ela** (no código da `main`).
- Cobertura do teste integrado:
  - abertura negativa, entradas e saídas seguintes, saldo final;
  - visão geral, indicadores, DRE e comparação, categorias, extrato;
  - as 7 tabelas, entre elas o fluxo mensal;
  - conciliação e pré-fechamento;
  - meses anterior e posterior à abertura;
  - isolamento entre organizações.

## Publicação
É uma mudança só de backend, numa função pura, sem migration nem alteração de dados. O deploy é o automático do merge na `main`.

## Reversão
Reverter o commit (`git revert`) e fazer novo deploy. Nenhum dado precisa ser restaurado: a correção não grava nada, só muda o cálculo na leitura. Com a reversão, unidades que tiverem abertura negativa voltam a ter os relatórios quebrados.
