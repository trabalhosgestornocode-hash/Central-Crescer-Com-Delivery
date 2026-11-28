# MOVA Operador Financeiro Completo — 02. Fase 2: planejamento técnico (28/11/2026)

Nada desta fase foi implementado. Cada item reutiliza a operação oficial do núcleo, com uma ação ESTREITA própria (como a 0036),
gatilho no banco conferindo a forma, confirmação explícita no WhatsApp e o mesmo trilho da fase 1 (proposta → reserva única →
execução pela identidade operacional → conferência pela leitura oficial). Nenhum valor histórico é sobrescrito e nada é apagado.

## 1. Reclassificação de categoria — `reclassificarLancamento` (já existe, ação ampla `reclassificar`)

- **O que muda:** a categoria é do LANÇAMENTO, que é da COMPRA inteira: reclassificar muda todas as parcelas juntas (não existe
  "categoria só da 2ª parcela"; pedir isso deve ser explicado e recusado).
- **Impacto:** a DRE da competência do lançamento muda de linha (ex.: Insumos → Manutenção). DESPESA ↔ PATRIMONIAL (IMOBILIZADO)
  tira/põe o valor do resultado. O fluxo de caixa não muda.
- **Proteções já no banco (0014):** só categoria; valor/competência/descrição intactos; categoria de destino válida e ativa no plano
  da unidade; provisória nunca é destino; competência homologada recusa.
- **Proposta:** ação `reclassificar_conta_a_pagar` só para lançamento de conta a pagar ABERTA e sem pagamento; destinos limitados a
  DESPESA e IMOBILIZADO (empréstimo, parcelamento, entre empresas e demais patrimoniais continuam fora); prévia de impacto da 08C
  mostrada no resumo ("sai de X, entra em Y na DRE de mm/aaaa"); `versaoEsperada` obrigatória (já exigida pela operação).
- **Migração:** sim (ação nova + gatilho de forma). Sem mudança de schema de dados.

## 2. Correção auditada de valor — `registrarAjuste` (já existe, ação ampla `corrigir`)

- **Regra:** o valor ORIGINAL nunca é sobrescrito. A diferença vira AJUSTE documentado (lançamento próprio, com motivo), e o saldo
  da conta muda pela soma dos ajustes (o banco confere: `ajustes = soma(fv2_ajuste)`).
- **Implicações:** aumento = despesa adicional na competência do ajuste (ou juros/multa, se for encargo); redução = ajuste negativo
  (o saldo não pode ficar negativo; com pagamento parcial, nunca abaixo do pago). Em parcelada, o ajuste é POR PARCELA.
- **Proposta:** ação `ajustar_conta_a_pagar` com teto do ajuste proporcional ao valor da conta (mesmo modelo da 0031, que limita
  juros a 10%) — a ser decidido por você; exigir o motivo dito pela pessoa; categoria do ajuste = a do lançamento (ou juros e multas).
- **Decisão sua:** existe teto para ajuste pelo WhatsApp? (correção cadastral não tem limite; ajuste de VALOR muda o resultado).

## 3. Alteração de competência — NÃO existe operação no núcleo

- **Impacto real:** competência é do LANÇAMENTO; mover muda a DRE de DOIS meses (sai de um, entra no outro). Fluxo de caixa
  realizado não muda (vem das movimentações pela data efetiva); o previsto usa o vencimento.
- **Opção A (recomendada):** operação nova `moverCompetencia` no núcleo: só conta ABERTA sem pagamento; os DOIS meses abertos (nem
  com pendências, nem homologados); move lançamento + parcelas numa transação, histórico de antes/depois nos dois registros e marca
  nas duas competências. Ação estreita + gatilho que só aceita mudança de `competencia` (e só nesse formato).
- **Opção B:** cancelar e registrar de novo (já existe): mais simples, mas troca os IDs, perde o vínculo do histórico e exige
  cancelamento (ação ampla) — não recomendada para o MOVA.
- **Implicação estrutural:** a Opção A é a primeira operação que altera `competencia` de registro existente; exige revisão do
  0010 (posição em homologada) e dos índices de carga por competência (0015). Por isso só depois da sua revisão.

## 4. Cancelamento de contas — `cancelarObrigacao` (já existe, ação ampla `cancelar`)

- **Hoje:** cancela o GRUPO inteiro (todas as parcelas + lançamento + ajustes), lógico (nada apagado), recusado se houver pagamento.
- **Proposta (grupo):** ação `cancelar_conta_a_pagar` só para conta sem nenhum pagamento, de despesa/equipamento, período aberto;
  motivo obrigatório; resumo mostra o efeito na DRE.
- **Parcela individual — investigação:** o lançamento é único pelo TOTAL; cancelar só uma parcela deixaria "lançamento ≠ soma das
  parcelas ativas". Caminhos: (a) parcela CANCELADA + AJUSTE negativo no lançamento pelo valor dela, na mesma transação (exige
  ajuste sobre LANÇAMENTO, que hoje é só sobre título — mudança estrutural); (b) reduzir via ajuste negativo NA PARCELA até zero e
  marcá-la quitada por ajuste (sem mudança estrutural, mas semântica estranha: "quitada" sem pagamento). Recomendo (a), com
  migração própria e revisão — não implementar antes da sua decisão.

## 5. Ordem sugerida

1. Reclassificação (operação pronta; só a ação estreita). 2. Cancelamento de grupo. 3. Ajuste de valor (depende do teto).
4. Competência e cancelamento de parcela (estruturais; desenho detalhado antes).
