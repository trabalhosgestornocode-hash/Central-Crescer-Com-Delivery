# Automação Foody (Subway Saci + Açaí no Grau Saci): matriz de aceite, bloqueios e ativação

Situação em 04/11/2026: **tudo inerte**. Nenhum PR foi mergeado ou publicado. Nenhuma flag foi alterada, nenhuma migration foi aplicada em produção, nenhuma sincronização real foi feita e nenhuma mensagem foi enviada.

## PRs (todos Draft, empilhados)
| Fase | PR | Branch | Base |
|---|---|---|---|
| A — sincronização manual + paridade | #79 | `feat/foody-sync-manual` | `main` |
| B — agendador embarcado + trava única (migration 150) | #80 | `feat/foody-agendador` | #79 |
| C — fonte única por dia no Parser | #81 | `feat/foody-fonte-parser` | #80 |
| D — bloco logístico nos relatórios do Checklist + esta matriz | #82 | `feat/foody-relatorio-logistico` | #81 |

## Matriz de aceite (critério objetivo → evidência → resultado)
| # | Critério | Evidência | Resultado |
|---|---|---|---|
| A1 | Sincronização só por admin da titular, sem impersonação; o gestor e o destino são recusados | `foody-sync-manual.test.js`; TESTE: "recusa gestor", "destino não dispara coleta" | PASS |
| A2 | Flags fail-closed (DESLIGADO → 404) | testes unitários + TESTE "flag desligada → DESLIGADO" | PASS |
| A3 | Só GET na Foody | arquitetura (`method` só GET) + TESTE "API Foody: só a falsa, só GET" | PASS |
| A4 | Limites (7 dias, 10 páginas, 4000 pedidos/dia antes de gravar) | `foody-sync-manual.test.js` (LIMITE_PEDIDOS, maxPaginas) | PASS |
| A5 | Idempotência (repetir não cria pedido nem versão; Idempotency-Key) | unitário + TESTE "idempotência" | PASS |
| A6 | Concorrência (EM_ANDAMENTO recente bloqueia; abandonada > 1 h encerrada) | unitário + e2e pg + TESTE | PASS |
| A7 | Fuso: 00:00:00 e 23:59:59 (-03:00) ficam no próprio dia | unitário + TESTE "fuso" | PASS |
| A8 | 401 interrompe; o resto fica NAO_EXECUTADO; a conexão é marcada | unitário + TESTE | PASS |
| A9 | Isolamento: nenhum uid ativo em dois tenants; o Açaí só no tenant do Açaí; nenhum dado comercial do Açaí na titular | e2e pg local (destino ATIVO) + TESTE (destino PENDENTE não recebe nada) | PASS |
| A10 | Fechamentos independentes por organização | e2e pg local (2/2) + TESTE titular-only (2/0) | PASS |
| A11 | Dado pessoal descartado | TESTE "dados pessoais descartados" | PASS |
| A12 | Paridade Foody × Parser (pareados, troca de operação, triagem) | `foody-paridade.test.js` + TESTE PARIDADE 10/10 | PASS (sintético) |
| A13 | Homologação no TESTE não destrutiva | TESTE PASS 31/31; 147 tabelas idênticas antes e depois (transação com ROLLBACK) | PASS |
| B1 | Agendador só com ENABLED + AGENDADOR + allowlist + guarda de efeitos externos; nada é importado sem isso | `foody-agendador-embutido.test.js` + arquitetura | PASS |
| B2 | Primeiro ciclo atrasado 3 min; D-1..D-3 a cada 6 h | idem | PASS |
| B3 | Trava única entre a tela e o agendador | idem ("tela recebe CONCORRENCIA") | PASS |
| B4 | Parada segura: termina o dia em curso, não começa o próximo, não reagenda | idem | PASS |
| B5 | Migration 150: uma EM_ANDAMENTO por unidade; recusa com duplicatas; rollback só remove o índice | idem (Postgres real) | PASS (local) |
| C1 | Um dia, uma fonte; nunca Excel + Foody somados | `foody-fonte.test.js` (`diasComAsDuasFontes`) | PASS |
| C2 | Quatro grandezas separadas (bruta, válida, atribuída, real conciliada) | idem | PASS |
| C3 | Flag desligada = resposta do Parser igual e nenhuma consulta | idem + `parser-food-delivery-periodo.test.js` 29/29 | PASS |
| C4 | Excel continua oficial para pagamento e distância | idem | PASS |
| D1 | Bloco logístico por empresa (Subway ≠ Açaí) | `foody-relatorio-logistico.test.js` | PASS |
| D2 | R$ só para papel principal/financeiro | idem | PASS |
| D3 | Versão nova da Foody não gera mensagem corretiva; a fotografia mostra a versão | idem | PASS |
| D4 | Limite de 1500 caracteres e validação: o bloco nunca bloqueia o relatório | idem | PASS |
| D5 | Nenhum envio real (só o texto enfileirado muda; o envio tem as próprias travas) | idem (estrutural) | PASS |
| E1 | Regressão do backend (Foody, Parser, Agente, notificações, Checklist, comunicação, iFood) | execução serial com Postgres local: 3342/3344 (1 falha + 1 pulado) | PASS: a única falha (Checklist 2.0: Excel × PDF, Preparo) falha **igual na `main` limpa** (cd38e4c), não é regressão |
| E1b | Regressão encontrada e corrigida durante a homologação | listas de migrations conhecidas (088, 103) não tinham a 150 → corrigido no #80 | PASS |
| E2 | Pedido REAL da Subway/Açaí comparado ao relatório real | — | **NÃO EXECUTADO** (exige sincronização real em produção) |

## Bloqueios reais de produção
1. **Sincronização real nunca executada.** A paridade com dados reais (E2) exige `FOODY_CENTRAL_ENABLED=true` + allowlist no Render e uma coleta real, ambas não autorizadas.
2. **Migration 150 não aplicada.** Aplicar exige backup e autorização. Sem ela vale a trava da aplicação (memória + banco), com uma corrida residual entre instâncias.
3. **Fluxo com destino ATIVO dentro de uma transação.** No TESTE, a regra de ato separado da 148 impede ativar o destino numa transação com ROLLBACK. Esse fluxo está provado só no e2e local em autocommit. A prova em ambiente real já existe pela aprovação real feita em produção em 04/11.
4. **Lacunas da API Foody** (memória de 03/11): sem `dataCancelado`/origem; 12 perguntas pendentes ao suporte. Isso afeta a classificação de cancelamento.
5. **Merges e deploys** dos PRs #79–#82: não autorizados.

## Ativação progressiva (cada passo tem rollback próprio)
| Passo | Ação | Pré-condição | Rollback |
|---|---|---|---|
| 0 | Mergear #79–#82 (tudo inerte) e fazer o deploy | revisão + autorização | revert do merge |
| 1 | Backup + aplicar a 150 | backup confirmado; nenhuma EM_ANDAMENTO duplicada | `150_rollback.sql` |
| 2 | `FOODY_CENTRAL_ENABLED=true`, `FOODY_CENTRAL_UNIDADES=<Subway Saci>`; **uma** sincronização manual de D-1 pela tela | conexão ATIVA; compartilhamento OFF | flag `false` (as linhas ficam como histórico) |
| 3 | Rodar `scripts/foody-paridade.mjs` (somente leitura) contra o Excel real de D-1 | passo 2 PASS | — |
| 4 | `FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED=true`; reprocessar D-1 com motivo | paridade aceita; destino Açaí ATIVO | flag `false`; o roteamento volta ao modo da conta própria |
| 5 | `FOODY_CENTRAL_AGENDADOR_ENABLED=true` (+ guarda de efeitos externos já autorizada no serviço) | 3–7 dias de coleta manual estável | flag `false` (a parada é segura) |
| 6 | `FOODY_CENTRAL_PARSER_ENABLED=true`, `FOODY_CENTRAL_PARSER_UNIDADES=<Subway>` e depois `<Açaí>` | agendador estável | flag `false` (Parser idêntico ao atual) |
| 7 | `FOODY_CENTRAL_RELATORIO_ENABLED=true` + unidades; conferir na fila antes de liberar o envio | Checklist já enviando; destinatários com o papel correto | flag `false` (mensagem original) |

## GO / NO-GO
| Módulo | Decisão | Motivo |
|---|---|---|
| Primeiro piloto real (passo 2: sincronização manual de 1 dia da Subway Saci) | **GO condicionado** a merge/deploy autorizados e à 150 aplicada (ou aceitar a trava só da aplicação com 1 instância) | todos os critérios A em PASS; risco limitado (1 dia, só leitura na Foody, nenhum indicador alimentado) |
| Compartilhamento com o Açaí (passo 4) | **NO-GO até** a paridade real do passo 3 | E2 ainda não executado |
| Agendador (passo 5) | **NO-GO até** dias de coleta manual estável | requisito da missão: nada automático antes do piloto homologado |
| Parser / Dashboard (passo 6) | **NO-GO até** o agendador estável | a fonte Foody só preenche dias sem Excel; precisa de dados reais |
| Checklist / WhatsApp (passo 7) | **NO-GO até** o passo 6 + conferência de destinatários e papéis | nenhuma notificação real nesta fase |
