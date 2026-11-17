# 40 — Núcleo financeiro: 99Food, operadoras, taxas com vigência e líquido esperado (Fase 02)

> Documento público: **nenhuma taxa, valor ou transação real**. As taxas reais ficam só no cadastro de cada unidade.

## O que foi feito

### Canal 99Food
- Novo canal `NOVENTA_E_NOVE_FOOD` com categoria de receita própria `VENDA_NOVENTA_E_NOVE_FOOD` ("Vendas pela 99Food").
- A categoria é criada automaticamente na primeira venda, como as demais categorias do sistema.
- Os canais existentes não mudam. "Presencial" continua sendo o canal `BALCAO` (mudou só o rótulo nas configurações).

### Processadores novos
- `PAGBANK`.
- `MAQUININHA_IFOOD`: maquininha do iFood usada no balcão. É **operadora, não canal**; a venda continua no canal da origem (Presencial).
- `NOVENTA_E_NOVE_FOOD`: repasse do marketplace 99Food.

### Operadoras da unidade
- Rotas `/configuracoes/operadoras` (cadastro) e `/configuracoes/operadoras/situacao` (ativar, desativar, encerrar). Consulta em `/operadoras`.
- Campos: código, nome, processador, início, encerramento, modalidades (débito, crédito à vista, Pix, voucher) e observação.
- Nada é apagado. Toda mudança fica no histórico da operadora e no histórico da configuração da unidade.
- O cadastro é idempotente. Mesmo código com dados diferentes é recusado: para mudar, encerre ou desative a operadora existente.
- **Compatibilidade:** uma tabela de taxas sem cadastro (a tabela Stone do doc 35) vira uma operadora **implícita**, ativa e sem datas. Nada do que existia muda.

### Tabela de taxas por operadora
- Mesma rota de antes, agora com `operadora` (o campo `processador` segue aceito).
- Modalidades: `DEBITO`, `CREDITO_A_VISTA`, `PIX`, `VOUCHER`. Crédito é só à vista.
- Tarifa fixa opcional (4ª coluna, por exemplo `PIX;PIX;0,80;0,10`). Percentual zero só vale com tarifa fixa.
- Vigência sem sobreposição por operadora, e nada é sobrescrito.

### Pagamento da venda
- Novos campos opcionais:
  - `bandeira`: só em débito, crédito ou vale; normalizada ("Master" vira MASTERCARD);
  - `operadora`;
  - `descricaoOriginal`: o texto da fonte, para auditoria.
- Quem não usa esses campos tem o comportamento e a impressão de idempotência inalterados.

### Taxa estimada e líquido esperado
- Cada pagamento com processador adquirente grava `taxaEstimada` com:
  - situação, operadora, modalidade, bandeira;
  - bruto, taxa e líquido esperado;
  - **a versão da tabela usada** (operadora, vigência, percentual, tarifa).
- Usa a **tabela vigente na data da venda**, nunca a da importação. Uma tabela nova não recalcula vendas antigas.
- Cálculo da taxa: bruto × percentual, arredondado ao centavo meio-para-cima, mais a tarifa fixa. Líquido = bruto − taxa.
- Situações possíveis:
  - `CALCULADA`;
  - `TAXA_NAO_CONFIGURADA`;
  - `SEM_TABELA_VIGENTE`;
  - `SEM_OPERADORA`;
  - `OPERADORA_AMBIGUA`;
  - `OPERADORA_INATIVA_NA_DATA`;
  - `NAO_SE_APLICA` (dinheiro, marketplace).
- **Nunca há taxa zero presumida.**
- **A estimativa não entra na DRE.** Não é lançamento nem despesa. A tarifa da DRE continua sendo a **efetivamente cobrada** (doc 36).

### Operadora na data
- `operadoraNaData`, para fontes que não informam a operadora (a SAIPOS, na Fase 03):
  - uma única operadora ativa decide;
  - duas ou mais ativas (operadoras simultâneas) dão `OPERADORA_AMBIGUA` e vão para conferência;
  - nenhuma dá `SEM_OPERADORA`.

### Cards (consulta `/vendas/liquido-esperado`)
- Agrupa por modalidade e, dentro dela, por bandeira.
- Mostra bruto, taxa, líquido esperado e **percentual efetivo dos totais**, nunca a média simples dos percentuais.
- Mostra o bruto sem cálculo e a situação: `CALCULADO`, `PARCIAL`, `PENDENTE` ou `NAO_SE_APLICA`.
- Filtro opcional por canal.

### Banco
- Migração `0024_canais_e_operadoras.sql` só **amplia** as restrições CHECK de canal e processador. Não há coluna nova: os detalhes ficam em `extras`.
- Foi aplicada **somente** no PostgreSQL local isolado. O pacote `database/financeiro-v2/producao/` foi regenerado localmente e não foi aplicado.

## Pix da maquininha do iFood (D2)

| Item | Valor |
|---|---|
| Descrição SAIPOS | "Pago Online via Pix" (gravada em `descricaoOriginal`) |
| Canal | Presencial — SAIPOS (`BALCAO`) |
| Forma | Pix |
| Operadora | maquininha do iFood (`MAQUININHA_IFOOD`) |
| Taxa | a contratada da unidade, com vigência a confirmar |
| Não é | Stone, canal iFood, comissão do marketplace |
| "Pix na Entrega" | não herda essa taxa (operadora própria) |

Exemplo de cálculo com taxa sintética de 0,80%: bruto R$ 1.000,00, taxa R$ 8,00, líquido esperado R$ 992,00.

## Testes (`backend/test/financeiro-v2/operadoras-taxas.test.js`)
- Cálculo e arredondamento meio-para-cima, tarifa fixa e percentual efetivo dos totais.
- Taxa desconhecida nunca é zero, em todas as situações.
- Vigência pela data da venda; versão gravada.
- Stone encerrada seguida de PagBank, operadoras simultâneas viram ambiguidade, desativação com histórico, operadora inativa na data.
- Pix da maquininha do iFood na venda presencial; "Pix na Entrega" não herda a taxa; estimativa fora da DRE; canal iFood vazio.
- Bandeiras: só em débito, crédito ou vale; normalizadas; agrupadas no card.
- 99Food como canal próprio.
- Isolamento entre empresas e unidades.
- Sem duplicação (venda e tabelas repetidas).

## Pendências
- Cadastrar na unidade a operadora maquininha do iFood e a taxa Pix, quando houver autorização e a vigência for confirmada. Isso grava configuração em produção.
- D1: a correção da importação de 16/11 continua bloqueada; nada foi alterado.
- D3 (taxas reais da Stone e da PagBank) e D4 (relatórios oficiais do iFood e da 99Food).
