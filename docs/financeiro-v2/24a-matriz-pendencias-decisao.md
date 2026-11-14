# Financeiro v2 — 24a. Matriz das pendências: APRESENTAÇÃO PARA DECISÃO

Data: 14/11/2026 (Execução 09C). Gerada a partir da [23a](23a-matriz-pendencias-aprovacao.md) (mesmos 24 tipos e 7 impedimentos,
mesmo vínculo com o código). **Nenhuma regra de fechamento foi alterada para antecipar homologação.**

> **SITUAÇÃO: AGUARDANDO DECISÃO HUMANA DO RESPONSÁVEL FINANCEIRO. NÃO APROVADA.** Nada nesta página é aprovação.

Em todas as linhas a **regra proposta é a regra implementada hoje** (nenhuma proposta de mudança pendente além das
marcadas **RF**). Onde o responsável decidir alterar, a mudança vira uma execução própria, com testes.

## Pendências

| # | Tipo | Regra proposta (= implementada hoje) | Impacto econômico | Evidência necessária | Ressalva? | Condição bloqueante | Justificativa | Decisão humana |
|---|---|---|---|---|---|---|---|---|
| 1 | `DESPESA_A_CLASSIFICAR` | EXIGE_DOC + INDETERMINADO (+ impedimento); resolve: Reclassificar | Fora da DRE; pode superestimar o resultado | Nota, boleto ou contrato | Não | Sempre | Natureza desconhecida pode esconder despesa | ( ) aprovo ( ) altero — nome/data: ____ |
| 2 | `DESCONTO_A_CLASSIFICAR` | EXIGE_DOC + INDETERMINADO (+ impedimento); resolve: Reclassificar ou registrar terceiro | Dedução provisória | Relatório do canal com o financiador | Não | Sempre | Quem paga o desconto muda a dedução | ( ) aprovo ( ) altero — nome/data: ____ |
| 3 | `SAIDA_SEM_CLASSIFICACAO` | EXIGE_DOC + INDETERMINADO; resolve: Vincular conta (com evidência) ou registrar conta | Possível despesa não reconhecida | Comprovante ou boleto | Não | Sempre (núcleo e banco) | Dinheiro saiu sem explicação econômica | ( ) aprovo ( ) altero — nome/data: ____ |
| 4 | `SOBREPOSICAO_AGREGADO_PEDIDOS` | BLOQUEIA + INDETERMINADO (+ impedimento); resolve: Substituir agregado | Receita em dobro | Relatório por pedido | Não | Sempre | Duplicidade superestima receita | ( ) aprovo ( ) altero — nome/data: ____ |
| 5 | `PROPOSTA_EM_ABERTO` | EXIGE_DOC + INDETERMINADO (+ impedimento); resolve: Aprovar+aplicar ou rejeitar | Receita/despesa faltando | O arquivo importado | Não | Sempre | Resultado incompleto | ( ) aprovo ( ) altero — nome/data: ____ |
| 6 | `TRANSACAO_SEM_PEDIDO` | EXIGE_DOC + CONHECIDO; resolve: Importar pedidos ou rejeitar | Possível receita não registrada até o valor | Relatório por pedido do dia | Sim, documentada, com valor | Sem documentação | Só pode subestimar (receita a menos) | **RF** ( ) aprovo ( ) altero — nome/data: ____ |
| 7 | `IMPORTACAO_A_REVISAR` | EXIGE_DOC + INDETERMINADO (+ impedimento); resolve: Confirmar ou rejeitar | Registros fora do sistema | O arquivo | Não | Sempre | Resultado incompleto | ( ) aprovo ( ) altero — nome/data: ____ |
| 8 | `IMPORTACAO_COM_PENDENCIAS` | NAO_BLOQUEIA + SEM_EFEITO; resolve: (informativa) | Nenhum adicional | Justificativa registrada | Não exige | Nunca | Decisão já tomada e auditada | ( ) aprovo ( ) altero — nome/data: ____ |
| 9 | `FONTE_SEM_DOCUMENTO` | EXIGE_DOC + SEM_EFEITO; resolve: Importar | Nenhum no resultado registrado | O relatório | Sim, documentada | Sem documentação | Falta só a conferência cruzada | **RF** ( ) aprovo ( ) altero — nome/data: ____ |
| 10 | `OBRIGACAO_SEM_COMPROVANTE` | EXIGE_DOC + CONHECIDO; resolve: Vincular documento | Despesa pelo valor da conta (se indevida, subestima) | Boleto, nota, contrato | Sim, documentada, com valor | Sem documentação ou valor mudou | Efeito conhecido e conservador | **RF** ( ) aprovo ( ) altero — nome/data: ____ |
| 11 | `CREDITO_NAO_IDENTIFICADO` | EXIGE_DOC + CONHECIDO; resolve: Vincular ou registrar transferência | Receita possivelmente não registrada até o valor; ou aporte (sem efeito) | Comprovante do depósito | Sim, documentada | Sem documentação | Só pode subestimar | **RF** ( ) aprovo ( ) altero — nome/data: ____ |
| 12 | `TOTAIS_DE_RELATORIOS_DIFERENTES` | BLOQUEIA (aberta) / EXIGE_DOC (explicada) + CONHECIDO; resolve: Explicar com evidência | Causa não comprovada | Relatório por pedido | Só explicada | Aberta | Sem explicação não se sabe o efeito | ( ) aprovo ( ) altero — nome/data: ____ |
| 13 | `TAXA_OU_VALOR_DIVERGENTE` | EXIGE_DOC + INDETERMINADO; resolve: Registrar ajuste da taxa e dar baixa | Crédito menor = taxa fora da DRE (superestima) | Demonstrativo de repasse | Não (desde a 09) | Sempre | Princípio conservador | **RF** ( ) aprovo ( ) altero — nome/data: ____ |
| 14 | `SALDO_DIVERGENTE` | BLOQUEIA + INDETERMINADO (+ impedimento); resolve: Localizar movimento | Indeterminado | Extrato completo | Não | Sempre | Caixa não confere | ( ) aprovo ( ) altero — nome/data: ____ |
| 15 | `CORRESPONDENCIA_A_DECIDIR` | EXIGE_DOC + SEM_EFEITO; resolve: Confirmar/rejeitar/divergência | Nenhum | Evidência do vínculo | Sim, documentada | Sem documentação | Conciliação não muda o resultado | **RF** ( ) aprovo ( ) altero — nome/data: ____ |
| 16 | `VENDA_SEM_PAGAMENTO` | EXIGE_DOC + SEM_EFEITO; resolve: Corrigir pagamento | Nenhum | Relatório da processadora | Sim, documentada | Sem documentação | Receita já reconhecida | ( ) aprovo ( ) altero — nome/data: ____ |
| 17 | `PAGAMENTO_INCOMPATIVEL` | EXIGE_DOC + SEM_EFEITO; resolve: Corrigir pagamento | Nenhum | Relatório da processadora | Sim, documentada | Sem documentação | Receita já reconhecida | ( ) aprovo ( ) altero — nome/data: ____ |
| 18 | `RECEBIMENTO_DIRETO_NAO_IDENTIFICADO` | EXIGE_DOC + SEM_EFEITO; resolve: Registrar entrada | Nenhum | Contagem/comprovante | Sim, documentada | Sem documentação | Afeta caixa, não resultado | ( ) aprovo ( ) altero — nome/data: ____ |
| 19 | `RECEBIVEL_SEM_REPASSE` | NAO_BLOQUEIA + SEM_EFEITO; resolve: Conciliar quando creditar | Nenhum | Demonstrativo | Não exige | Nunca | Recebível válido em aberto é normal | ( ) aprovo ( ) altero — nome/data: ____ |
| 20 | `RECEBIVEL_ATRASADO` | NAO_BLOQUEIA + SEM_EFEITO; resolve: Conciliar/cobrar | Nenhum | Demonstrativo | Não exige | Nunca | Idem | ( ) aprovo ( ) altero — nome/data: ____ |
| 21 | `REPASSE_INFORMADO_SEM_CREDITO` | NAO_BLOQUEIA + SEM_EFEITO; resolve: Conciliar | Nenhum | Extrato | Não exige | Nunca | Idem | ( ) aprovo ( ) altero — nome/data: ____ |
| 22 | `CREDITO_SEM_COMPROVACAO_BANCARIA` | EXIGE_DOC + SEM_EFEITO; resolve: Importar extrato e confirmar | Nenhum | Extrato do dia | Sim, documentada | Sem documentação | Afeta caixa, não resultado | ( ) aprovo ( ) altero — nome/data: ____ |
| 23 | `DIFERENCA_DE_CAIXA` | NAO_BLOQUEIA + SEM_EFEITO; resolve: (informativa) | Nenhum ajuste automático | Justificativa do fechamento | Não exige | Nunca | Já justificada no fechamento do caixa | **RF** ( ) aprovo ( ) altero — nome/data: ____ |
| 24 | `VENDA_SEM_CANAL` | NAO_BLOQUEIA + SEM_EFEITO; resolve: Importar pedidos | Nenhum no total | Relatório por pedido | Não exige | Nunca | Total correto, só sem distribuição | ( ) aprovo ( ) altero — nome/data: ____ |

## Impedimentos (bloqueiam sempre)

| Código | Quando | Onde | Regra proposta (= implementada) | Decisão humana |
|---|---|---|---|---|
| `DIVERGENCIA_ENTRE_RELATORIOS_SEM_JUSTIFICATIVA` | Totais diferentes sem explicação | Núcleo | Bloqueia a homologação | ( ) aprovo ( ) altero — nome/data: ____ |
| `SALDO_DE_CONTA_DIVERGENTE` | Saldo informado ≠ calculado | Núcleo | Bloqueia a homologação | ( ) aprovo ( ) altero — nome/data: ____ |
| `RECEITA_EM_DUPLICIDADE` | Agregado e pedidos no mesmo dia | Núcleo | Bloqueia a homologação | ( ) aprovo ( ) altero — nome/data: ____ |
| `CONCILIACAO_DIVERGENTE_SEM_RESOLUCAO` | Diferença sem resolução com documento | Núcleo | Bloqueia a homologação | ( ) aprovo ( ) altero — nome/data: ____ |
| `CLASSIFICACAO_PROVISORIA` | Lançamento "a classificar" | Núcleo e banco | Bloqueia a homologação | ( ) aprovo ( ) altero — nome/data: ____ |
| `OPERACOES_IMPORTADAS_PENDENTES` | Propostas não aplicadas nem rejeitadas | Núcleo | Bloqueia a homologação | ( ) aprovo ( ) altero — nome/data: ____ |
| `IMPORTACAO_NAO_CONCLUIDA` | Importação em validação/revisão | Núcleo | Bloqueia a homologação | ( ) aprovo ( ) altero — nome/data: ____ |

## Pontos que EXIGEM aprovação humana (não técnicos)

1. Homologar com **ressalva documentada** para: transação sem pedido (#6), relatório ausente (#9), conta sem comprovante
   (#10), crédito não identificado (#11), conciliação a decidir (#15) — todas só subestimam o resultado ou não o afetam.
2. **Taxa/valor divergente** (#13) bloqueia até registrar a taxa (mudança feita na 09 por princípio conservador).
3. **Diferença de caixa** já justificada (#23) não pesa no fechamento.
4. **Materialidade:** continua inexistente (nada é dispensado por ser pequeno).
5. **MFA recente** (10 min) para conceder, revogar, homologar, reabrir, provisionar e alterar liberação.
6. **Contas compartilhadas** não operam o v2 (decisão de arquitetura mantida).

Registro da decisão: nome, cargo, data, itens aprovados, itens alterados e a justificativa de cada alteração.
