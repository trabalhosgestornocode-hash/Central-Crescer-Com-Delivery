# Financeiro v2 — 12. Vendas e Recebimentos (Execução 06B)

Data: 12/11/2026. Branch local `feat/financeiro-v2-vendas-recebimentos`, derivada de `5f4723c` (Execução 06A).

> Público: só dados sintéticos. Nada foi publicado; nenhuma rota do aplicativo foi criada ou alterada; produção não foi acessada. Nenhum valor real de setembro aparece aqui (eles ficam no documento privado 02, fora do Git).

Objetivo: o gestor acompanha cada venda **do pedido ao dinheiro no banco** sem confundir faturamento, processamento, recebível e crédito bancário.

```
venda ─► pagamento ─► transação no processador ─► taxa ─► recebível ─► repasse ─► crédito na conta ─► conciliação
(DRE)     (forma)        (Stone/iFood/...)        (despesa)  (direito)  (demonstrativo) (movimentação)   (extrato)
```

Cada seta só aparece **concluída** quando existe o registro que a prova. Etapa sem prova fica **pendente**, com a etapa explícita.

## 1. Fase A — auditoria da fundação (06A)

| Ponto | Achado | Correção | Testes |
|---|---|---|---|
| A.1 Saldo de referência | O saldo informado valia sempre como **início** do dia. Um "saldo final" de extrato registrado assim somaria de novo os movimentos daquele dia. Divergência entre saldos só aparecia como número, sem situação. | Saldo informado ganhou `referencia`: `INICIO_DO_DIA` (padrão, "saldo anterior") ou `FIM_DO_DIA` ("saldo final", já contém os movimentos do dia → vale a partir do início do dia seguinte). Só movimentos **posteriores** à referência entram. Cada conferência entre saldos tem `situacao` `CONFERE`/`DIVERGENTE`, movimentos considerados e o saldo anterior usado; o consolidado conta `saldosDivergentes`. Movimento com data anterior à primeira referência é contado à parte (`movimentosAnterioresAReferencia`) e nunca somado. Fim de dia de hoje é recusado (o dia não acabou). Migração local `0007_saldo_referencia.sql` (unicidade por conta + data + referência; referência imutável). | `auditoria-fundacao-06b.test.js` (3 testes: fim do dia, extrato com saldo anterior + final + lançamento atrasado + movimento anterior, regras e conflito) |
| A.2 Classificação provisória | A 06A tratava `OUTRAS_DESPESAS` como "aguardando classificação" em Contas a Pagar, **mas a DRE a contava como despesa confirmada** — a mesma obrigação tinha dois significados. | Nova categoria do sistema `DESPESAS_A_CLASSIFICAR`: a dívida existe (contas a pagar, fluxo), mas o lançamento fica **fora de todas as linhas da DRE** (`dre.foraDoResultado.aClassificar`) com pendência `DESPESA_A_CLASSIFICAR`, até ser reclassificado (uma única vez, com justificativa). `OUTRAS_DESPESAS` voltou a ser classificação confirmada. Títulos e movimentações mostram três coisas separadas: **sugestão bancária** (palavras do histórico do extrato, nunca classifica), **classificação econômica** (`CONFIRMADA`, `PENDENTE_DE_CLASSIFICACAO`, `PATRIMONIAL`, `NAO_SE_APLICA`) e **efeito na DRE**. Saída do extrato sem vínculo continua pendente e fora da DRE. | 2 testes (DRE × contas a pagar × reclassificação; extrato Unicred com sugestão "tarifa") |
| A.3 Recorrências | Série recorrente era identificada também pela **descrição**: "Aluguel" e "Aluguel de outubro" viravam duas séries e a previsão do mês seguinte saía **em dobro**. Mês com obrigação registrada sem a marcação de recorrência também recebia previsão. | Série = fornecedor + categoria + dia do mês. Mês **constituído** (qualquer obrigação do mesmo fornecedor e categoria vencendo nele, inclusive cancelada) nunca recebe previsão. Toda previsão sai marcada `registro: PREVISAO_RECORRENTE`, `base: ULTIMO_VALOR_DA_SERIE`, `estimado: true`, `obrigacaoConstituida: false`; títulos reais saem `registro: OBRIGACAO_CONSTITUIDA`. Limitação aceita: duas cobranças distintas do mesmo fornecedor e categoria no mesmo mês suprimem a previsão (subestima, nunca duplica). | 2 testes |

Os três ajustes foram confirmados por **mutação**: revertendo cada correção, os testes novos falham.

## 2. Consultas (somente leitura, ação `financeiro_v2.ver`)

Todas exigem **competência ou período** (início e fim, até 400 dias) — é o controle de volume —, paginam (até 100 itens) e recusam campos desconhecidos. Organização e unidade vêm só do contexto autenticado.

| Operação | Filtros | Devolve |
|---|---|---|
| `consultarVendas` | competência, período, canal (inclui `NAO_IDENTIFICADO`), forma (inclui `DESCONHECIDA`), processador (inclui `SEM_PROCESSADOR`), situação, valor mín./máx., identificador | resumo, itens (vendas e totais diários agregados), filtros disponíveis |
| `consultarPagamentosDeVendas` | os mesmos | pagamentos (forma × processador × destino), por forma, por processador, consolidado por processador, composição iFood, transações sem venda |
| `consultarTaxasEDescontos` | + tipo de componente | cada desconto, subsídio, devolução, taxa, comissão, anúncio, mensalidade, encargo e ajuste, com a linha da DRE e a fração de centavo |
| `consultarRecebiveisERepasses` | + situação do recebimento | cadeia de cada recebível (de venda e avulsos de processador) e os créditos agrupados por movimentação |
| `consultarDivergenciasDeVendas` | + código | divergências com impacto, fonte, período, motivo, evidências, situação e próxima ação |
| `detalharVenda` | id | venda ou total diário completo + linha do tempo + histórico |
| `detalharRecebimento` | id (recebível) | ciclo do recebível + linha do tempo + venda de origem + histórico |

Regras puras em `dominio/vendasRecebimentos.js`; aplicação em `aplicacao/vendasRecebimentos.js`; contratos em `contratos/vendasRecebimentos.js`.

### Mesmos números em qualquer tela

- **Faturamento** vem do motor de apuração (`apurar`). Com filtro só de competência, o resumo traz `conferenciaComDre` (bruto listado × Faturamento Bruto Próprio da DRE) — testado igual, inclusive por canal.
- **Recebíveis** usam `tituloAReceber` da tesouraria: esperado, recebido e saldo são os de Contas a Receber (testado registro a registro).
- **Deduções** listadas (desconto da loja, desconto sem financiador, devolução) = Deduções Comerciais da DRE no cenário de teste.
- Não há "segunda DRE": as telas só apresentam.

## 3. Venda: o que cada uma mostra

Identificador exibível (`SAIPOS · P-1`, `Registro manual · DEMO-1`), data, **horário quando a fonte informa** (pedido SAIPOS) — senão "não informado pela fonte" —, competência, canal, título para o gestor ("Venda no Balcão — cartão de crédito", "Venda no Balcão — pagamento misto (dinheiro + cartão de débito)", "Venda no iFood — pago pelo iFood (forma não detalhada)"), bruto próprio e seus componentes (produtos, acréscimos, serviços), descontos com financiador, valor cobrado do consumidor, situação, formas, processadores, recebíveis, cancelamentos/estornos, documentos, **dados originais × interpretação** e confiabilidade.

**Forma desconhecida nunca é inventada**: `OUTRA` aparece como "forma não detalhada" e entra no filtro `DESCONHECIDA`.

| Situação | Quando |
|---|---|
| Aguardando pagamento | falta pagamento informado para fechar o cobrado |
| Aguardando recebimento | paga; há recebível com saldo ou recebimento direto sem crédito identificado |
| Recebida sem comprovação | todo o valor creditado, mas algum crédito sem extrato/conciliação/contagem |
| Recebida e comprovada | todo o valor creditado e comprovado |
| Em divergência | recebível marcado divergente ou pagamentos acima do cobrado |
| Cancelada | cancelada com histórico; fora dos totais |
| Agregada (sem pedidos) | total diário de relatório agregado |

| Confiabilidade | Quando |
|---|---|
| Documentada | veio de relatório importado e sem pendências |
| Registrada sem documento | registro manual sem documento de origem |
| Agregada | total diário sem granularidade |
| Com pendência | desconto sem financiador, forma não detalhada, pagamento pendente, crédito a identificar ou divergência |

### Valores agregados (SAIPOS por dia)

O total diário é **um item próprio** (`AGREGADO_DIARIO`): data, bruto recuperado, descontos do dia (a classificar) e líquido do relatório, quantidade de vendas informada e a explicação da falta de granularidade. **Sem canal** (fica em "Sem canal identificado"), sem forma, sem processador, sem pagamentos e fora dos totais de recebimento (o resumo informa o valor "sem rastreio de recebimento"). Quando o relatório por pedido chega, a substituição atômica da Execução 03B cancela o agregado — os dois nunca somam juntos (sobreposição vira divergência).

## 4. Processadores e taxas

Por processador (Stone, iFood, Anota AI, operadoras de benefícios e futuros): transações vinculadas a vendas, bruto processado, taxas e custos informados (por tipo), líquido esperado, recebido (comprovado e sem comprovação), a receber (e quanto sem previsão), repasses documentados, por canal (recebível sem canal fica em "Sem canal identificado") e divergências.

- **Stone**: transação aprovada ≠ venda. Transação **sem pedido** fica preservada como evidência, aparece em "Transações sem venda" e como divergência, e **não** vira venda nem faturamento. Taxa em milionésimos de real: o registro mostra o **exato** (ex.: `1,057500`) e o **registrado** (`R$ 1,06`) com a regra **metade para cima**; a data da taxa é a da transação (não a de digitação).
- **iFood**: bruto próprio (e serviços/entrega), descontos da loja, descontos sem financiador comprovado, subsídios do iFood (a receber, não reduzem receita), comissões, taxas, mensalidades, anúncios, encargos e ajustes **separados**; líquido esperado; repassado (e quanto comprovado); ainda a receber. Comissões e taxas são despesas, não descontos; o líquido não é lucro nem depósito.

## 5. Recebíveis e repasses

Para cada recebível: bruto, custos, **valor esperado**, **valor liquidado**, **saldo restante**, data prevista e **origem da previsão** (`DOCUMENTO_DO_PROCESSADOR`, `DATA_SEM_DOCUMENTO`, `SEM_PREVISAO` — nunca inventada), data efetiva (último crédito, só quando quitado), repasse informado (demonstrativo) e cada crédito com conta, data, fonte e **comprovação**:

| Comprovação | Regra |
|---|---|
| Conciliado | movimentação conciliada |
| Extrato bancário | movimentação importada do extrato (Unicred) ou com documento de extrato |
| Contagem de caixa | dinheiro no caixa físico coberto por sessão de caixa fechada |
| Sem comprovação | movimentação digitada sem nenhum dos acima |

Suporta vários recebíveis por venda (pagamento misto, subsídio), várias vendas num repasse (crédito agrupado: uma linha por movimentação com os títulos e vendas que ela liquida), liquidação parcial, estornos (ajuste `ESTORNO`), valores ainda não recebidos e repasse sem comprovação bancária. Valor que só aparece no relatório de vendas **nunca** é marcado como recebido.

## 6. Linha do tempo

Etapas: venda registrada, pagamento informado, transação processada, taxa identificada, recebível formado, repasse informado, crédito na conta, conciliação confirmada (+ estorno e cancelamento). Cada evento: data efetiva (ou "não conhecida"; quando só existe a data de registro, ela aparece como tal), fonte, documentos, valor, situação (`CONCLUIDA`, `PENDENTE`, `NAO_SE_APLICA`) e descrição. Recebimento direto sem processador não tem transação nem recebível: o crédito na conta e a comprovação aparecem direto. Saldo não creditado gera uma etapa pendente com o valor que falta.

## 7. Divergências

| Código | Descrição |
|---|---|
| `VENDA_SEM_PAGAMENTO` | faltam pagamentos para fechar o cobrado |
| `PAGAMENTO_INCOMPATIVEL` | pagamentos acima do cobrado |
| `TRANSACAO_SEM_PEDIDO` | transação do processador sem venda (ou vínculo ambíguo) |
| `RECEBIVEL_SEM_REPASSE` | recebível sem demonstrativo e sem crédito |
| `RECEBIVEL_ATRASADO` | data prevista passou sem crédito |
| `REPASSE_INFORMADO_SEM_CREDITO` | demonstrativo existe, crédito não |
| `CREDITO_SEM_COMPROVACAO_BANCARIA` | crédito registrado sem extrato/conciliação |
| `RECEBIMENTO_DIRETO_NAO_IDENTIFICADO` | dinheiro/Pix sem conta de entrada |
| `TAXA_OU_VALOR_DIVERGENTE` | correspondência marcada divergente |
| `DESCONTO_SEM_FINANCIADOR` | desconto de financiador não comprovado |
| `VENDA_SEM_CANAL` | total agregado sem canal (informativa) |
| `TOTAIS_DE_RELATORIOS_DIFERENTES` | ex.: faturamento por dia × formas de pagamento |
| `SOBREPOSICAO_AGREGADO_PEDIDOS` | agregado e pedidos com receita no mesmo dia |

Cada uma traz descrição simples, impacto, fonte, período, motivo, evidências, situação e próxima ação. **Nada é resolvido por valores próximos e nenhum ajuste é criado para fechar diferença.**

## 8. Interface (demonstração local)

Item "Vendas e Recebimentos" do menu (antes "em construção"), servido só pelo demo `backend/scripts/fv2-demo-interface.mjs` em `127.0.0.1` (porta 5179 ou `FV2_DEMO_PORTA`).

- **Resumo**: vendas brutas próprias (com selo "igual à DRE" e a situação da DRE), descontos, valor cobrado, taxas e custos do recebimento, a receber, recebido e comprovado (+ registrado sem comprovação).
- **Abas**: Vendas · Pagamentos · Taxas e descontos · Recebíveis e repasses · Divergências. Filtros: canal, forma, processador e os de cada aba (situação, identificador, valor em reais convertido por texto — sem ponto flutuante —, tipo, recebimento, código).
- **Detalhes** em painel lateral: venda (identificação, valores, pagamentos, taxas/recebíveis/liquidações, cancelamentos, linha do tempo, originais × interpretação, evidências, histórico) e ciclo do recebimento.
- **Integração**: Visão Geral → canal → vendas do canal; DRE (Faturamento e Deduções) → vendas/taxas; composição → venda ou total do dia; Contas a Receber → ciclo do recebimento e venda de origem; Caixa e Bancos → recebimento liquidado pela movimentação, sugestão bancária separada da classificação, referência do saldo informado e conferência divergente. Sem vínculo, aparece pendência — nunca navegação falsa.
- **Experiência**: tabelas viram cartões no celular (conteúdo em bloco), abas roláveis, fichas em uma coluna, sem rolagem horizontal (medido a 390 px), foco volta ao botão de origem mesmo após navegar dentro do painel, Escape fecha, ações são botões reais. Troca rápida de competência/aba descarta respostas antigas e limpa a tela antes de consultar (sem flash).

## 9. Segurança

- Sessão (adaptador de sessão + concessões `financeiro_v2.*` reais do módulo), organização e unidade autorizadas e ação `ver` exigidas; somente leitura.
- Isolamento: outra unidade/organização não vê nem abre registros (referência válida de uma unidade dá 404 na outra).
- Respostas sanitizadas: identificadores internos viram referências opacas (só as já emitidas voltam a ser ids); documentos aparecem como "registrado, não acessível nesta versão" — sem link, arquivo ou caminho.
- Nada conectado à autenticação publicada; nenhuma rota pública.

## 10. Testes

| Conjunto | Resultado |
|---|---|
| Financeiro v2 em memória | 234 testes: 212 passam, 22 só-PostgreSQL pulados, 0 falhas |
| Financeiro v2 em PostgreSQL local isolado (migrações 0001–0007) | 234/234 |
| Frontend (todos) | 1.936 testes: 1.910 passam, 26 pulados (pré-existentes), 0 falhas |
| Novos | `auditoria-fundacao-06b.test.js` (7), `vendas-recebimentos.test.js` (8), `frontend/test/financeiroV2Vendas.test.js` (9) |
| Mutação | 5 mutantes da 06B (crédito sem extrato como comprovado, canal presumido no agregado, transação sem pedido escondida, despesa a classificar na DRE, forma desconhecida presumida) e 2 da Fase A — todos pegos |

Cobertura dos 30 itens pedidos: saldo de referência (1), classificação pendente (2), recorrência estimada (3), venda por canal (4), agregada (5), com descontos (6), pagamento misto (7), cancelada (8), Stone sem pedido (9), processador sem canal (10), fração de centavo (11), iFood com componentes (12), recebível parcial (13), repasse agrupado (14), repasse sem crédito bancário (15), linha do tempo incompleta (16), divergência de valores (17), desconto sem financiador (18), sem duplicidade (19), consistência com a DRE (20) e com Contas a Receber (21), isolamento (22), sessão ausente (23), acesso negado (24), paginação e filtros (25), troca rápida de competência (26), resposta antiga (27), layout móvel (28), teclado (29) e ausência de dados reais versionados (30 — inclusive comparando, sem exibir, com os valores do documento privado quando ele existe na máquina).

## 11. Limitações e pendências

- **Fontes sem amostra real validada**: iFood (apuração/repasses), Anota AI, Stone **recebimentos** (repasses) e extrato OFX. Sem elas, "repasse informado" só existe por demonstrativo registrado e muitos créditos ficam "sem comprovação".
- **Setembro real não está conciliado**: nada real foi aplicado; esta área nunca declara conciliação sem evidência.
- Horário só existe para pedidos importados do SAIPOS; vendas manuais não guardam hora.
- Taxa sem relatório do processador aparece como etapa pendente "nenhuma taxa informada (pode não haver)".
- A comprovação "extrato bancário" reconhece movimentações do importador Unicred ou com documento de extrato; outros bancos entram quando houver leitor.
- Previsão de recorrência é suprimida por qualquer título do mesmo fornecedor e categoria no mês (pode subestimar).
- Consultas montam a visão do escopo em memória a cada chamada; para volumes reais, o próximo passo é filtrar por período já na leitura do repositório.
- Integração com autenticação/rotas reais continua bloqueada (doc 10); a demo segue somente leitura.
