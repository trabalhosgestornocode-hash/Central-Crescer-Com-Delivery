# Dashboard Operacional 2.0 — Relatório de homologação local

> Branch `feat/dashboard-operacional-2`, worktree `crescer-dashboard-operacional-2`, base `origin/main` `a035750`.
> Ambiente: testes com variáveis fictícias (sem `.env`, sem rede); Postgres 17 **local e descartável** (porta 55431, cluster no scratchpad); Chrome local via Playwright 1.49.1.
> **Nenhuma operação de produção:** nenhuma migration em produção, nenhum deploy, nenhum merge, nenhum push, nenhuma mensagem enviada. Na homologação final, 129 e 130 foram aplicadas **somente** no Supabase de **teste** (`wiqqsxnysbzhcrzrrean`), depois do pré-voo; ver `04-homologacao-supabase-teste.md`.

## 1. Resultados dos testes

| Suíte | Resultado | Observação |
|---|---|---|
| `operacional-projecao-ficha` | **19/19** | duplicatas, fora de ordem, evento tardio, ORDER_PATCHED, ordem invertida, sem detalhes, patrocínio, idempotência e **ausência de PII** (dados pessoais fictícios plantados) |
| `operacional-fechamento` | **24/24** | os 11 indicadores com valores **calculados à mão**, competências, meia-noite nas duas direções, isolamento entre unidade e empresa, mesmos números do Dashboard e do Excel, SEM_MUDANCA, JA_REGISTRADO, REVISADO com e sem motivo, PRELIMINAR/CONSOLIDADO/INCOMPLETO, trava contra linha de outro tenant, lista e ficha, projeção incremental, prévia/simulação/dedupe de WhatsApp |
| `operacional-diagnostico-whatsapp` | **17/17** | regras e amostra mínima, IA desligada, número inventado/causa/ação fora da biblioteca → fallback, cota, formato pt-BR, mensagem, validação de PII, transporte só `noop`, **teste arquitetural** (nenhum import de provider/gateway/Baileys) |
| `operacional-integracao` | **9/9** | ORDER_PATCHED reabre detalhes **sem mudar estado oficial nem ACK**; releitura idempotente; agendador travado sem as duas variáveis; ciclo idempotente; permissões HTTP; perfil de exibição só com `/resumo` |
| `operacional-camada-pg` (Postgres real) | **9/9** | 129 e 130: privilégios, RLS, rollback e reaplicação, RPC, imutabilidade, **concorrência real com duas sessões**, CHECK do transporte, compatibilidade com a transferência de unidade |
| Frontend (`node --test test/*.test.js`, sem Playwright) | **1618 testes: 1601 aprovados, 0 falhas, 17 pulados** | os pulados são os testes de navegador, que exigem variável de Playwright (6 deles são do teste novo) |
| Navegador (`*.browser.test.js`, Chrome real, um arquivo por vez) | **118 testes: 117 aprovados, 1 falha preexistente** | ver §1.2 |
| Regressão do backend (Checklist + iFood + Agente) | **1949/1952 → 3 corrigidas** | as 3 falhas eram efeito esperado: a análise passou a comparar média; o teste estático de tenant e o de rotas precisavam conhecer as rotas novas. Atualizados **sem afrouxar** (parâmetros aceitos só `chave` e `id`; escritas listadas explicitamente; `/pedidos` só leitura). Depois: 76/76 nos arquivos afetados |
| Regressão completa do backend | ver §1.1 | |
| Migration **131** em Postgres descartável (cadeia real da `main`) | **38/38** (`transferencia_checklist_metas.sh`) e **53 verificações, 0 falhas** (`transferencia_unidades.sh`, `REF_BASE=HEAD`; na `main`: 10 falhas) | defeito reproduzido na `main`, corrigido com a 131, compatível com 129/130, isolamento e privilégios mínimos, controle negativo pelo rollback, reaplicação e recusa sem a 127 |
| Supabase de **teste** (PostgREST + RLS) | **40/40** + `authenticated` **14/14 negados** + transferência real | ver `04-homologacao-supabase-teste.md` |
| Travas de numeração de migrations | **43/43** | 129, 130 e 131 registradas |

### 1.1 Regressão completa do backend: matriz exata

Comando idêntico nas duas árvores, rodadas **em sequência** (nunca em paralelo), com o mesmo `node_modules` e o `gateway-whatsapp/node_modules` disponível nas duas (junções temporárias):

```
env -u DATABASE_URL -u OPERACIONAL_PG_URL SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=<fictícia> SUPABASE_ANON_KEY=<fictícia> \
  node --experimental-vm-modules --test --test-timeout=300000 --test-reporter=tap test/*.test.js
```

| | esta branch | `main` pura (`a035750`) |
|---|---|---|
| Arquivos de teste descobertos | 341 | 336 |
| Testes descobertos | 5681 | 5612 |
| Executados (descobertos − pulados) | 5656 | 5587 |
| Aprovados | **5642** | 5573 |
| Falhas | **14** | 14 |
| Pulados (SKIP) | 25 | 25 |
| Não executados / cancelados | 0 | 0 |
| Timeout | 0 | 0 |
| Duração | 162 s | 162 s |
| **Falhas preexistentes** (iguais nas duas) | 14 | 14 |
| **Falhas introduzidas pela branch** | **0** | — |

Os 5 arquivos e os 69 testes a mais são as suítes `operacional-*`, e todos passam. A suíte de Postgres real (`operacional-camada-pg`) aparece como pulada nessa rodada porque exige `OPERACIONAL_PG_URL`. Ela foi rodada à parte num banco descartável novo: **9/9**.

**As 14 falhas preexistentes, com a causa investigada:**

| Falhas | Causa comprovada |
|---|---|
| 11 da Central de Comunicação: `central-conversas` (lista, não lidas, foto, cursor) e `central-visao-historico` ("visão geral" ×2, "destinatários" ×1) | **Bomba-relógio no helper de teste, não carga.** Os testes fixam `AGORA = 24/09/2026`, mas `test/helpers/central-fake-db.js` corta a retenção de 30 dias com o relógio real (`Date.now()`). Desde 24/10 os dados sintéticos caem fora da janela. **Prova:** fixando só `Date.now()` em 24/09/2026 (`node --import`), os dois arquivos passam **48/48 nas duas árvores**; sem isso, 37/48 nas duas, inclusive rodando **sozinhos**. A observação anterior ("passam isoladamente") está **corrigida** por esta: a falha é determinística. |
| `performance-calc` "distribuições recompõem mês…" | Asserção (`10 !== null`) idêntica na `main`. Já registrada como falha conhecida. |
| `sessao-perfil` "selecionarPerfil (Fase C)" ×2 | `fetch failed`: precisa de um Supabase alcançável, que este ambiente fictício bloqueia de propósito. |

Na rodada anterior, `whatsapp-retry-allowlist` e `whatsapp-retry-cache-routes` falhavam só por falta de `gateway-whatsapp/node_modules`; com a dependência disponível nas duas árvores, **passam nas duas**.

**Correção proposta para a Central (fora do escopo, outra frente):** o helper deve usar o relógio injetado (`deps.agora`/`AGORA`) no corte de retenção, em vez de `Date.now()`. Não foi alterado aqui.

### 1.2 Navegador (Chrome real, Playwright 1.49.1, um arquivo por vez)

| Arquivo | Resultado |
|---|---|
| `checklistOperacionalDashboard2.browser.test.js` (**novo**: abas pelo teclado, Ficha 360°, fechamento, Excel/PDF, WhatsApp simulado, perfil só de leitura, celular 390 px) | **6/6** |
| `checklistOperacionalModos` (Checklist ao vivo e modos) | 40/40 |
| `checklistOperacionalUniversal` | 13/13 |
| `financeiro` | 17/17 |
| `ifood-loja-adicional`, `ifood-multi-conexao`, `ifoodOrderOnly` | 7/7, 3/3, 6/6 |
| `parserFoodDelivery` | **9/10**. A falha "dia único… drill-down" (`0 !== 2` na linha 104) é **idêntica na `main` pura**, e esta branch não toca o Parser. Preexistente. |
| `perfilExibicao`, `renovacaoExibicao` | 11/11, 4/4 |
| `performance` | 1/1 |

O teste novo cobre:
- as abas pelo teclado (setas e End);
- a ausência de Mediana/P90;
- a busca e a Ficha 360° sem nenhum dado pessoal plantado;
- os 11 indicadores;
- os mesmos números na tela, na prévia e no Excel baixado de verdade;
- o PDF pela impressão do navegador;
- o "copiar", que devolve exatamente o texto armazenado;
- a simulação, que grava **uma** vez com `transporte=noop` (o teste também prova que nenhuma rota de comunicação ou gateway foi chamada);
- o perfil sem `configuracoes.gerenciar`, que não gera nem simula;
- o celular de 390 px, sem rolagem horizontal.

### Testes NÃO executados (não contam como PASS)

- Suítes `-pg` antigas de outros módulos (cada uma exige o seu banco descartável).
- Migration 131 no Supabase de teste: aquele banco não tem a 127, e a 131 se recusa a rodar sem ela. Provada no Postgres descartável com a cadeia real da `main`.
- IA real (Anthropic): a camada foi testada com provider falso; nenhuma chamada paga.
- Comparação com um dia real encerrado (exige leitura de produção).

## 2. Defeitos encontrados e corrigidos durante a homologação

1. **Hash instável:** eventos com o mesmo horário (DSP e CLT simultâneos) ficavam em ordem diferente conforme a ordem de chegada, e o `fonte_hash` mudava. Desempate determinístico por `event_id`.
2. **Dependência de relógio:** a detecção de "projeção desatualizada" comparava o relógio da aplicação com o do banco. Agora compara banco com banco (`pedidoAtualizadoEm` e último `received_at` vistos).
3. **Reentrega reprojetava sempre:** o último recebimento passou a considerar todas as linhas recebidas.
4. **Tela:** numeração dos cartões 2–4, desvio da meta em palavras ("4 min abaixo"), plural de "expirada".
5. **Foco do teclado nas abas (achado pelo teste de navegador novo):** ao trocar de aba pelas setas, a carga assíncrona redesenhava a tela e devolvia o foco à **primeira** aba, porque o foco era restaurado por `data-acao` e todas as abas compartilham `data-acao="aba"`. Agora a restauração usa o `id` primeiro, depois `name` e por fim `data-acao`. O teste falhava antes da correção (controle negativo) e passa depois.
6. **Transferir/promover unidade (defeito preexistente da 127):** corrigido pela migration **131**, sem alterar a 127 (`01-arquitetura.md` §11).

## 3. Exemplo de fechamento com dados sintéticos

Cenário: `backend/test/helpers/operacional-sintetico.js`, unidade A1, competência **27/10/2026**, gerado em 28/10 09:00 (SP).

| Indicador | Valor | Conferência manual |
|---|---|---|
| Pedidos recebidos / concluídos no dia / cancelados no dia | 35 / 32 / 3 | o pedido de teste fica fora; o de 26/10 23:55 entra em "concluídos" de 27/10; o de 27/10 23:50 conclui em 28/10 |
| Coorte de entrada | 32 concluídos + 3 cancelados + 0 em aberto = 35 | identidade só dentro da coorte |
| Preparo médio | 16,0 min (29 pedidos; meta 20) | (23×14 + 4×30 + 2×11) ÷ 29 |
| Entrega média | 13,9 min (29; meta 15) | (22×13 + 4×20 + 2×10 + 16) ÷ 29 |
| Vida média | 29,9 min (29; meta 35) | (22×27 + 4×50 + 2×21 + 30) ÷ 29 |
| Pedidos atrasados | 5 de 29 (17,2%); mais atrasos em entrega | 4 lentos + 1 com entrega de 16 min |
| Cancelamentos | 502 "duplicado" (2), 411 "atrasado" (1); taxa 8,6% | origem e estágio oficiais |
| Maior movimento | 19h (13 pedidos), 12h (9), 13h (4) | |
| Disputas | 2 abertas, 1 expirada, 1 aceita | disputa da outra empresa fora |
| Descontos pagos pela loja | R$ 32,00 em 4 pedidos | 4 × R$ 8 |
| Clientes | 9 novos, 25 recorrentes, 1 sem informação | contagem por pedido |
| Situação | CONSOLIDADO; pendência: 1 pedido alterado depois da leitura dos detalhes | |
| Diagnóstico | disputas expiradas, cancelamento elevado, cancelamentos em alta (3 achados) | nenhum atribui causa |

## 4. Prévia do WhatsApp (simulada, 921 caracteres)

```
*CRESCER COM DELIVERY*
Fechamento operacional
Unidade Sintética · 27/10/2026 · v1
Situação: *CONSOLIDADO*

*PEDIDOS*
Recebidos: 35 · Concluídos no dia: 32 · Cancelados no dia: 3

*TEMPOS (médias)*
Preparo: 16 min (meta 20 min; 29 pedidos) ✅
Entrega: 13,9 min (meta 15 min; 29 pedidos) ✅
Vida do pedido: 29,9 min (meta 35 min; 29 pedidos) ✅

*ATRASOS*
5 de 29 pedidos (17,2%) · mais atrasos em: entrega

*MOVIMENTO*
Pico: 19h–20h (13), 12h–13h (9)

*CANCELAMENTOS*
3 no dia · O pedido está duplicado (2); O pedido está atrasado (1)

*DISPUTAS*
Abertas: 2 · Expiradas: 1

*DESCONTOS*
Financiados pela loja: R$ 32,00 em 4 pedidos (valor operacional)

*CLIENTES*
Novos: 9 · Recorrentes: 25 · Sem informação: 1

*DIAGNÓSTICO*
Disputas expiradas sem resposta: 1 disputa(s) expiraram no dia (desfecho EXPIRED do iFood).

*AÇÃO RECOMENDADA*
Revisar quem acompanha a Plataforma de Negociação nos horários de pico e como é avisado.
```

## 5. QA visual (Chrome real)

Cinco telas (Visão Geral, Pedidos, Ficha 360°, Ocorrências, Fechamentos + prévia) × tema claro/escuro × desktop 1366 px / celular 390 px = **20 capturas**.

**Em todas:**
- sem rolagem horizontal da página;
- 4 abas com uma selecionada;
- nenhum "mediana", "P90", "undefined" ou "NaN";
- abas e versões com alvo de toque ≥ 40 px;
- nenhum erro de script.

As capturas e os geradores ficam fora do repositório (scratchpad `qa-dashboard2/`). No celular, a tabela de pedidos rola dentro do próprio contêiner, como as demais tabelas do Dashboard.

## 6. Evidências de ausência de envio real

1. **Imports:** nenhum arquivo de `checklist-operacional` importa `whatsapp.service`, provider, gateway, Baileys ou `comunicacao/` (teste arquitetural). O controlador do frontend só chama `simularWhatsappFechamento`, e o teste do frontend proíbe `comunicacao`/`gateway`/`enviarMensagem` nele.
2. **Transporte:** `criarTransporte` recusa qualquer nome diferente de `noop` (inclusive `baileys`, `whatsapp`, `gateway`, `real`, vazio).
3. **Banco:** `operacional_mensagens_simuladas.transporte` tem `CHECK (transporte = 'noop')` (provado no Postgres real: `baileys` é recusado). A tabela é separada de `comunicacao_mensagens`.
4. **Agendador:** não é iniciado por `server.js`/`app.js`, exige `OPERACIONAL_FECHAMENTO_AGENDADO_ENABLED=true` **e** `OPERACIONAL_AMBIENTE_ISOLADO=true`, e nunca gera nem simula mensagem (teste).
5. **Execução:** nenhum teste desta missão tem gateway ou credencial de WhatsApp; o worker de comunicação não foi iniciado.

## 7. Riscos e limitações

| Risco | Situação |
|---|---|
| Transferir ou promover unidade quebra na `main` por causa da 127 | **Corrigido pela 131** (provado em PG descartável). Precisa ser aplicada depois da 127 em cada ambiente. |
| Promover unidade também falha por **outro** defeito preexistente (42P10 `ON CONFLICT`, desde a 063) | Correção na frente do Financeiro (doc 20); não duplicada aqui |
| Testes da Central falham por bomba-relógio no helper (`Date.now()` × `AGORA` fixo) | Preexistente, outra frente; correção proposta em §1.1 |
| Fuso por unidade inexistente | Fuso da plataforma, gravado em cada versão |
| Dia sem nenhum evento vira INCOMPLETO (não há horário de funcionamento para saber se a loja estava fechada) | Comportamento honesto; resolver com horário de funcionamento por unidade |
| Os 14 OPA antigos ficam com detalhes desatualizados (retenção de 7 dias do iFood) | Marcados na projeção e na ficha |
| Primeira abertura da lista/ficha num período longo projeta muitos pedidos (lê o JSON uma vez) | Limitada a 3.000 pedidos por janela e a 92 dias; depois disso é incremental |
| Valores são operacionais | Rotulados em toda tela, Excel, PDF e mensagem |
| Baileys não oficial | Envio real não implementado; exige homologação própria |
| Camada pelo PostgREST real | **Homologada no Supabase de teste** (40/40; `04-homologacao-supabase-teste.md`). Metas por meta não foram exercitadas lá (sem a 127). |

## 8. Pendências de homologação

1. Decisão de publicação: push, PR, revisão e merge (nada foi publicado).
2. Comparar com o Dashboard um fechamento gerado com dados reais de um dia já encerrado (somente leitura, depois da implantação).
3. Decisões que continuam provisórias:
   - fuso da plataforma com a origem gravada;
   - dia sem eventos = INCOMPLETO;
   - IA desligada;
   - WhatsApp só simulado;
   - retenção proposta e **não** executada;
   - Checklist ao vivo inalterado.
4. Supabase de teste: decidir se mantém 129/130 aplicadas (estado atual) ou aplica os rollbacks. Os fechamentos e simulações `[OP2]` ficam lá como evidência.
5. `graphify update .` no checkout principal depois do merge (o grafo vive lá; o worktree não tem `graphify-out`).

## 9. Branch, commit e estado

- **Branch:** `feat/dashboard-operacional-2`, só local (sem push, sem PR, sem merge). Worktree: `C:\Users\ponte\OneDrive\Desktop\crescer-dashboard-operacional-2`.
- **Base:** `origin/main` `a035750`, que não mudou durante a missão.
- **Commits:** quatro sobre a base (`git log --oneline a035750..`), na ordem:
  1. relatórios da auditoria;
  2. entrega;
  3. migration 131;
  4. homologação final (teste de navegador, correção do foco, script do Supabase de teste e estes documentos).
- **Fora do repositório:** junções de `node_modules` removidas depois dos testes; Postgres descartável parado; capturas e geradores de QA no scratchpad da sessão.
- **Outros trabalhos preservados:** o checkout principal (`feat/ifood-servicos-sinal`, com um arquivo não versionado) e os demais worktrees não foram tocados.
