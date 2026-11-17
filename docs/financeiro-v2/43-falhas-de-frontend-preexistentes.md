# 43 — Duas falhas de testes de frontend que já existiam na main (diagnóstico)

> **Situação em 17/11/2026 (Fase 09): RESOLVIDO.** O commit `f625a69` atualizou o texto esperado no teste 08E
> ("Como esta conta foi paga?") e passou o total em aberto do dia a vir do servidor (sem soma na tela). Na suíte completa do
> frontend desta branch os dois testes passam (0 falhas). O texto abaixo fica como registro do diagnóstico original.

> Registradas à parte para não serem confundidas com regressões das Fases 02–06. Elas falham na `main` (232d56a) sem
> nenhuma mudança desta branch. **Não foram corrigidas aqui**: a correção pede decisão sobre o texto e a regra da tela.

## 1. `financeiroV2BaixaFechamento` — "08E — conta a pagar: explica registrar × vincular…"

- **Sintoma:** o teste procura o texto `Como dar baixa nesta conta` no painel da conta a pagar.
- **Causa:** o commit `85f3fa7` (16/11/2026, "baixa de conta a pagar com escolha visual") redesenhou o painel. O título passou a ser **"Como esta conta foi paga?"**, com três escolhas: "Já saiu no extrato", "Paguei pelo banco" e "Paguei em dinheiro".
  - O teste não foi atualizado junto.
- **Natureza:** expectativa desatualizada no teste. O comportamento coberto (vincular a saída do extrato sem criar outra; repetir não duplica) continua existindo.
- **Correção sugerida:** atualizar o texto esperado no teste e conferir de novo as asserções seguintes do mesmo teste.

## 2. `financeiroV2Tesouraria` — "27 — responsivo e acessível…"

- **Sintoma:** falha na asserção `tela recalculando valores`.
  - A regra é: nenhuma fórmula financeira no frontend (proibidos `reduce(` e somas de `…Centavos`).
- **Causa:** o mesmo commit `85f3fa7` acrescentou ao dia do calendário, em `telasTesouraria.js`, a soma do saldo em aberto no navegador:
  - `emAberto.reduce((s, t) => s + t.saldoCentavos, 0)`.
- **Natureza:** violação real da regra de arquitetura, porque o total precisa vir do servidor. Não é um defeito de valor: a soma está certa.
- **Correção sugerida:** a consulta do calendário deve devolver o total em aberto do dia, e a tela só exibe.

## Cuidado registrado nesta branch

- O teste 27 pega o **último** bloco `@media (max-width: 760px)` do CSS. O CSS das telas novas fica antes da seção "celular", para não deslocar o bloco que o teste confere.
- As telas novas não somam dinheiro: os totais e o líquido de cada pagamento vêm do servidor, e o teste `financeiroV2Canais` garante isso.
