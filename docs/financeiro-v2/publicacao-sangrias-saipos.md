# Importador de sangrias da SAIPOS — revisão final e plano de publicação

Branch `feat/fv2-saipos-sangrias`. **Ferramenta de conferência**: nada aqui cria movimentação financeira, venda, recebível, lançamento
ou altera a DRE. Sem migration. Sem alteração de permissões.

## O que é

Formato novo `SAIPOS_MOVIMENTOS_CAIXA` (XLSX do "Financeiro" da SAIPOS), recebido pelo **mesmo importador** das demais fontes (prévia,
duplicidade, confirmação, histórico, auditoria). Reconhece sangria (retirada), reforço e transferência; o resto fica pendente.

- Onde achar o relatório na SAIPOS (dica na própria tela): Lançamentos financeiros, categoria Frente de Caixa, descrição Retirada
  (para reforços, descrição Reforço). Exportar em XLSX.
- Conferência do dinheiro do dia no Fechamento manual: abertura + vendas em dinheiro + reforços − sangrias − transferências = esperado;
  informado; diferença.
- Calendário SAIPOS (Presencial): o dia abre retiradas, total, reforços, pendência de associação ao caixa, divergências e a lista.

## Revisão: problemas encontrados e corrigidos

| # | Gravidade | Problema | Correção |
|---|-----------|----------|----------|
| 1 | Alta | O calendário tratava o relatório de caixa como "evidência de dia sem venda" e marcava **todos** os dias do período como "sem movimento confirmado", escondendo a falta do relatório de vendas. | Só relatório de vendas é evidência. Teste de regressão. |
| 2 | Alta | Arquivo **corrigido** do mesmo período somava por cima (R$ 40 corrigido para R$ 45 dava R$ 285 em vez de R$ 245). | A prévia mostra a contradição por dia; confirmar exige aceite explícito + justificativa; só então as linhas anteriores ausentes ficam SUBSTITUÍDAS (preservadas no histórico, fora dos totais). Acréscimos e arquivos de outra natureza (retiradas × reforços) não substituem nada. |
| 3 | Média | Transferência abatia o dinheiro esperado sem saber o sentido (entra ou sai do caixa). | Fica "a confirmar", visível e **fora da conta**. |
| 4 | Baixa | Comentário e testes citavam valores reais de uma loja (repositório público). | Trocados por valores inventados; histórico local reescrito antes de qualquer push. |

Pontos auditados sem problema: leitura do XLSX (colunas, datas, decimais, negativos); sinais (retirada negativa e reforço positivo viram
pendência); movimento desconhecido (fora dos totais, original preservado); "Pago = Não" (fora dos totais); reenvio do mesmo arquivo
(mesma importação); linhas idênticas no mesmo arquivo (continuam duas); período sobreposto (reconhece o já importado); histórico;
permissões (importar ≠ confirmar; ver ≠ importar); isolamento entre empresas **e entre unidades da mesma empresa**; invariantes
(sangria não reduz faturamento nem cria despesa; reforço não cria receita; DRE, vendas, recebíveis, lançamentos e movimentações intactos).

## Testes executados

| Suíte | Resultado | Ignorados |
|-------|-----------|-----------|
| Backend em memória (`test/financeiro-v2`), sobre a `main` atual `eb40f00` (já com a otimização de propostas) | 554 passam, 0 falham | 0 |
| Backend no PostgreSQL local isolado | 554 passam, 0 falham | 0 |
| Frontend (`financeiroV2*`) | 122 passam, 0 falham | 0 |
| Navegador (Chrome, demonstração local) | 11 de 11 | — |

Isolamento e segurança já estão dentro da suíte do backend (`isolamento-autorizacao`, `isolamento-estatico`, `postgres-seguranca`,
`postgres-barreiras-08c`, `acessos-sessao`) e nos testes novos de `movimentos-caixa-saipos` (outra unidade da mesma empresa, outra
empresa, importar ≠ confirmar, ver ≠ importar, correção em uma unidade não afeta a outra).

## Compatibilidade com a main e com outras branches

- `origin/main` = `eb40f00` (PR #122, otimização da aplicação de propostas, mesclado **durante** esta revisão). A branch foi refeita sobre
  ela: 0 commits atrás, 1 à frente. Os testes abaixo rodam sobre essa base.
- **Rota de estorno**: `feat/fv2-estorno-pagamento-venda` já está na main (PR #120). Nada a fazer.
- **Otimização da aplicação de propostas** (`perf/fv2-aplicar-propostas`): já está na main. Esta branch **não toca** `formacao.js`,
  `benchLote.mjs` nem o doc 51; as duas mexem em `escritas.js`, em linhas diferentes (aplicou limpo, sem conflito).
- Nenhuma implementação de outra branch foi alterada.

## Riscos

| Risco | Nível | Mitigação |
|-------|-------|-----------|
| A convenção de sinais (positivo = entra no cofre) foi **inferida** de dois arquivos reais, não confirmada pela SAIPOS. | Médio | Só reconhece com descrição + conta Cofre + categoria + sinal coerentes; sinal contrário vira pendência. Conferir o primeiro arquivo real com o usuário. |
| Aceitar uma "correção" que na verdade era só outro recorte substitui linhas válidas. | Médio | Mensagem explícita, justificativa obrigatória, nada é apagado (linhas ficam SUBSTITUÍDAS no histórico, com a importação que as substituiu). |
| Não existe "desfazer importação" depois de confirmada (só correção por arquivo). | Baixo | Os registros são inertes (sem efeito financeiro); a correção por arquivo cobre o erro de conteúdo. |
| Identidade por impressão digital + nº de ocorrência: reordenar linhas **idênticas** muda as ocorrências. | Baixo | Documentado no motor; só afeta linhas idênticas (mesmo dia, valor e descrição). |
| "Possível duplicidade" pode ser coincidência de valores. | Baixo | É só alerta para revisão; o valor é usado uma vez. |
| Todo dia com movimento mostra "caixa não identificado". | Baixo (esperado) | O export não traz caixa; não escala o estado do dia. |
| Um dia só com movimentos passa a aparecer na lista do Fechamento manual. | Baixo | Intencional (permite conferir o dinheiro do dia). |

## Plano de publicação (nenhum passo foi executado)

Pré-requisitos: autorização específica do usuário para cada passo marcado com (A).

1. Revisão de código do PR (diff de 23 arquivos; sem migration, sem `.env`, sem arquivo real).
2. (A) `git push` da branch e abertura do PR. Render: previews de PR estão **desligados**; conferir com `get_service` antes.
3. (A) Merge na `main` (merge commit). O Render faz deploy automático porque `backend/` mudou (frontend é servido pelo backend).
4. Pós-deploy: `/health` 200; abrir SAIPOS › Importações e ver o formato com a dica.
5. (A) Importar o arquivo real **com o usuário presente**, em modo conferência: conferir quantidade, total, dias e classificação na
   prévia; confirmar; ver a DRE (Visão Geral) **idêntica** ao antes; ver o dia no calendário e a conferência no Fechamento manual.
6. Observar uma semana: nenhuma divergência inesperada; nenhum dia marcado indevidamente; usuário confirma que a convenção de sinais bate.

## Checklist

- [ ] PR revisado por uma pessoa.
- [ ] `/health` 200 após o deploy.
- [ ] Formato aparece em SAIPOS › Importações com a dica.
- [ ] Primeiro arquivo real: prévia confere com o relatório da SAIPOS (quantidade, total, dias).
- [ ] DRE, faturamento e recebíveis idênticos antes e depois.
- [ ] Dia com retirada no calendário mostra quantidade, total, pendência de caixa e lista.
- [ ] Dia sem venda importada **não** aparece como "sem movimento confirmado".
- [ ] Fechamento manual: igual ao digitado vira "possível duplicidade"; diferente pede revisão.
- [ ] Nenhuma permissão alterada; nenhuma migration aplicada.

## Reversão

Sem migration: reverter o merge restaura o comportamento anterior. Registros já importados ficam no banco, inertes, sem efeito
financeiro. Para corrigir conteúdo, enviar o arquivo corrigido (substituição por aceite explícito).

## Rascunho do PR

> **Importador de sangrias da SAIPOS (conferência).** Importa sangrias e reforços do relatório "Financeiro" pela arquitetura de
> importações existente, sem criar movimentação, venda, recebível ou lançamento e sem alterar a DRE. Mostra o dinheiro do dia no
> Fechamento manual (importado = digitado vira "possível duplicidade", contado uma vez) e as retiradas no calendário. Inclui a dica de
> onde achar o relatório na SAIPOS. Revisão final corrigiu: relatório de caixa contando como "dia sem venda", arquivo corrigido somando
> por cima e transferência abatendo o caixa sem sentido conhecido. Sem migration. Testes: backend 554 em memória e 554 passam, 0 falham no PostgreSQL local,
> frontend 122, navegador 11/11.
