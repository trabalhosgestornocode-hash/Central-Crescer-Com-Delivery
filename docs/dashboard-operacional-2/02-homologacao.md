# Dashboard Operacional 2.0 — Relatório de homologação local

> Branch `feat/dashboard-operacional-2`, worktree `crescer-dashboard-operacional-2`, base `origin/main` `a035750`.
> Ambiente: testes com variáveis fictícias (sem `.env`, sem rede); Postgres 17 **local e descartável** (porta 55431, cluster no scratchpad); Chrome local via Playwright 1.49.1.
> **Nenhuma operação de produção:** nenhuma migration em produção, nenhum deploy, nenhum merge, nenhum push, nenhuma consulta ao banco de produção nesta missão, nenhuma mensagem enviada.

## 1. Resultados dos testes

| Suíte | Resultado | Observação |
|---|---|---|
| `operacional-projecao-ficha` | **19/19** | duplicatas, fora de ordem, evento tardio, ORDER_PATCHED, ordem invertida, sem detalhes, patrocínio, idempotência e **ausência de PII** (dados pessoais fictícios plantados) |
| `operacional-fechamento` | **24/24** | os 11 indicadores com valores **calculados à mão**, competências, meia-noite nas duas direções, isolamento entre unidade e empresa, mesmos números do Dashboard e do Excel, SEM_MUDANCA, JA_REGISTRADO, REVISADO com e sem motivo, PRELIMINAR/CONSOLIDADO/INCOMPLETO, trava contra linha de outro tenant, lista e ficha, projeção incremental, prévia/simulação/dedupe de WhatsApp |
| `operacional-diagnostico-whatsapp` | **17/17** | regras e amostra mínima, IA desligada, número inventado/causa/ação fora da biblioteca → fallback, cota, formato pt-BR, mensagem, validação de PII, transporte só `noop`, **teste arquitetural** (nenhum import de provider/gateway/Baileys) |
| `operacional-integracao` | **9/9** | ORDER_PATCHED reabre detalhes **sem mudar estado oficial nem ACK**; releitura idempotente; agendador travado sem as duas variáveis; ciclo idempotente; permissões HTTP; perfil de exibição só com `/resumo` |
| `operacional-camada-pg` (Postgres real) | **9/9** | 129 e 130: privilégios, RLS, rollback e reaplicação, RPC, imutabilidade, **concorrência real com duas sessões**, CHECK do transporte, compatibilidade com a transferência de unidade |
| Frontend (`node --test test/*.test.js`) | **1601 aprovados, 0 falhas, 11 pulados** | inclui `checklistOperacionalDashboard2.test.js` (13) e o ajuste de `checklistOperacional2.test.js`. Os pulados são navegador de outros módulos sem variável de Playwright |
| Navegador (`*.browser.test.js`, Chrome) | **84 aprovados, 0 falhas, 11 pulados** | Checklist (modos, universal), perfil de exibição, renovação, iFood. **O Checklist ao vivo continua funcionando** |
| Regressão do backend (Checklist + iFood + Agente) | **1949/1952 → 3 corrigidas** | as 3 falhas eram efeito esperado: a análise passou a comparar média; o teste estático de tenant e o de rotas precisavam conhecer as rotas novas. Atualizados **sem afrouxar** (parâmetros aceitos só `chave` e `id`; escritas listadas explicitamente; `/pedidos` só leitura). Depois: 76/76 nos arquivos afetados |
| Regressão completa do backend | ver §1.1 | |
| Travas de numeração de migrations | **43/43** | 129 e 130 registradas |

### 1.1 Regressão completa do backend

`node --experimental-vm-modules --test test/*.test.js` com ambiente fictício: **5655 testes, 5614 aprovados, 16 falhas, 25 pulados.**

Para separar o que é desta branch, os arquivos com falha foram rodados **lado a lado na `main` pura** (`a035750`, worktree da auditoria) e nesta branch:

| Falha | `main` | esta branch | Conclusão |
|---|---|---|---|
| `central-conversas` (lista, não lidas, foto, cursor) | falha | falha | preexistente |
| `performance-calc` "distribuições recompõem mês…" | falha | falha | preexistente (já registrada na memória do projeto) |
| `sessao-perfil` "selecionarPerfil (Fase C)" | falha | falha | preexistente (precisa de Supabase) |
| `whatsapp-retry-allowlist` e `whatsapp-retry-cache-routes` (arquivo inteiro) | falha | falha | ambiente: exigem `gateway-whatsapp/node_modules` |
| "visão geral" e "destinatários" (Central) | — | passam isoladamente | intermitentes sob carga na rodada completa; **passam** quando rodados sozinhos nesta branch |

Comparação dos arquivos suspeitos: **138 testes, 125 aprovados, 13 falhas — idênticos nas duas árvores.** Nenhuma falha é causada por esta entrega.

### Testes NÃO executados (não contam como PASS)

- Suítes `-pg` antigas de outros módulos (exigem cada uma o seu banco descartável).
- Supabase real (PostgREST + RLS do projeto de teste): a camada nova foi validada em SQL real e com o repositório simulado, **não** pelo PostgREST.
- Navegador dos módulos Financeiro, Parser e Performance (variáveis próprias, fora do escopo).
- IA real (Anthropic): a camada foi testada com provider falso; nenhuma chamada paga foi feita.

## 2. Defeitos encontrados e corrigidos durante a homologação

1. **Hash instável:** eventos com o mesmo horário (DSP e CLT simultâneos) ficavam em ordem diferente conforme a ordem de chegada, e o `fonte_hash` mudava. Desempate determinístico por `event_id`.
2. **Dependência de relógio:** a detecção de "projeção desatualizada" comparava o relógio da aplicação com o do banco. Agora compara banco com banco (`pedidoAtualizadoEm` e último `received_at` vistos).
3. **Reentrega reprojetava sempre:** o último recebimento passou a considerar todas as linhas recebidas.
4. **Tela:** numeração dos cartões 2–4, desvio da meta em palavras ("4 min abaixo"), plural de "expirada".

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
| Transferir ou promover unidade quebra na `main` por causa da 127 (achado preexistente reproduzido) | Fora do escopo; correção proposta em `01-arquitetura.md` §11 |
| Fuso por unidade inexistente | Fuso da plataforma, gravado em cada versão |
| Dia sem nenhum evento vira INCOMPLETO (não há horário de funcionamento para saber se a loja estava fechada) | Comportamento honesto; resolver com horário de funcionamento por unidade |
| Os 14 OPA antigos ficam com detalhes desatualizados (retenção de 7 dias do iFood) | Marcados na projeção e na ficha |
| Primeira abertura da lista/ficha num período longo projeta muitos pedidos (lê o JSON uma vez) | Limitada a 3.000 pedidos por janela e a 92 dias; depois disso é incremental |
| Valores são operacionais | Rotulados em toda tela, Excel, PDF e mensagem |
| Baileys não oficial | Envio real não implementado; exige homologação própria |
| Camada não testada pelo PostgREST real | Testar no Supabase de teste antes da produção (pendência abaixo) |

## 8. Pendências de homologação

1. Revisão do código (PR, sem merge automático).
2. Aplicar 129 e 130 no **Supabase de teste**, rodar a lista/ficha/fechamento pelo PostgREST real e conferir RLS e privilégios pelo catálogo.
3. Comparar com o Dashboard um fechamento gerado com dados reais de um dia já encerrado (somente leitura).
4. Decisões: fuso por unidade, prazos de retenção (`03-retencao-anonimizacao.md`), ativação da IA, política e provedor de WhatsApp, correção da 127.
5. `graphify update .` no checkout principal depois do merge (o grafo vive lá; o worktree não tem `graphify-out`).

## 9. Branch, commit e estado

- **Branch:** `feat/dashboard-operacional-2`, só local (sem push, sem PR, sem merge). Worktree: `C:\Users\ponte\OneDrive\Desktop\crescer-dashboard-operacional-2`.
- **Base:** `origin/main` `a035750`, que não mudou durante a missão.
- **Commits:** dois sobre a base. O primeiro traz os relatórios da auditoria; o segundo, esta entrega (`git log --oneline a035750..`).
- **Fora do repositório:** junções de `node_modules` removidas depois dos testes; Postgres descartável parado; capturas e geradores de QA no scratchpad da sessão.
- **Outros trabalhos preservados:** o checkout principal (`feat/ifood-servicos-sinal`, com um arquivo não versionado) e os demais worktrees não foram tocados.
