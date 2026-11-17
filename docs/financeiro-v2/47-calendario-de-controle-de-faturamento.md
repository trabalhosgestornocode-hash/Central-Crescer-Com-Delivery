# 47 — Fase 10: calendário de controle de faturamento dos canais

> Documento público: **nenhum valor, nome ou pedido real**. Tudo foi conferido com dados sintéticos (testes) e na demonstração
> local. Nada foi publicado, migrado, gravado em dados reais, nem teve permissão alterada.

## 1. O que foi construído
Um calendário mensal de acompanhamento diário, **um por canal**, no mesmo padrão visual e funcional:
**SAIPOS — Presencial**, **SAIPOS — Anota Aí**, **iFood** e **99Food**. Ele fica no topo da aba (Presencial e Anota Aí) ou da página
(iFood e 99Food). É a mesma arquitetura: nenhuma tabela nova, nenhum motor novo e nenhuma fonte de verdade nova.

### Estados do dia (um dia pode ter vários)
Cada estado tem **ícone, nome e descrição**. A cor só reforça: o botão do dia descreve tudo por extenso para leitor de tela.

| Ícone | Estado | Quando |
|---|---|---|
| ○ | Sem registro | Dia elegível sem nenhuma informação |
| ✎ | Faturamento provisório | Venda manual provisória ativa |
| ▤ | Fechamento manual registrado | Há fechamento de caixa (conferência) |
| ⇩ | Relatório importado | Venda de relatório SAIPOS, ou demonstrativo oficial do iFood cobrindo o dia |
| ◔ | Conferência pendente | Proposta aberta, taxa, operadora ou bandeira pendente, recebimento não confirmado, repasse pendente… |
| ⚠ | Divergência | Duas fontes discordam (fechamento × vendas, recebido × esperado, receita iFood fora do demonstrativo…) |
| ✓ | Conciliado | Recebido confirmado igual ao esperado, sem pendência |
| ⊘ | Sem movimento confirmado | Dia marcado "sem operação" (com justificativa) **ou** relatório importado que cobre o dia sem venda do canal |

### Regras de cobrança
- **Elegível** = antes de hoje, depois do início do controle e não marcado sem operação.
  O início é o dia seguinte ao corte da abertura da unidade; sem abertura, é o primeiro dia do mês corrente.
- **Hoje e dias futuros nunca são atrasados.** Dias antes do início do controle também não.
- **Dias sem operação** são configuráveis por data e por dia da semana, **por canal**, com justificativa e histórico. Nada presume que a
  empresa abre todos os dias. Um dia com registro nunca é escondido: o registro prevalece e a marcação é recusada.

### Resumo mensal (seis indicadores, todos calculados no servidor)
Dias com informação · Faturamento confirmado · Dados provisórios · Com pendências · Com divergências · Sem registro (mais dias cobrados,
sem operação e futuros).

### Painel do dia
Canal, data, estados, origem da informação, valores disponíveis (bruto, taxa estimada, líquido esperado, recebido, sem taxa), situação da
conferência, importações que cobrem o dia (com link para a prévia e o documento), pendências, divergências e **só as ações que o perfil
tem**: ver vendas e pagamentos do dia, abrir importações, ver ou registrar fechamento, registrar faturamento provisório, abrir
conferências, marcar ou desmarcar dia sem operação. As ações abrem as telas que já existem, com o período do dia.

### Por canal
- **Presencial e Anota Aí:** mesma fonte dos cards (pagamentos com taxa estimada gravada). Cada calendário mostra só os registros do seu
  canal; uma importação alimenta os dois. No Anota Aí o fechamento só conta se o caixa informou valor do Anota Aí.
- **iFood:** só o demonstrativo oficial. Ele cobre um **período** e nunca é repartido por dia: o dia coberto aparece como "relatório
  importado", **sem valor diário**, com o aviso "o detalhamento diário depende do relatório oficial de pedidos". Os valores aparecem
  rotulados como do **período**. Repasse previsto, parcial, atrasado ou recebido vira pendência ou conciliação. Receita iFood vinda de
  outra origem vira divergência. Pedidos iFood só na SAIPOS aparecem como contagem de conferência, nunca como faturamento.
- **99Food:** sem relatório oficial, todo dia elegível fica "sem registro", com a frase "não é zero confirmado". Nenhum formato foi presumido.

## 2. Arquitetura
- **Uma consulta mensal consolidada por canal** (`GET /calendario-faturamento?canal&mes`), nunca uma por dia. Escolher um dia, navegar
  pelo teclado e abrir o painel **não consultam o servidor**. Mudar de mês faz uma consulta.
- **Backend calcula tudo.** Totais, contagens, estados e permissões vêm prontos; o frontend só apresenta (teste proíbe `reduce(` e somas de
  `…Centavos`).
- **Reuso, sem segunda fonte de verdade:** `itensDoLiquidoEsperado` (extraído de `vendas.js`, os mesmos itens dos cards),
  `diasDeFechamento` (extraído de `fechamentoManual.js`) e `demonstrativosDoIfood` (extraído de `canalPlataforma.js`). As consultas
  antigas passam a usar as mesmas funções.
- **Escrita única:** `POST /acoes/calendario-faturamento/sem-operacao` (permissão `configurar`, justificativa obrigatória, histórico da
  configuração da unidade). Fica na configuração da unidade, no mesmo registro de operadoras e taxas. **Sem migração.**
- **Isolamento e permissões:** a consulta exige `ver`; o escopo vem da sessão. As ações do painel vêm do servidor conforme o perfil.

## 3. Arquivos
**Novos:** `backend/src/modules/financeiro-v2/aplicacao/calendarioFaturamento.js`,
`backend/test/financeiro-v2/calendario-faturamento.test.js`, `frontend/financeiro-v2/telasCalendarioCanais.js`,
`frontend/test/financeiroV2CalendarioCanais.test.js`, este documento.

**Alterados:** `aplicacao/vendas.js`, `aplicacao/fechamentoManual.js` e `aplicacao/canalPlataforma.js` (extração de funções, sem mudar
comportamento), `aplicacao/nucleo.js`, `fv2-integracao/consultas.js`, `fv2-integracao/escritas.js`, `scripts/fv2/demoInterface.mjs`
(rota e um demonstrativo iFood fictício), `scripts/fv2/navegadorCanais.mjs` (15 verificações novas), `frontend/financeiro-v2/app.js`,
`telasCanais.js` e `fv2.css`.

## 4. Testes
### Resultados (17/11/2026, todos terminaram)
| Suíte | Total | Aprovados | Falhas | Ignorados |
|---|---|---|---|---|
| Backend em memória | 503 | 503 | 0 | 0 |
| Backend no PostgreSQL local (banco exigido) | 503 | 503 | 0 | 0 |
| Frontend | 2009 | 1983 | 0 | 26 (navegador de outros módulos) |
| Navegador (Chrome real, demonstração local) | 65 | 65 | 0 | 0 |

Houve duas falhas intermediárias no frontend, ambas minhas e já corrigidas: o demonstrativo iFood fictício que acrescentei à demonstração
quebrava dois testes de contas a receber (agora só existe com `FV2_DEMO_IFOOD_DEMONSTRATIVO=1`, usado pelo roteiro de navegador) e uma
reescrita do tratamento do Esc que quebrava um teste de acessibilidade (restaurada a linha original).

Cobertura pedida (17 itens):
1. sem registro · 2. com importação · 3. com fechamento manual · 4. com provisório · 5. com divergência · 6. conciliado · 7. vários caixas no mesmo
dia · 8. relatórios que cobrem vários dias · 9. iFood sem granularidade diária · 10. 99Food sem dados oficiais · 11. meses diferentes ·
12. datas futuras · 13. dias sem operação · 14. permissões e isolamento · 15. responsividade · 16. teclado · 17. nenhum cálculo monetário no frontend.
Backend: 14 testes (memória e PostgreSQL). Frontend: 14 testes. Navegador: 15 verificações do calendário, no desktop (1366 px) e no celular (390 px).

## 5. Defeitos achados no caminho
- O demonstrativo iFood precisa de justificativa (só um ajuste de teste).
- Um dia com **pendência sem registro** (pedido iFood só na SAIPOS) não recebia "sem registro": agora recebe, e a pendência fica ao lado.
- As duas falhas intermediárias de frontend descritas acima.
- O título do mês ficava "Novembro De 2026" por causa do CSS: corrigido.

## 6. Pendências e riscos
- **Sem fonte diária no iFood e na 99Food:** enquanto não existirem os relatórios oficiais de pedidos (D4), o calendário mostra cobertura de
  período, não faturamento diário. É por regra, não por falha.
- **Início do controle sem abertura:** usa o mês corrente. Unidades sem abertura configurada não cobram meses antigos (de propósito).
- **"Sem movimento confirmado" pelo relatório:** vale para quem importou relatório que cobre o dia. Se o relatório estiver incompleto, o dia
  parece confirmado sem estar. A prévia da importação continua sendo a proteção.
- **Divergência × pendência:** divergência é duas fontes discordando; recebimento ainda não confirmado é pendência. Quase todo dia recente
  fica "pendente" até o extrato conciliar: é o comportamento esperado.
- Login real da plataforma não coberto pelo navegador (só a demonstração).

## 7. Impacto no plano de publicação
- **Nenhuma migração nova.** `atualizar.sql` não mudou; o pacote continua conferido.
- **Código:** uma rota de consulta nova e uma ação de escrita nova (só quem tem `configurar`). Nada é habilitado por padrão além do que a
  unidade já tem.
- Acrescentar ao checklist de leitura pós-publicação (doc 46 §4.5): abrir o calendário dos quatro canais em um mês passado e no mês corrente.
- Reversão: reverter o código. O registro `diasSemOperacao` na configuração é ignorado pelo código anterior e não bloqueia nada.

## 8. Classificação final da Fase 10
**GO CONDICIONAL.** O calendário está implementado nos quatro canais, validado por teste automatizado e no navegador, sem migração, sem
escrita financeira habilitada e sem alterar permissões. A homologação anterior (docs 45 e 46) **não** foi usada como prova destas
funcionalidades: elas têm testes próprios. As condições são as mesmas da publicação (D1, D3, D4, autorização) mais uma conferência em
leitura com o login real da plataforma.
