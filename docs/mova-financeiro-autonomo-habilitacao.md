# MOVA financeiro autônomo — como funciona e como habilitar (Açaí no Grau Saci primeiro)

Estado: **código pronto para homologação; nada ativado em produção.** Este PR não aplica migração, não concede permissão e não liga chave. Contém **duas migrações novas** (Financeiro v2 `0031`, MOVA `0012`) que precisam de aprovação explícita antes de ir a produção.

## O que o MOVA faz com um comprovante + legenda

| Situação | Decisão |
|---|---|
| Nenhuma conta do favorecido (compra nova, ex.: "Brownies para o Açaí") **e nada parece já registrado** (ver linha de semelhantes) | **Executa**: cria a conta com a descrição da legenda, anexa o comprovante e registra o pagamento por comprovante (conciliação com o extrato pendente). Responde o que fez, sem pedir confirmação. |
| Uma conta do favorecido com saldo **igual** ao valor | **Executa** a baixa da conta existente (sem despesa nova). |
| Valor **maior** que o saldo | **Pergunta**: "Os R$ X de diferença são juros dessa conta?" "sim" → registra o **principal (saldo da conta) + o encargo (juros/multa)** e quita a conta, com o comprovante vinculado e a conciliação pendente — automaticamente se as chaves, a política `JUROS_DOCUMENTAL` e a ação `registrar_juros` estiverem ligadas; senão, vira UM pedido de baixa com juros para o Financeiro aplicar na Central. "outra compra" → cria a despesa nova; a conta existente fica intacta. |
| Valor **menor** que o saldo | **Pergunta** se é pagamento parcial, a menos que a legenda diga "parcial", "entrada", "sinal", "adiantamento"… "sim" → baixa parcial; o saldo restante e o valor original são preservados. |
| Várias contas candidatas | **Pergunta** com lista numerada; o número continua a operação. |
| Pagamento igual **já registrado** (conta paga do mesmo fornecedor, mesmo valor, até 10 dias) ou conta **aberta de outro fornecedor** com o mesmo valor e descrição parecida/vencimento até 7 dias | **Pergunta** antes de criar: "sim" → nada novo (informa o registro) ou baixa dessa conta; "outra compra" → cria a despesa. A ausência de conta do mesmo favorecido **não é, sozinha, prova de compra nova**. |
| Mesmo comprovante/transação/arquivo | **Duplicado**: não cria despesa, pagamento nem saída; informa o registro existente. |
| Remetente fora da lista, sem perfil de documentos, competência fechada, sem política ou sem concessão | Ignora / encaminha para conferência (proposta na Central). Nada é gravado. |

A resposta à pergunta é entendida por regras determinísticas (a IA não decide). Pode ser enviada **sem citar** a pergunta, na mesma conversa em que ela saiu (a pergunta com valores sai no privado do financeiro, conforme a política de resposta do grupo). A pendência dura 10 minutos e sobrevive a reinício. Depois da resposta, a operação segue sem segunda confirmação.

Categoria: o MOVA só usa uma categoria do plano da unidade quando **exatamente uma** categoria lançável de custo/despesa casa com a descrição (ex.: "brownies" → Insumos). Se houver zero ou mais de uma, usa a provisória "a classificar" e a Central revisa.

## Decisões de projeto (e por quê)

1. **Pagamento por comprovante, não saída bancária inventada.** "Paguei pelo banco → Ainda não está no extrato: registra a saída" cria uma movimentação bancária; quando o extrato chegasse, a mesma saída apareceria duas vezes. O Financeiro v2 já tem o caminho desenhado para isso (Execução 17): o pagamento é registrado pelo comprovante, **sem saída**, e a conciliação fica pendente até o extrato; o MOVA concilia depois, sem segunda baixa. O comprovante sozinho não comprova a compensação.
2. **Juros e multa pela ação estreita `registrar_juros` (migração 0031), nunca `corrigir`.** A operação `registrarPagamentoComEncargo` do núcleo exige `baixar_por_comprovante` + `registrar_juros` e, numa só transação: lança o encargo como ajuste da conta na categoria oficial "Juros e multas pagos a fornecedores" (competência do pagamento) e liquida o TOTAL do comprovante (principal = saldo + encargo). Travas: só quita a conta; encargo ≤ 10% do valor da conta (acima, só pessoa autorizada); a categoria não é criada por esta ação; idempotente pelo documento (repetir não lança juros nem baixa de novo); o **banco** repete as regras (RLS + gatilhos, inclusive o teto de 10%). Como o comprovante e a saída do extrato terão o mesmo total, a conciliação posterior liga à MESMA baixa. O tipo (juros/multa) fica no motivo do ajuste; a classificação oficial hoje é uma só (juros e multas).
3. **Política própria do encargo:** operação `JUROS_DOCUMENTAL` (MOVA, migração 0012), cujo limite é o **encargo máximo por pagamento** (configurável por unidade); o pagamento total também passa pela política `BAIXA_DOCUMENTAL`. As duas precisam ser automáticas. Sem qualquer uma delas, sem a chave `MOVA_OPERACAO_REGISTRAR_JUROS` ou sem a concessão, vira pedido para o Financeiro.
4. **Sem reestruturação:** reutiliza `registrar_obrigacao`, baixa por comprovante, ajuste de título, conciliação posterior, idempotência em duas camadas, auditoria e a política de autonomia que já existiam.
5. **Dados bancários do comprovante** ficam na proposta (banco de origem e de destino, favorecido, valor, data e hora, ID da operação) como evidência para a conciliação. A **conta de origem** não está no contrato de leitura (o comprovante raramente a traz) e não foi inventada. Nada presume que o extrato confirmou a movimentação.

## Habilitar em produção (Açaí, nesta ordem; tudo depende de aprovação explícita)

0. **Migrações (aprovação explícita; pacotes regenerados em `database/*/producao/`):** Financeiro v2 `0031_registrar_juros_no_pagamento` e MOVA `0012_mova_juros_documental` (e `0030`/`0010`/`0011` dos PRs #180/#181, se ainda não aplicadas — conferir antes). Recuperação: `database/*/recuperacao/reverter-0031.sql` e `reverter-0012.sql` (recusam se já houver concessão/política/operação usando a ação nova).
1. **Chaves (Render, backend):** `MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE=1` e `MOVA_OPERACAO_CRIAR_DESPESAS=1`; para os juros, também `MOVA_OPERACAO_REGISTRAR_JUROS=1` (exige a primeira). Hoje tudo isso está desligado.
2. **Identidade operacional do MOVA** (concessão só na unidade Açaí): `ver`, `registrar_obrigacao`, `baixar_por_comprovante`, `enviar_documento` e, para os juros, `registrar_juros`. Para a conciliação posterior automática: também `vincular_pagamento`. **Nunca** `corrigir`, `pagar` ou ações de estorno. A categoria oficial de juros e multas precisa existir na unidade (o plano implantado a traz); se faltar, o primeiro encargo é registrado por uma pessoa autorizada.
3. **Política de autonomia** da unidade Açaí (feita por um responsável): operação `DESPESA_DOCUMENTAL` (compra nova) e, se desejado, `BAIXA_DOCUMENTAL` (conta existente) e `JUROS_DOCUMENTAL` (juros/multa; limite = encargo máximo, sugestão R$ 30,00), nível `APLICAR_AUTOMATICO`, com **limite por pagamento** (sugestão para o piloto: R$ 500,00) e vigência. Acima do limite, ou possível fracionamento, vira proposta para a Central. Desativação imediata da escrita: revogar a política (vale na hora) ou a concessão da identidade operacional.
4. **Subway Saci: não habilitar.** Sem política e sem concessão a unidade nunca escreve (testado: unidade sem política fica em `SEM_POLITICA`).
5. **Orçamento de IA e limites de WhatsApp: inalterados.** Conferir `MOVA_IA_TETO_ENTRADA` ≥ ~6.000 e `MOVA_IA_TETO_SAIDA` ≥ ~600 (um print consome ~6 mil tokens de entrada e ~400 de saída).

## Homologação (só Açaí, valor real pequeno e autorizado)

1. Com a política em `APLICAR_COM_CONFIRMACAO` (só propõe), enviar o comprovante de R$ 108,00 com a legenda "Brownies para o Açaí" e conferir a proposta na Central (fornecedor, descrição, categoria, valor, data).
2. Se existir conta aberta da Andressa com saldo diferente, ou pagamento igual já registrado, o MOVA **pergunta** (não presume juros nem compra nova): responder "outra compra" se for uma compra nova.
3. Trocar a política para `APLICAR_AUTOMATICO` com limite R$ 500,00 e repetir com **outro** comprovante pequeno: esperado conta nova + pagamento por comprovante + resposta "Despesa registrada e paga por comprovante… Conciliação bancária: pendente".
4. Conferir: uma conta, uma baixa, uma despesa na DRE, nenhuma saída bancária; auditoria com `OPERACAO_EXECUTADA` da identidade operacional.
5. Reenviar o mesmo comprovante: deve responder duplicado, sem nada novo.
6. Juros (só depois de aprovadas a 0031/0012, a chave e a concessão): conta pequena de teste de R$ 230,00 e comprovante de R$ 250,00 → "sim" → conta quitada, juros de R$ 20,00 na categoria "Juros e multas", uma baixa de R$ 250,00, nenhuma saída.
7. Quando o extrato do dia chegar, a conciliação liga a saída à mesma baixa (sem despesa nem baixa nova).

Rollback: revogar a política da unidade (para de escrever na hora); o que foi criado pode ser estornado pelo fluxo oficial de estorno por quem tem permissão.

## Testes e as 86 falhas do Financeiro v2

- MOVA: `node --test test/mova-financeiro/*.test.js` — **394 de 394** (387 anteriores + 7 em `financeiro-autonomo-juros.test.js`: juros automáticos com conciliação posterior, travas do juros, pagamento já registrado, conta aberta de outro fornecedor, compra nova sem pergunta, dados bancários preservados).
- Financeiro v2: `node --test test/financeiro-v2/*.test.js` — **761 passam, 0 falham, 3 ignorados** (4 novos em `pagamento-com-encargo.test.js`: encargo + conciliação, idempotência/duplicidade, limites e o teste "banco —" com a ação estreita no PostgreSQL).
- **Integração real em PostgreSQL isolado:** `FV2_REPOSITORIO=postgres FV2_EXIGIR_BANCO=1 node --test test/mova-financeiro/financeiro-autonomo*.test.js` — 18 de 18: MOVA → identidade operacional com sessão de banco e concessão gravada → criação de obrigação, baixa por comprovante, juros, idempotência e conciliação, com RLS e gatilhos do banco valendo.
- **As 86 falhas anteriores eram de AMBIENTE, não funcionais.** O banco-modelo local de testes (`scripts/fv2-banco-teste.mjs`, compartilhado entre worktrees em `%LOCALAPPDATA%\fv2-pg-teste`) estava defasado: fora reconstruído por um checkout com menos migrações, então a constraint `fv2_concessao_acoes_lista` não conhecia as ações novas (44× "o banco recusou a gravação", 39× "sem concessão ativa", 3 outras, todas consequência). `node scripts/fv2-banco-teste.mjs iniciar` no worktree com as migrações mais novas reconstrói o modelo e zera as falhas. Risco operacional: dois worktrees com migrações diferentes se sobrescrevem; rode `iniciar` antes de testar.
- 4 testes antigos de baixa parcial passaram a enviar "pagamento parcial" na legenda (agora o MOVA pergunta sem evidência).

## Não coberto nesta etapa

Conta bancária de origem (não vem no contrato de leitura e o pagamento por comprovante não usa conta); multa como categoria separada (a classificação oficial é uma só: juros e multas); encargo acima de 10% da conta (sempre pessoa autorizada); Subway; teste ponta a ponta com WhatsApp e IA reais (só com autorização).
