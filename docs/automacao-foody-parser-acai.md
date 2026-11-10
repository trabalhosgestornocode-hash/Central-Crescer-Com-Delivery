# Automação Foody → Parser e Açaí no Grau — diagnóstico, correção e implantação

**Data:** 10/11/2026 · **Branch:** `feat/parser-consome-foody-automatico` · **Situação:** implementado e testado localmente; leitura real comprovada; **nada publicado**.

## 1. Diagnóstico com evidência (produção, somente leitura)

| Componente | Desenvolvido | Executando? | Fonte | Última execução | Recebidos / persistidos | Aparece no frontend? | Impedimento |
|---|---|---|---|---|---|---|---|
| Agendador Foody (worker embutido) | Sim (147–150) | **Sim**, 105 execuções agendadas desde 05/11, 0 erros | API Foody 1.2, só GET | 10/11 13:26Z (ciclo D-1..D-3) | 1.154 pedidos em `foody_pedidos` (31/10–09/11); 124/163/133 recebidos em 09, 08 e 07/11, todos inalterados na repetição (idempotente) | Não no Parser | — |
| Fechamentos logísticos | Sim | Sim | `foody_pedidos` | 10/11 04:32Z | 28 versões; Subway e Açaí por dia | Só nos blocos com flag | 5 dias PRELIMINAR por `TRIAGEM_PENDENTE` (2–6 pedidos/dia) |
| Distribuição Subway → Açaí | Sim (148) | Sim | Conexão compartilhada | — | 258 pedidos do Açaí na unidade Açaí | Não | — |
| **Parser Food Delivery** | Sim | Sim, mas **só lê planilhas** | `parser_fd_pedidos` ⨝ `parser_fd_importacoes` | Subway: importação manual 10/11 18:01Z | Subway: 79 importações; **Açaí: 0** | Subway sim; **Açaí vazio** | **Causa raiz:** `analisarPeriodo` nunca lia `foody_pedidos`. A ponte existente (`parserFoodDelivery.foody.js`) só adiciona um bloco informativo e declara "nunca altera pedidos" |
| Açaí — iFood | Integração existe para outras lojas | **Não para o Açaí** | — | — | 0 conexões, 0 vínculos de loja, 0 pedidos, 0 eventos | — | **Loja iFood do Açaí não conectada** (autenticação humana) |
| Açaí — SAIPOS / Anota AI | Só importação de arquivo | — | Planilhas | — | `vendas`/`importacoes_vendas`: 0; `fin_vendas_canal`: 3 | — | Não há cliente de API no projeto; nenhuma credencial ou documentação de API autorizada |
| Resumo Diário Operacional | Sim | Sim (informado pelo proprietário) | — | — | — | — | **Intocado** por esta mudança |

Webhook Foody: não existe no projeto e não foi validado na documentação oficial; a coleta é por polling a cada 6 h, cobrindo D-1 a D-3 (reprocesso) e reconciliação de 35 dias.

## 2. Correção

`backend/src/modules/parser-food-delivery/parserFoodDelivery.foodyPedidos.js` (novo) + `analisarPeriodo` em `parserFoodDelivery.service.js`:

- **Somente leitura.** Não cria importação sintética nem copia pedidos. Lê `parser_fd_importacoes`, `foody_conexao_destinos` e `foody_pedidos`.
- **Uma fonte por dia.** Dia coberto pelo período de qualquer planilha concluída usa **só a planilha**. A Foody preenche os demais dias. Não há duplicidade.
- **Operação própria.** Unidade destino ATIVA de uma conexão compartilhada (Açaí) concilia os próprios pedidos; as demais unidades continuam Subway.
- **Campos ausentes = null.** Chegada para entrega, distância e origem não vêm da API e nunca viram zero.
- **Isolamento.** Filtro por organização e unidade em todas as consultas, conferido linha a linha (`FONTE_FOODY_TENANT_DIVERGENTE`).
- **Falha não derruba o Parser.** O retorno `fonteFoodyPedidos.erro` informa a falha, e a planilha segue funcionando.
- **Flag fail-closed:** `FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED=true` + `FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES` (uuid, vírgula). Desligada, a resposta fica idêntica.
- **Frontend:** a distribuição usa os rótulos da operação própria e a fonte aparece como "Foody Delivery — sincronização automática".

## 3. Matriz campo a campo (API Foody × Parser)

| Campo do Parser | Fonte | Via API? | Transformação | Destino | Status |
|---|---|---|---|---|---|
| Nº do pedido | `id` | Sim | texto | `numeroPedido` | OK |
| Data e hora | `date` | Sim | parede -03:00 → `...Z` (convenção do Parser) | `dataHora` | OK |
| Situação | `status` | Sim | `closed/cancelled/delivered/ready` → vocabulário do relatório | `situacao` | OK |
| Entregador | `courier.courierName` | Sim | **hash** na sincronização → rótulo "Entregador Foody xxxxxx" | `entregador` | Parcial: o nome não é armazenado |
| Taxa do entregador | `courierFee` | Sim | número; só conta com entregador | `taxaEntregador` | OK |
| Valor total | `orderTotal` | Sim | número | `valorTotalPedido` | OK |
| Forma de pagamento | `paymentMethod` | Sim | catálogo | `formaPagamento` | OK |
| Detalhes / operação | `orderDetails` | Sim | catálogo de operação + triagem | `operacao` | OK (triagem → revisão) |
| Aceito, pronto, despacho, coleta, entrega, finalizado, cancelado, prazo | campos de data (5 não documentados) | Sim | parede | timeline | OK |
| Razão / justificativa de cancelamento | `cancellationReason/Text` | Sim | código → texto (2 códigos vistos) | cancelamento | OK com catálogo |
| Chegada para entrega | — | **Não** | null | `dataChegadaEntrega` | Lacuna: o motor usa a regra de coleta, com a mesma decisão |
| Distância (raio/rota) | — | **Não** | null | distância | Lacuna: continua só pela planilha |
| Origem/canal | — | **Não** | `foody_api` | `origem` | Lacuna: só proveniência |

## 4. Prova com dados reais (leitura em produção, flag ligada só no processo local)

| Unidade | Período | Fonte | Pedidos | Elegíveis | Entregues | Cancelados (recebem) | Taxas válidas | Entregadores |
|---|---|---|---|---|---|---|---|---|
| Açaí no Grau | 31/10–10/11 | Foody (10 dias, 0 com planilha) | 258 | 240 | 239 | 1 (1) | **R$ 2.161,00** | 7 |
| Subway | 01–10/11 | Planilha nos 9 dias; Foody 0 | 1.014 | 517 | 514 | 3 (3) | R$ 4.793,00 | 8 |

Reconciliação independente: a soma das taxas válidas dos 10 fechamentos logísticos do Açaí (144+149+249+192+212+173+211+271+333+227) é **R$ 2.161,00**, igual ao Parser. A Subway prova que não houve duplicidade, porque todos os dias com planilha ficaram fora da Foody.

## 5. Sem perda silenciosa, isolamento e outras unidades

- **Planilha parcial.** Nos dias com planilha, os pedidos Foody da operação própria (e os em triagem) são contados e comparados com a planilha. Fora da faixa `[Foody − 2, Foody + triagem + 2]`, o Parser mostra um alerta (`PLANILHA_POSSIVELMENTE_PARCIAL` ou `FOODY_COM_MENOS_PEDIDOS`). A fonte **não muda sozinha**, porque trocar a fonte é decisão de metodologia. Dado real: em 09/11 a Subway tinha 95 pedidos na planilha × 89 na Foody + 6 em triagem → dentro da faixa e sem alerta. Em 31/10–10/11, nenhum alerta nas duas unidades.
- **Isolamento.** `organizacaoId` vem da sessão (`tenant(req)`). `resolverUnidade` exige que a unidade pertença à organização **antes** da ponte. A ponte filtra por organização + unidade em todas as consultas e confere cada linha (`FONTE_FOODY_TENANT_DIVERGENTE`). As linhas do Açaí ficam na organização do Açaí, e um usuário da Subway não as alcança.
- **Outras unidades.** Leitura real com a allowlist contendo **só o Açaí**: a resposta da Subway ficou **idêntica byte a byte** à resposta com a flag desligada (1,69 MB, sem bloco Foody). Açaí em 01–10/11: 241 pedidos e R$ 2.017,00 (= R$ 2.161,00 − R$ 144,00 de 31/10).

## 6. Monitoramento e triagem (tela Integrações › Foody)

- **Saúde da sincronização**, calculada das execuções gravadas: Atualizado / Atrasado (sem sucesso há mais de 7 h) / Com erro (falha depois do último sucesso) / Sem dados na origem / Sincronizando / Conectado — nenhuma execução / Coleta desligada / Conexão inativa / Sem conexão. Credencial válida sozinha **nunca** aparece como "Atualizado".
- A tela mostra: última execução, último sucesso, atraso, pedidos capturados e persistidos do último sucesso, pendências e falhas. "Sincronizar agora" e o histórico já existiam.
- **Triagem** (já existia: dias, pedidos, itens não reconhecidos, decisão com justificativa e histórico): agora também mostra a unidade da conta e a origem (Foody API). Nenhuma classificação automática sem evidência. Fechamentos com triagem pendente aparecem como "Preliminar · valores provisórios" e, no Parser, os pedidos aparecem como "Operação indefinida".
- **Limitação:** a saúde aparece na unidade **titular** da conta (Subway). Para a unidade destino (Açaí), o frescor aparece no Parser (`ultimaSincronizacao`).

## 6b. Fonte de cada dia e "Preencher mês" (Parser)

- **Calendário** (`GET /parser-food-delivery/cobertura`, só leitura e sob a mesma flag): cada dia aparece como relatório importado, Foody, Foody provisório (sem fechamento definitivo ou dia em curso), sem dados ou em andamento. Dias com triagem ficam marcados, e a tela mostra a última atualização. "Sem dados" é ausência de registro, nunca dia zerado. Flag desligada: `{ habilitado: false }`, sem nenhuma consulta, e o calendário não aparece.
- **Dados reais (leitura de 10/11):** Açaí em setembro = 0 de 30 dias com dados; outubro = só 31/10; novembro = 9 de 9 dias encerrados pela Foody, 4 provisórios por triagem. Subway = setembro, outubro e novembro inteiros por relatório.
- **Preencher mês** (`GET /integracoes/foody/sincronizacoes/previa-mes?mes=AAAA-MM`): consulta a API Foody (**só GET**) **apenas** nos dias sem fechamento definitivo ou provisório. Não grava nada (nem execução), usa cache de 10 min e tem as mesmas travas da sincronização manual (flags, Administrador da empresa titular, sem impersonação). Cada dia sai como completo, provisório (não é regravado), parcial (fechamento INCOMPLETO), recuperável, sem pedidos na origem (zero **não** é tratado como loja fechada), indisponível ou não consultado (a consulta parou por erro de conta, e o dia nunca vira "sem pedidos"). A prévia mostra os pedidos por operação e as taxas **previstas** de pedidos com entregador.
- **Gravação:** só depois da prévia, com motivo e confirmação, pela sincronização manual **existente** (lotes de até 7 dias; dias congelados como reprocessamento com motivo). É idempotente por `foody_uid` + hash: repetir não duplica. Ao terminar, o Parser recarrega o período.
- **Unidade destino (Açaí):** a conta Foody pertence à titular. A tela orienta a recuperar pela unidade titular, e os pedidos do Açaí chegam pela distribuição aprovada. Disponibilidade histórica: a validação de 03/11 encontrou pedidos com pelo menos 18 meses. A disponibilidade **de cada dia** só é afirmada depois da prévia real, feita ao clicar no sistema publicado. Nenhuma chamada à API foi feita a partir desta máquina.

## 7. Testes (branch do PR)

- Backend (Foody, Parser, Dashboard logística, notificações): **668 aprovados, 1 pulado, 0 falhas**. Frontend (Foody, Parser, Dashboard logística): **48 aprovados, 10 pulados (testes de navegador sem Playwright), 0 falhas**.
- Novos: `parser-foody-pedidos.test.js` (16), `foody-recuperacao-mes.test.js` (7: travas, classificação por dia, **nada gravado**, sem dado pessoal, dia aberto, falha de conta interrompe, cache), `configuracoesFoodySaude.test.js` (6) e `parserFoodDeliveryCobertura.test.js` (7).
- Verificação visual: o calendário foi montado com a cobertura **real** do Açaí (01/09–10/11) e a folha de estilos do app. O texto não vem de nenhum mock.
- O teste "migration 147 — estático" deixou de usar a lista fixa de nomes e passou a verificar regras: prefixo único, só as migrations conhecidas tocam `foody_*` e nenhuma posterior apaga ou trunca `foody_*`. Teste de mutação: uma migration falsa com `delete from foody_pedidos` reprova.
- Fora desta prova: execução publicada, tela logada e sincronizações consecutivas observadas **depois** da publicação.

## 8. Implantação (exige autorização)

1. Push da branch, PR e merge na `main` (auto-deploy do backend). Nenhuma migration é necessária.
2. No Render (`crescercomdelivery`) → Environment: `FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED=true` e `FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES=<uuid do Açaí no Grau Saci>`. O uuid conferido está no runbook privado, fora do repositório público.
3. Homologação logada: Parser do Açaí, período 01–10/11 → 241 pedidos, R$ 2.017,00 e a fonte "Foody Delivery — sincronização automática". Parser da Subway sem mudança.
4. **Reversão:** remover `FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED` (o Render reinicia). Não há dado gravado nem migration a desfazer.

## 9. Coleta do dia em curso (branch separada `feat/foody-intradiario`, não incluída neste PR)

- Origem `intradiario` e flag própria `FOODY_CENTRAL_INTRADIARIO_ENABLED` (exige também as flags do agendador). Intervalo de 5 a 60 min, padrão 15. Com 1 GET por unidade por rodada, fica muito abaixo do limite documentado de 100 req/min.
- Só sincroniza **hoje**; **nunca** gera fechamento (o dia fecha na rodada D-1, como antes). A mudança de status atualiza o mesmo pedido pelo hash, sem duplicar.
- Usa a mesma trava por unidade do ciclo diário: o intradiário **cede** quando o diário está rodando, e o diário **tenta de novo** se encontrar a trava ocupada.
- Parser: pedido de hoje ainda não encerrado (`closed`/`cancelled`) fica "Em andamento", fora da conciliação e das taxas, com aviso de valores parciais.
- Exige a **migration 159**, que só amplia o CHECK de `foody_sync_execucoes.origem`. Não foi aplicada. O rollback recusa se houver execução intradiária.
- 16 testes próprios; regressão de 674 testes; teste de mutação confirmou a trava do fechamento. **Não ativar sem homologação específica.**

## 10. Pendências reais (não declaradas como concluídas)

| Item | Tipo | O que falta |
|---|---|---|
| Publicação do Parser + flag do Açaí | Autorização | Merge, flag no Render e homologação logada |
| iFood do Açaí | Autenticação humana | Ver `docs/ifood-acai-conexao.md` |
| SAIPOS / Anota AI | Fonte externa | Não há conector nem credencial no projeto; segue a importação de arquivo (ver `docs/ifood-acai-conexao.md`, seção 4) |
| Dia em curso | Homologação | Branch `feat/foody-intradiario` + migration 159, ambas sem publicação |
| Triagem pendente | Decisão humana | 2 a 6 pedidos por dia na fila de triagem |
| Nome do entregador | Decisão de privacidade | A sincronização guarda só o hash; o pagamento por entregador exige decidir se o nome pode ser armazenado |
| Fechamento de setembro do Açaí (R$ 83.183,38) | Referência | Não usado na sincronização; dados homologados intocados |
