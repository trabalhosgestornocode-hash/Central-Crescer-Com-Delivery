# Financeiro v2 — 23a. Matriz das pendências: VERSÃO PARA APROVAÇÃO

Data: 14/11/2026 (Execução 09B). Base: [22a-matriz-pendencias.md](22a-matriz-pendencias.md) — mesmos 24 tipos e 7
impedimentos, mesma classificação e o mesmo vínculo com o código (`dominio/ressalvas.js` `EFEITO_POR_CODIGO`,
`dominio/conferencias.js`). Nenhuma regra de fechamento foi alterada na 09B.

> **SITUAÇÃO: AGUARDANDO DECISÃO DO RESPONSÁVEL FINANCEIRO. NÃO APROVADA PELA EMPRESA.**
> A coluna "Decisão" está em branco de propósito. Só uma aprovação explícita, registrada por quem responde pelo
> financeiro, muda essa situação. O teste `matriz-pendencias` falha se um código existir no código e não aqui.

**Legenda.** *Ressalva?* = pode homologar com a pendência documentada. *Responsável* = quem decide no dia a dia
(permissão do v2 exigida). **RF** = decisão de política que cabe ao responsável financeiro aprovar nesta matriz.
*Regra* = `EXIGE_DOC` (documentar ou resolver) / `BLOQUEIA` / `NAO_BLOQUEIA` + efeito no resultado
(`SEM_EFEITO`, `CONHECIDO`, `INDETERMINADO`).

## Pendências

| # | Tipo | Origem | Impacto econômico | Evidências necessárias | Resolve como | Ressalva? | Bloqueia quando | Responsável | Regra | Justificativa da regra | Testes | Decisão RF |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `DESPESA_A_CLASSIFICAR` | Conta a pagar "a classificar" | Fora da DRE; pode superestimar o resultado | Nota, boleto ou contrato | Reclassificar | Não | Sempre | Quem tem `reclassificar` | EXIGE_DOC + INDETERMINADO (+ impedimento) | Natureza desconhecida pode esconder despesa | matriz-pendencias; reclassificacao; evidencias | ( ) aprovo ( ) altero |
| 2 | `DESCONTO_A_CLASSIFICAR` | Venda com desconto sem financiador | Dedução provisória | Relatório do canal com o financiador | Reclassificar ou registrar terceiro | Não | Sempre | `reclassificar` | EXIGE_DOC + INDETERMINADO (+ impedimento) | Quem paga o desconto muda a dedução | matriz-pendencias; apuracao | ( ) aprovo ( ) altero |
| 3 | `SAIDA_SEM_CLASSIFICACAO` | Extrato/caixa sem vínculo | Possível despesa não reconhecida | Comprovante ou boleto | Vincular conta (com evidência) ou registrar conta | Não | Sempre (núcleo e banco) | `vincular_pagamento` / `registrar` | EXIGE_DOC + INDETERMINADO | Dinheiro saiu sem explicação econômica | matriz-pendencias; fechamento-ressalvas-baixa | ( ) aprovo ( ) altero |
| 4 | `SOBREPOSICAO_AGREGADO_PEDIDOS` | SAIPOS diário × pedidos | Receita em dobro | Relatório por pedido | Substituir agregado | Não | Sempre | `aplicar` | BLOQUEIA + INDETERMINADO (+ impedimento) | Duplicidade superestima receita | matriz-pendencias; apuracao; vendas-recebimentos | ( ) aprovo ( ) altero |
| 5 | `PROPOSTA_EM_ABERTO` | Importação não decidida | Receita/despesa faltando | O arquivo importado | Aprovar+aplicar ou rejeitar | Não | Sempre | `aprovar` / `aplicar` | EXIGE_DOC + INDETERMINADO (+ impedimento) | Resultado incompleto | matriz-pendencias; formacao | ( ) aprovo ( ) altero |
| 6 | `TRANSACAO_SEM_PEDIDO` | Stone sem venda | Possível receita não registrada até o valor | Relatório por pedido do dia | Importar pedidos ou rejeitar | Sim, documentada, com valor | Sem documentação | `fechar` | EXIGE_DOC + CONHECIDO | Só pode subestimar (receita a menos) | matriz-pendencias; conferencias; vendas-recebimentos | **RF** ( ) aprovo ( ) altero |
| 7 | `IMPORTACAO_A_REVISAR` | Prévia não confirmada | Registros fora do sistema | O arquivo | Confirmar ou rejeitar | Não | Sempre | `confirmar_importacao` | EXIGE_DOC + INDETERMINADO (+ impedimento) | Resultado incompleto | matriz-pendencias | ( ) aprovo ( ) altero |
| 8 | `IMPORTACAO_COM_PENDENCIAS` | Importação aceita com divergências | Nenhum adicional | Justificativa registrada | (informativa) | Não exige | Nunca | — | NAO_BLOQUEIA + SEM_EFEITO | Decisão já tomada e auditada | matriz-pendencias | ( ) aprovo ( ) altero |
| 9 | `FONTE_SEM_DOCUMENTO` | Relatório esperado ausente | Nenhum no resultado registrado | O relatório | Importar | Sim, documentada | Sem documentação | `fechar` | EXIGE_DOC + SEM_EFEITO | Falta só a conferência cruzada | matriz-pendencias; conferencias; fechamento-ressalvas-baixa | **RF** ( ) aprovo ( ) altero |
| 10 | `OBRIGACAO_SEM_COMPROVANTE` | Conta sem documento | Despesa pelo valor da conta (se indevida, subestima) | Boleto, nota, contrato | Vincular documento | Sim, documentada, com valor | Sem documentação ou valor mudou | `fechar` | EXIGE_DOC + CONHECIDO | Efeito conhecido e conservador | matriz-pendencias; conferencias | **RF** ( ) aprovo ( ) altero |
| 11 | `CREDITO_NAO_IDENTIFICADO` | Entrada sem origem | Receita possivelmente não registrada até o valor; ou aporte (sem efeito) | Comprovante do depósito | Vincular ou registrar transferência | Sim, documentada | Sem documentação | `fechar` | EXIGE_DOC + CONHECIDO | Só pode subestimar | matriz-pendencias; conferencias | **RF** ( ) aprovo ( ) altero |
| 12 | `TOTAIS_DE_RELATORIOS_DIFERENTES` | Relatórios divergentes | Causa não comprovada | Relatório por pedido | Explicar com evidência | Só explicada | Aberta | `fechar` | BLOQUEIA (aberta) / EXIGE_DOC (explicada) + CONHECIDO | Sem explicação não se sabe o efeito | matriz-pendencias; conferencias | ( ) aprovo ( ) altero |
| 13 | `TAXA_OU_VALOR_DIVERGENTE` | Crédito do processador ≠ esperado | Crédito menor = taxa fora da DRE (superestima) | Demonstrativo de repasse | Registrar ajuste da taxa e dar baixa | Não (desde a 09) | Sempre | `registrar` | EXIGE_DOC + INDETERMINADO | Princípio conservador | matriz-pendencias; configuracoes-fechamento "7, 8" | **RF** ( ) aprovo ( ) altero |
| 14 | `SALDO_DIVERGENTE` | Saldo informado ≠ calculado | Indeterminado | Extrato completo | Localizar movimento | Não | Sempre | `registrar` / `corrigir` | BLOQUEIA + INDETERMINADO (+ impedimento) | Caixa não confere | matriz-pendencias; fechamento-ressalvas-baixa | ( ) aprovo ( ) altero |
| 15 | `CORRESPONDENCIA_A_DECIDIR` | Conciliação candidata | Nenhum | Evidência do vínculo | Confirmar/rejeitar/divergência | Sim, documentada | Sem documentação | `conciliar` | EXIGE_DOC + SEM_EFEITO | Conciliação não muda o resultado | matriz-pendencias | **RF** ( ) aprovo ( ) altero |
| 16 | `VENDA_SEM_PAGAMENTO` | Pagamentos não fecham | Nenhum | Relatório da processadora | Corrigir pagamento | Sim, documentada | Sem documentação | `fechar` | EXIGE_DOC + SEM_EFEITO | Receita já reconhecida | matriz-pendencias; vendas-recebimentos | ( ) aprovo ( ) altero |
| 17 | `PAGAMENTO_INCOMPATIVEL` | Pagamento divergente | Nenhum | Relatório da processadora | Corrigir pagamento | Sim, documentada | Sem documentação | `fechar` | EXIGE_DOC + SEM_EFEITO | Receita já reconhecida | matriz-pendencias | ( ) aprovo ( ) altero |
| 18 | `RECEBIMENTO_DIRETO_NAO_IDENTIFICADO` | Dinheiro/Pix sem conta | Nenhum | Contagem/comprovante | Registrar entrada | Sim, documentada | Sem documentação | `fechar` | EXIGE_DOC + SEM_EFEITO | Afeta caixa, não resultado | matriz-pendencias | ( ) aprovo ( ) altero |
| 19 | `RECEBIVEL_SEM_REPASSE` | Recebível não creditado | Nenhum | Demonstrativo | Conciliar quando creditar | Não exige | Nunca | — | NAO_BLOQUEIA + SEM_EFEITO | Recebível válido em aberto é normal | matriz-pendencias | ( ) aprovo ( ) altero |
| 20 | `RECEBIVEL_ATRASADO` | Previsto já passou | Nenhum | Demonstrativo | Conciliar/cobrar | Não exige | Nunca | — | NAO_BLOQUEIA + SEM_EFEITO | Idem | matriz-pendencias; fechamento-ressalvas-baixa | ( ) aprovo ( ) altero |
| 21 | `REPASSE_INFORMADO_SEM_CREDITO` | Repasse sem crédito | Nenhum | Extrato | Conciliar | Não exige | Nunca | — | NAO_BLOQUEIA + SEM_EFEITO | Idem | matriz-pendencias; vendas-recebimentos | ( ) aprovo ( ) altero |
| 22 | `CREDITO_SEM_COMPROVACAO_BANCARIA` | Recebimento sem extrato | Nenhum | Extrato do dia | Importar extrato e confirmar | Sim, documentada | Sem documentação | `fechar` | EXIGE_DOC + SEM_EFEITO | Afeta caixa, não resultado | matriz-pendencias; vendas-recebimentos | ( ) aprovo ( ) altero |
| 23 | `DIFERENCA_DE_CAIXA` | Fechamento de caixa com diferença | Nenhum ajuste automático | Justificativa do fechamento | (informativa) | Não exige | Nunca | — | NAO_BLOQUEIA + SEM_EFEITO | Já justificada no fechamento do caixa | matriz-pendencias | **RF** ( ) aprovo ( ) altero |
| 24 | `VENDA_SEM_CANAL` | Agregado sem canal | Nenhum no total | Relatório por pedido | Importar pedidos | Não exige | Nunca | — | NAO_BLOQUEIA + SEM_EFEITO | Total correto, só sem distribuição | matriz-pendencias; vendas-recebimentos | ( ) aprovo ( ) altero |

## Impedimentos (bloqueiam sempre)

| Código | Quando | Onde | Decisão RF |
|---|---|---|---|
| `DIVERGENCIA_ENTRE_RELATORIOS_SEM_JUSTIFICATIVA` | Totais diferentes sem explicação | Núcleo | ( ) aprovo ( ) altero |
| `SALDO_DE_CONTA_DIVERGENTE` | Saldo informado ≠ calculado | Núcleo | ( ) aprovo ( ) altero |
| `RECEITA_EM_DUPLICIDADE` | Agregado e pedidos no mesmo dia | Núcleo | ( ) aprovo ( ) altero |
| `CONCILIACAO_DIVERGENTE_SEM_RESOLUCAO` | Diferença sem resolução com documento | Núcleo | ( ) aprovo ( ) altero |
| `CLASSIFICACAO_PROVISORIA` | Lançamento "a classificar" | Núcleo e banco | ( ) aprovo ( ) altero |
| `OPERACOES_IMPORTADAS_PENDENTES` | Propostas não aplicadas nem rejeitadas | Núcleo | ( ) aprovo ( ) altero |
| `IMPORTACAO_NAO_CONCLUIDA` | Importação em validação/revisão | Núcleo | ( ) aprovo ( ) altero |

## Decisões de POLÍTICA que dependem do responsável financeiro (marcadas **RF**)

1. Aceitar homologar com **entrada sem origem** (#11), **transação sem pedido** (#6), **conta sem comprovante** (#10)
   e **relatório ausente** (#9) como ressalvas documentadas.
2. Confirmar que **diferença de taxa** (#13) bloqueia até registrar a taxa.
3. Confirmar que **diferença de caixa** já justificada (#23) e **conciliação a decidir** (#15) não pesam no resultado.
4. **Materialidade:** continua inexistente (nada é dispensado por ser pequeno). Qualquer política futura precisa de
   valor, critério e responsável definidos aqui.
5. **MFA recente** para conceder, revogar, homologar, reabrir e provisionar (proposta técnica; doc 23).

Registro da aprovação (a preencher pelo responsável): nome, cargo, data, decisões e eventuais alterações.
