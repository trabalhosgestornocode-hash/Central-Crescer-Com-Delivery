# Agente 2 — Especificação do motor financeiro (B1/B2)

Saneado: sem valores nem lançamentos reais (repo público). A homologação com a planilha real é local: `backend/scripts/financeiro-homologacao-local.mjs <xlsx> [esperado.json]`, com ambos fora do Git.

## Achados da auditoria da planilha (reproduzidos, não herdados)
- `FLUXO DE CAIXA` é a fonte única; UNICRED/STONE/CAIXA/IFOOD são visões filtradas (só o fluxo é importado).
- O livro-caixa tem 411 registros, todos com tipo/natureza/categoria/conta; nenhum com entrada e saída simultâneas.
- O vocabulário TIPO→NATUREZA mapeia 1:1 para os papéis abaixo; nenhuma combinação ficou sem papel.
- Transferências estão em **uma perna por linha** ("A → B" só na descrição): o par vinculado precisa ser inferido na importação e confirmado por pessoa; o que não parear fica como transferência externa pendente.
- Saldo anterior é tratado como abertura (`fin_saldos_abertura`), nunca como movimento do mês.
- Os saldos por conta calculados e os totais de referência do prompt foram reproduzidos ao centavo; CAIXA e IFOOD saem como **parciais** (abertura desconhecida).

## Papéis (metadado da categoria; o motor só conhece papéis)
`receita_operacional`, `custo_variavel`, `despesa_variavel`, `tributo`, `despesa_fixa`, `despesa_pessoal`, `despesa_financeira`, `financiamento`, `transferencia`, `saldo_anterior`. Sem papel = classificação pendente: fica fora dos indicadores, marca o resultado como parcial e aparece como diferença na ponte.

## Regras do motor (`backend/src/financeiro-calculos/`)
- Centavos inteiros; divisões em BigInt com half-away-from-zero; só o resultado final é arredondado.
- Só `status = realizado` entra no caixa. Valor ausente é `null`, nunca zero; divisão por zero e margem ≤ 0 → indicador indisponível (`null`).
- Margens são percentuais (bps), nunca moeda (corrige I-1).
- Ponto de equilíbrio = estrutura fixa × receita ÷ margem de contribuição (sem arredondar a % antes).
- `geracaoCaixaOperacional` é alias documentado de `resultadoGerencial` (I-14).
- Variação de caixa exclui saldo anterior; saldo final = variação + saldo anterior (I-2).
- Ponte resultado → caixa é verificada por teste e retorna `fecha`/`diferenca`.
- "Custos variáveis" = compras e fretes pagos; **não** é CMV consumido (I-9). Receita = recebimentos líquidos (I-8).
- Regime único nesta versão: caixa. Competência fica como campos opcionais futuros.

## Próximas etapas
B3 SQL provisório (fora de `database/migrations`, aguardando numeração ≥ 121) · B4 importação · B5 DRE/relatórios · B6 UI · B7 conciliação · B8 fechamento · B9 exportação.
