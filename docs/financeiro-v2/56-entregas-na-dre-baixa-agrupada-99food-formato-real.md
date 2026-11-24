# 56 — Quantidade de entregas na DRE, baixa agrupada pelo extrato e 99Food no formato real

Data: 23/11/2026 · Base: `main` em `462a6d4` · Sem migração · Nenhuma gravação em produção.

## 1. Quantidade de entregas nas linhas de entrega da DRE

**O que muda na tela.** Na composição da DRE, as linhas **Entregadores Próprios (Motoboys)**, **Entregas terceirizadas** e
**Entrega Sob Demanda (iFood)** mostram a quantidade de entregas da competência entre o nome e o valor/percentual. Valores,
percentuais, setas e detalhamentos continuam os mesmos.

**Nenhum cálculo financeiro muda.** A quantidade vem de uma consulta à parte (`quantidadesDeEntregas`), anexada à rota `/dre`.
Se ela falhar, a DRE abre igual, só sem a quantidade. A impressão da apuração depende só das entradas e não muda.

| Linha | Fonte oficial | Regra |
|---|---|---|
| Entregadores Próprios | parser Foody (mesma porta da área Entregadores Próprios) | itens `ENTREGA` elegíveis e com entregador. Cancelado só conta quando o parser o manteve com direito à taxa. Lançamentos manuais, taxas adicionais, ajustes e PIX não contam. Repetidos (mesmo id) contam uma vez. |
| Entrega Sob Demanda | Conciliação Financeira do iFood | pedidos **distintos** com cobrança líquida de entrega sob demanda na competência. Uma cobrança estornada por inteiro não conta. |
| Entregas terceirizadas | — | não há fonte oficial integrada com a quantidade. A linha diz “quantidade sem fonte”, nunca zero. |

O que a tela mostra em cada situação:

- **N entregas**: há dados (N pode ser 0).
- **(provisório)**: dia em aberto, em triagem ou em revisão.
- **sem dados de entregas**: a fonte existe, mas nada foi importado na competência.
- **quantidade sem fonte**: não existe fonte oficial integrada.
- **quantidade indisponível**: a fonte não respondeu.

**Apresentação.** As cobranças diárias de sob demanda (lançamentos `ifood-conciliacao:<dia>:ENTREGA_SOB_DEMANDA:v<n>`) passam
a ficar num nó próprio, **Entrega Sob Demanda (iFood)**, dentro de *Comissões de plataformas de venda*. A soma e as categorias
continuam as mesmas (`GRUPOS_DE_APRESENTACAO`, em `dominio/apuracao.js`).

A melhoria vale para todas as unidades: a regra não depende da unidade, e cada unidade só enxerga os próprios dados.

## 2. Baixa agrupada: várias contas pagas por uma só saída do extrato

**O modelo já tinha o relacionamento.** Uma saída pode quitar várias contas (várias `LIQUIDACAO` com a mesma
`movimentacaoId`), e `baixarSaidaNaTransacao` já aceitava `alocacoes[]`. Não há tabela, coluna nem migração novas. O que entrou:

- `previaDaBaixaAgrupada` traz as contas, a soma, as saídas elegíveis e, para a saída escolhida, a diferença, os bloqueios e o efeito. **Nenhuma saída vem pré-selecionada**: a que tem o mesmo valor da soma só ganha uma marca.
- `vincularPagamentoAgrupado` grava a baixa de 2 a 50 contas, com o **saldo** de cada uma, numa só transação e pela mesma função da baixa individual. Valem as mesmas travas (saída e contas), versão, idempotência, escopo, permissão `vincular_pagamento`, evidência do extrato e competência aberta. É **tudo ou nada**: se uma conta estiver cancelada ou quitada, o grupo inteiro é recusado.
- `consultarPagamentoAgrupado` mostra a composição do pagamento: as contas quitadas por aquela saída.
- `reverterPagamentoAgrupado` estorna **todas** as liquidações da saída numa só transação, cada uma com o próprio estorno auditado. Exige as permissões `cancelar` e `vincular_pagamento`, a versão da saída, confirmação e motivo com pelo menos 10 caracteres. As contas voltam a ficar em aberto, e nada é apagado.
- Nenhuma despesa nova e nenhuma saída nova. Se a soma for **menor** que a saída, a sobra continua como saída a classificar. Se for **maior**, a baixa é bloqueada. Nada é lançado para fechar a diferença.

**Correção encontrada no caminho.** A chave de idempotência da baixa crescia com o número de contas e passava do limite de
400 caracteres do banco a partir de cerca de 7 contas. O banco recusava com “regra de integridade”, e isso também valia para a
baixa individual com várias alocações. Agora as listas curtas mantêm o formato de sempre, então as chaves já gravadas não
mudam, e as longas usam `sha256` da lista.

**Interface.**

- Contas a Pagar e o dia do Calendário ganham uma caixa de seleção nas contas em aberto. A barra mostra a quantidade selecionada e o botão **Baixar juntas pelo extrato**. Pela regra de arquitetura, a soma não é calculada na tela: ela aparece na prévia, vinda do servidor.
- A prévia mostra as contas, a soma, a escolha da saída, a diferença com selo (iguais, sobra ou soma maior), os bloqueios, o efeito e a confirmação.
- **Pagamento agrupado** mostra a composição, com link para cada conta, e o formulário de reversão.
- No Calendário, os pagamentos do dia vêm agrupados pela saída (`pagamentosAgrupados`, calculado no servidor): um pagamento único com várias contas aparece uma vez e expande para mostrar cada conta.
- Na ficha da conta, o pagamento agrupado ganha o link **Ver o pagamento**.

Rotas novas: `GET /baixa-agrupada`, `GET /pagamento-agrupado`, `POST /acoes/obrigacoes/vincular-extrato-agrupado` e
`POST /acoes/obrigacoes/reverter-baixa-agrupada`.

## 3. 99Food: relatório “Dados da loja” no formato real

O importador já existia (PR #136). O arquivo real recusava parte das linhas porque a exportação **pt-BR apaga os zeros à
direita**: `8.136` quer dizer R$ 8.136,00 e `8.847,5` quer dizer R$ 8.847,50. O leitor genérico trata `8.136` como ambíguo, e
está certo em fazer isso.

**Regra nova, restrita ao adaptador da 99Food.** `d.ddd` sem vírgula só é lido como milhar quando a **própria linha** prova a
convenção brasileira, isto é, quando alguma coluna de valor tem vírgula decimal. Sem essa prova, continua recusado. A conferência
quantidade × valor médio, que já existia, pega qualquer leitura errada por um fator de 1.000. Os identificadores continuam como
texto e os valores, em centavos inteiros.

O resto já estava pronto e foi conferido com o arquivo real num núcleo isolado:

- só vendas de itens, comissões, taxas e marketing entram na DRE;
- recompensas e receita de ofertas ficam guardadas e visíveis, mas não viram receita;
- o repasse informado não vira recebível nem crédito;
- reimportar o mesmo arquivo é reconhecido como repetição;
- uma versão corrigida segue a substituição completa já existente.

**Novo na Central de Conferências.** A diferença não explicada entre o resultado preliminar e o repasse informado aparece **por
dia**, com o código `REPASSE_99FOOD_DIFERENCA_DIA`. É uma pendência informativa que não bloqueia o fechamento e não gera
lançamento.

## 4. Testes

- `baixa-agrupada.test.js` (5 testes): prévia, atomicidade, idempotência, dupla baixa, tudo ou nada, isolamento, permissões e reversão. Passa em memória e no PostgreSQL isolado.
- `quantidade-entregas-dre.test.js` (5 testes): regras de contagem, diferença entre zero, sem dados e sem fonte, isolamento e nó de apresentação.
- `relatorio-99food.test.js` (+1 teste e +1 verificação): formato pt-BR sem zeros à direita e pendência por dia na Central.
- `scripts/fv2/verTresMelhorias.mjs`: página local de verificação visual com dados sintéticos. Não é rota do aplicativo.
