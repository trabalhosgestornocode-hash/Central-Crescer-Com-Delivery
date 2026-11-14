# Financeiro v2 — 22a. Matriz das pendências do fechamento (para validação do responsável financeiro)

Data: 14/11/2026 (Execução 09). **Situação: IMPLEMENTADA, NÃO APROVADA PELA EMPRESA.** Esta matriz descreve o que o
sistema faz hoje; estar implementada não a torna política aprovada. Cada linha precisa do "de acordo" (ou da correção)
do responsável financeiro antes do uso real.

Fontes no código: `dominio/conferencias.js` (`pendenciasDaCompetencia`, `impedimentosDeHomologacao`),
`dominio/ressalvas.js` (`EFEITO_POR_CODIGO`, `avaliarPendenciasDoFechamento`) e as migrações 0018–0020 (banco).
Teste que amarra esta matriz ao código: `backend/test/financeiro-v2/matriz-pendencias.test.js` (falha se um código
existir no código e não aqui, ou se a regra de um código mudar sem esta matriz mudar).

## Como ler

- **Efeito no fechamento** (o que a pendência exige): `BLOQUEIA` (precisa ser resolvida), `EXIGE_DOCUMENTACAO` (precisa
  ser resolvida OU documentada) ou `NAO_BLOQUEIA` (acompanhamento).
- **Efeito no resultado** (decide se pode virar ressalva): `SEM_EFEITO` (o resultado registrado não muda), `CONHECIDO`
  (efeito quantificado e, no pior caso, subestima o resultado) ou `INDETERMINADO` (pode distorcer o resultado de modo
  não esclarecido, ou superestimá-lo: **nunca** é ressalva).
- **Ressalva admissível** = efeito no fechamento `EXIGE_DOCUMENTACAO` + efeito no resultado `SEM_EFEITO`, ou `CONHECIDO`
  com valor, + documentação com decisão e "o que falta" (ou evidência). Texto, sozinho, nunca torna nada admissível.
- **Impedimento** = verificação objetiva do núcleo (e, quando possível, do banco) que bloqueia sempre.
- Sem política de materialidade: nenhum valor é "pequeno demais". A ausência de política **não** libera pendência incerta.
- Decisões que exigem autorização (todas com justificativa, histórico e permissão própria): documentar pendência
  (`fechar`), reclassificar (`reclassificar`), confirmar/rejeitar conciliação (`conciliar`), aprovar/aplicar proposta
  (`aprovar`/`aplicar`), confirmar importação (`confirmar_importacao`), vincular pagamento (`vincular_pagamento`),
  homologar com ressalvas (`homologar`, MFA recente proposto), reabrir (`reabrir`, MFA recente proposto).

## Matriz

| Código | Nome na tela | Natureza / fonte | Impacto na DRE | Impacto no caixa | Recebíveis / obrigações | Resolve como | Ressalva? | Bloqueia quando | Evidência necessária |
|---|---|---|---|---|---|---|---|---|---|
| `DESPESA_A_CLASSIFICAR` | Despesa sem classificação | Conta a pagar na categoria "a classificar" | Fica FORA da DRE até classificar (resultado pode estar superestimado) | Nenhum | Obrigação existe | Reclassificar com documento | **Não** (INDETERMINADO) | Sempre (também impedimento `CLASSIFICACAO_PROVISORIA`; banco 0018/0019) | Nota, boleto ou contrato |
| `DESCONTO_A_CLASSIFICAR` | Desconto sem financiador confirmado | Desconto de venda sem financiador | Dedução provisória | Nenhum | Pode virar recebível de terceiro | Reclassificar (loja) ou registrar terceiro com documento | **Não** | Sempre (impedimento `CLASSIFICACAO_PROVISORIA`) | Relatório do canal com o financiador |
| `SAIDA_SEM_CLASSIFICACAO` | Saída bancária sem classificação | Saída do extrato/caixa sem vínculo | Possível despesa não reconhecida (superestima) | Já saiu | Pode quitar obrigação | Vincular a conta a pagar (com evidência) ou registrar a conta | **Não** | Sempre (banco 0018/0019 confere saída sem vínculo) | Comprovante ou boleto |
| `SOBREPOSICAO_AGREGADO_PEDIDOS` | Venda agregada e pedidos no mesmo dia | SAIPOS diário × pedidos | Receita em dobro | Nenhum | — | Substituir o agregado pelos pedidos | **Não** | Sempre (BLOQUEIA; impedimento `RECEITA_EM_DUPLICIDADE`) | Relatório por pedido |
| `PROPOSTA_EM_ABERTO` | (operação) aguardando decisão | Proposta de importação não decidida/aplicada | Efeito ainda não registrado (receita ou despesa faltando) | Pode faltar | Pode faltar | Aprovar e aplicar, ou rejeitar | **Não** | Sempre (impedimento `OPERACOES_IMPORTADAS_PENDENTES`) | O arquivo importado |
| `TRANSACAO_SEM_PEDIDO` | Transação Stone sem pedido | Stone sem venda correspondente | Possível receita não registrada **até o valor** (subestima) | Recebido pela processadora | Recebível não formado | Importar pedidos do dia ou rejeitar | Sim, documentada, com valor | Sem documentação | Relatório por pedido do dia |
| `IMPORTACAO_A_REVISAR` | Importação aguardando revisão | Arquivo recebido, prévia não confirmada | Registros fora do sistema | Pode faltar | Pode faltar | Confirmar ou rejeitar a prévia | **Não** | Sempre (impedimento `IMPORTACAO_NAO_CONCLUIDA`) | O arquivo |
| `IMPORTACAO_COM_PENDENCIAS` | Importação aceita com divergências | Divergências aceitas com justificativa | Nenhum adicional (já decidido) | Nenhum | — | (informativa) | Não exige | Nunca | A justificativa da importação |
| `FONTE_SEM_DOCUMENTO` | Falta: (relatório) | Relatório esperado não importado | Nenhum no resultado registrado; conferência cruzada incompleta | Nenhum | — | Importar | Sim (SEM_EFEITO), documentada | Sem documentação | O relatório do período |
| `OBRIGACAO_SEM_COMPROVANTE` | Conta sem comprovante | Conta sem boleto/nota | Despesa reconhecida pelo valor da conta (se indevida, subestima) | Nenhum | Dívida em aberto | Vincular o documento | Sim (CONHECIDO, valor = saldo), documentada | Sem documentação; ou se o valor mudar depois de documentada | Boleto, nota ou contrato |
| `CREDITO_NAO_IDENTIFICADO` | Crédito não identificado | Entrada sem venda/título/transferência | No pior caso, receita não registrada **até o valor** (subestima); pode ser aporte/empréstimo (sem efeito) | Já entrou | Pode quitar recebível | Vincular a recebível/venda ou registrar transferência | Sim (CONHECIDO), documentada — **validar** | Sem documentação | Comprovante do depósito/transferência |
| `TOTAIS_DE_RELATORIOS_DIFERENTES` | Diferença comercial entre relatórios | Dois relatórios com totais diferentes | Causa não comprovada; nada ajustado | — | — | Explicar com evidência | Só depois de **explicada** (aberta = BLOQUEIA; impedimento `DIVERGENCIA_ENTRE_RELATORIOS_SEM_JUSTIFICATIVA`) | Aberta | Relatório por pedido |
| `TAXA_OU_VALOR_DIVERGENTE` | (recebível) com diferença | Crédito do processador ≠ esperado | Crédito menor = taxa/perda fora da DRE (**superestima**) | Diferença no banco | Recebível com saldo | Registrar o ajuste (taxa) com documento e dar baixa | **Não** (corrigido na 09: era CONHECIDO) | Sempre | Demonstrativo de repasse |
| `SALDO_DIVERGENTE` | Saldo de (conta) não confere | Saldo informado ≠ calculado | Movimento faltando/duplicado: indeterminado | Divergente | — | Localizar o movimento | **Não** | Sempre (BLOQUEIA; impedimento `SALDO_DE_CONTA_DIVERGENTE`) | Extrato completo |
| `CORRESPONDENCIA_A_DECIDIR` | Conciliação a decidir | Correspondência candidata/aguardando documento | Nenhum (conciliação não muda o resultado) | Nenhum | — | Confirmar, rejeitar ou registrar divergência | Sim (SEM_EFEITO), documentada | Sem documentação | Evidência do vínculo |
| `VENDA_SEM_PAGAMENTO` | Venda sem pagamento | Pagamentos não fecham com a venda | Nenhum (receita já reconhecida) | Recebimento incompleto | Recebível incompleto | Corrigir pagamento / importar processadora | Sim (SEM_EFEITO), documentada | Sem documentação | Relatório da processadora |
| `PAGAMENTO_INCOMPATIVEL` | Pagamento incompatível | Pagamentos em excesso/forma divergente | Nenhum | Diferença | — | Corrigir pagamento | Sim (SEM_EFEITO), documentada | Sem documentação | Relatório da processadora |
| `RECEBIMENTO_DIRETO_NAO_IDENTIFICADO` | Recebimento direto não identificado | Dinheiro/Pix sem conta de entrada | Nenhum | Dinheiro sem vínculo | — | Registrar a entrada | Sim (SEM_EFEITO), documentada | Sem documentação | Contagem do caixa / comprovante |
| `RECEBIVEL_SEM_REPASSE` | Recebível sem repasse | Direito a receber não creditado | Nenhum | Ainda não entrou | Recebível em aberto | Conciliar quando creditar | Não exige | Nunca (recebível válido não bloqueia) | Demonstrativo |
| `RECEBIVEL_ATRASADO` | Recebível atrasado | Previsto já passou | Nenhum | Ainda não entrou | Recebível em aberto | Conciliar / cobrar | Não exige | Nunca | Demonstrativo |
| `REPASSE_INFORMADO_SEM_CREDITO` | Repasse sem crédito | Processador informa repasse sem crédito no banco | Nenhum | Não entrou | Recebível em aberto | Conciliar | Não exige | Nunca | Extrato |
| `CREDITO_SEM_COMPROVACAO_BANCARIA` | Repasse não conciliado com o extrato | Recebimento sem extrato | Nenhum | Pode não ter entrado | — | Importar extrato e confirmar | Sim (SEM_EFEITO), documentada | Sem documentação | Extrato do dia |
| `DIFERENCA_DE_CAIXA` | Diferença na contagem do caixa | Fechamento de caixa com diferença justificada | Nenhum ajuste automático | Diferença física | — | (informativa) | Não exige | Nunca | Justificativa do fechamento |
| `VENDA_SEM_CANAL` | Faturamento sem canal | Agregado sem canal | Nenhum no total | Nenhum | — | Importar pedidos | Não exige | Nunca | Relatório por pedido |

### Impedimentos (bloqueiam sempre; não são pendências documentáveis)

| Código | Quando | Onde |
|---|---|---|
| `DIVERGENCIA_ENTRE_RELATORIOS_SEM_JUSTIFICATIVA` | Relatórios do mesmo período com totais diferentes, sem explicação | Núcleo |
| `SALDO_DE_CONTA_DIVERGENTE` | Saldo informado ≠ calculado no período | Núcleo |
| `RECEITA_EM_DUPLICIDADE` | Agregado e pedidos do mesmo dia ativos | Núcleo |
| `CONCILIACAO_DIVERGENTE_SEM_RESOLUCAO` | Conciliação com diferença sem resolução comprovada por documento | Núcleo |
| `CLASSIFICACAO_PROVISORIA` | Lançamento ativo em categoria "a classificar" | Núcleo **e banco** (0018/0019) |
| `OPERACOES_IMPORTADAS_PENDENTES` | Propostas da competência não aplicadas nem rejeitadas | Núcleo |
| `IMPORTACAO_NAO_CONCLUIDA` | Importação em validação/revisão no período | Núcleo |
| (saída sem vínculo) | Saída válida do período com valor não alocado | **Banco** (0018/0019), além da pendência no núcleo |

## Pontos que precisam de decisão do responsável financeiro

1. **`CREDITO_NAO_IDENTIFICADO` como ressalva.** O princípio é "subestima, nunca superestima". Validar se a empresa aceita
   homologar com entrada sem origem (ex.: aporte de sócio não registrado não muda o resultado; venda não registrada o
   subestima).
2. **`TRANSACAO_SEM_PEDIDO` como ressalva.** Mesma lógica (receita possivelmente faltando).
3. **`OBRIGACAO_SEM_COMPROVANTE` como ressalva.** A despesa entra pelo valor da conta; se a conta for indevida, o
   resultado está subestimado.
4. **`TAXA_OU_VALOR_DIVERGENTE`** foi tornado bloqueante na 09 (crédito menor que o esperado superestimava o
   resultado). Confirmar.
5. Ações que exigem **MFA recente** (proposta): conceder, revogar, homologar, reabrir.
6. Política de **materialidade**: continua inexistente; nada é dispensado por ser pequeno.

## Lacunas de teste (honestidade)

Todos os códigos têm a REGRA de admissibilidade conferida no teste da matriz. Cobertura ponta a ponta (cenário completo
que gera a pendência e a leva até o fechamento) ainda não existe para: `PAGAMENTO_INCOMPATIVEL`,
`RECEBIMENTO_DIRETO_NAO_IDENTIFICADO`, `RECEBIVEL_SEM_REPASSE`, `DIFERENCA_DE_CAIXA`, `IMPORTACAO_COM_PENDENCIAS`,
`IMPORTACAO_A_REVISAR`, `PROPOSTA_EM_ABERTO` (citada só por fluxo), `RECEITA_EM_DUPLICIDADE` e
`IMPORTACAO_NAO_CONCLUIDA` (impedimentos exercitados indiretamente).
