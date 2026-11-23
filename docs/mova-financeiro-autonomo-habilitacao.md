# MOVA financeiro autônomo — como funciona e como habilitar (Açaí no Grau Saci primeiro)

Estado: **código pronto para homologação; nada ativado em produção.** Este PR não aplica migração, não concede permissão e não liga chave.

## O que o MOVA faz agora com um comprovante + legenda

| Situação | Decisão |
|---|---|
| Nenhuma conta do favorecido (compra nova, ex.: "Brownies para o Açaí") | **Executa**: cria a conta com a descrição da legenda, anexa o comprovante e registra o pagamento por comprovante (conciliação com o extrato pendente). Responde o que fez, sem pedir confirmação. |
| Uma conta do favorecido com saldo **igual** ao valor | **Executa** a baixa da conta existente (sem despesa nova). |
| Valor **maior** que o saldo | **Pergunta**: "Os R$ X de diferença são juros dessa conta?" Responda "sim" → pedido de pagamento com juros para o Financeiro aplicar (ver decisões). "outra compra" → cria a despesa nova; a conta existente fica intacta. |
| Valor **menor** que o saldo | **Pergunta** se é pagamento parcial (a menos que a legenda diga "parcial", "entrada", "sinal", "adiantamento"…). "sim" → baixa parcial; o saldo restante e o valor original são preservados. |
| Várias contas candidatas | **Pergunta** com lista numerada; o número continua a operação. |
| Mesmo comprovante/transação/arquivo | **Duplicado**: não cria despesa, pagamento nem saída; informa o registro existente. |
| Remetente fora da lista, sem perfil de documentos, competência fechada, sem política ou sem concessão | Ignora / encaminha para conferência (proposta na Central). Nada é gravado. |

A resposta à pergunta é entendida por regras determinísticas (a IA não decide). Pode ser enviada **sem citar** a pergunta, na mesma conversa em que ela saiu (a pergunta com valores sai no privado do financeiro, conforme a política de resposta do grupo). A pendência dura 10 minutos e sobrevive a reinício. Depois da resposta, a operação segue sem segunda confirmação.

Categoria: o MOVA só usa uma categoria do plano da unidade quando **exatamente uma** categoria lançável de custo/despesa casa com a descrição (ex.: "brownies" → Insumos). Se houver zero ou mais de uma, usa a provisória "a classificar" e a Central revisa.

## Decisões de projeto (e por quê)

1. **Pagamento por comprovante, não saída bancária inventada.** "Paguei pelo banco → Ainda não está no extrato: registra a saída" cria uma movimentação bancária; quando o extrato chegasse, a mesma saída apareceria duas vezes. O Financeiro v2 já tem o caminho desenhado para isso (Execução 17): o pagamento é registrado pelo comprovante, **sem saída**, e a conciliação fica pendente até o extrato; o MOVA concilia depois, sem segunda baixa. É isso que o MOVA usa. O comprovante sozinho não comprova a compensação.
2. **Juros: o MOVA não grava.** Registrar juros exige a ação `corrigir` (ampla) ou uma ação nova e estreita com migração. Nesta etapa o "sim" gera **um pedido de BAIXA** (conta + juros, sem segunda obrigação) para o Financeiro aplicar na Central pelo serviço oficial de pagamento, em que a diferença vira juros e multas. Para automatizar os juros: criar a ação estreita `registrar_juros` (migração do Financeiro v2 + concessão) — decisão pendente do proprietário.
3. **Sem reestruturação:** reutiliza `registrar_obrigacao`, baixa por comprovante, conciliação posterior, idempotência em duas camadas, auditoria e a política de autonomia que já existiam.

## Habilitar em produção (Açaí, nesta ordem; tudo depende de aprovação explícita)

Pré-requisitos já entregues pelo PR #180: migrações `0030` (Financeiro v2) e `0010` (MOVA) — **conferir se estão aplicadas em produção** antes de ligar qualquer chave.

1. **Chaves (Render, backend):** `MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE=1` e `MOVA_OPERACAO_CRIAR_DESPESAS=1`. Hoje a criação de despesas está desligada.
2. **Identidade operacional do MOVA** (concessão só na unidade Açaí): `ver`, `registrar_obrigacao`, `baixar_por_comprovante`, `enviar_documento`. Para a conciliação posterior automática: também `vincular_pagamento`. **Nunca** `corrigir`, `pagar` ou ações de estorno.
3. **Política de autonomia** da unidade Açaí (feita por um responsável): operação `DESPESA_DOCUMENTAL` (compra nova) e, se desejado, `BAIXA_DOCUMENTAL` (conta existente), nível `APLICAR_AUTOMATICO`, com **limite por pagamento** (sugestão para o piloto: R$ 500,00) e vigência. Acima do limite, ou possível fracionamento, vira proposta para a Central. Desativação imediata da escrita: revogar a política (vale na hora) ou revogar a concessão da identidade operacional.
4. **Subway Saci: não habilitar.** Sem política e sem concessão a unidade nunca escreve (testado: unidade sem política fica em `SEM_POLITICA`).
5. **Orçamento de IA e limites de WhatsApp: inalterados.** Conferir `MOVA_IA_TETO_ENTRADA` ≥ ~6.000 e `MOVA_IA_TETO_SAIDA` ≥ ~600 (um print consome ~6 mil tokens de entrada e ~400 de saída).

## Homologação (só Açaí, valor real pequeno e autorizado)

1. Com a política em `APLICAR_COM_CONFIRMACAO` (só propõe), enviar o comprovante de R$ 108,00 com a legenda "Brownies para o Açaí" e conferir a proposta na Central (fornecedor, descrição, categoria, valor, data).
2. Se existir conta aberta da Andressa com saldo diferente, o MOVA **pergunta** (não presume juros nem compra nova): responder "outra compra".
3. Trocar a política para `APLICAR_AUTOMATICO` com limite R$ 500,00 e repetir com **outro** comprovante pequeno: esperado conta nova + pagamento por comprovante + resposta "Despesa registrada e paga por comprovante… Conciliação bancária: pendente".
4. Conferir: uma conta, uma baixa, uma despesa na DRE, nenhuma saída bancária; auditoria com `OPERACAO_EXECUTADA` da identidade operacional.
5. Reenviar o mesmo comprovante: deve responder duplicado, sem nada novo.
6. Quando o extrato do dia chegar, a conciliação liga a saída à mesma baixa (sem despesa nem baixa nova).

Rollback: revogar a política da unidade (para de escrever na hora); o que foi criado pode ser estornado pelo fluxo oficial de estorno por quem tem permissão.

## Testes

`node --test test/mova-financeiro/*.test.js` — 387 de 387 (11 novos em `financeiro-autonomo.test.js`: compra nova, conta exata, juros com continuação, "outra compra", parcial, várias contas, parcial por legenda, duplicidade, sem autorização/sem concessão, isolamento entre unidades e regras puras). Os testes existentes de baixa parcial passaram a enviar a evidência de "parcial" na legenda, porque agora o MOVA pergunta quando ela não existe. A suíte do Financeiro v2 tem 86 falhas **idênticas na `main`** (não relacionadas).

## Não coberto nesta etapa

Juros gravados automaticamente (decisão 2); vínculo automático de conta bancária de origem (o pagamento por comprovante não usa conta; ambiguidade de banco só importa na conciliação, que já recusa saída ambígua); generalização de categorias além da busca por nome no plano; Subway.
