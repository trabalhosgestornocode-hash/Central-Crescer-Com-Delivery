# Automação Foody (Subway Saci + Açaí no Grau Saci): matriz de aceite, publicação e primeiro piloto

Situação em 04/11/2026 (revisão integrada): **tudo inerte**. Nenhum PR foi mergeado ou publicado. Nenhuma flag foi alterada, a 150 não foi aplicada, nenhuma sincronização real foi feita e nenhuma mensagem foi enviada.
Produção (só leitura): o deploy live é `cd38e4c` (#78) e o Render tem `autoDeploy` em `main`, com 1 instância. Flags: só `FOODY_CENTRAL_ADMIN_ENABLED=true`. A conexão Subway Saci está ATIVA e o destino Açaí ATIVO. 147–149 estão registradas, a 150 está ausente, e `foody_sync_execucoes`, `foody_pedidos` e `foody_fechamentos_logisticos` estão vazias.

## PRs (Draft, empilhados — mergear NESTA ordem)
| Ordem | Fase | PR | Branch | Base | Migration |
|---|---|---|---|---|---|
| 1 | A — sincronização manual + paridade + regra de pendência | #79 | `feat/foody-sync-manual` | `main` | — |
| 2 | B — agendador embarcado + trava única + kit da 150 | #80 | `feat/foody-agendador` | #79 | **150** (aplicada à parte, pelo kit) |
| 3 | C — fonte única por dia no Parser | #81 | `feat/foody-fonte-parser` | #80 | — |
| 4 | D — bloco logístico nos relatórios + esta matriz | #82 | `feat/foody-relatorio-logistico` | #81 | — |

O código não depende da 150: sem ela vale a trava da aplicação (memória + banco). A 150 só fecha a corrida residual entre instâncias.

## Matriz de aceite
| # | Critério | Evidência | Resultado |
|---|---|---|---|
| A1 | Sincronização só por admin da titular, sem impersonação; o gestor e o destino são recusados | `foody-sync-manual.test.js`; TESTE | PASS |
| A2 | Flags fail-closed: sem `ENABLED` + allowlist → DESLIGADO, mesmo com ADMIN ligado | unitário + TESTE + `foody-inatividade-pos-deploy.test.js` | PASS |
| A3 | Só GET na Foody | arquitetura + TESTE | PASS |
| A4 | Limites: 7 dias, 10 páginas, 4000 pedidos/dia antes de gravar | unitário | PASS |
| A5 | Idempotência: repetir não cria pedido nem versão; Idempotency-Key | unitário + e2e pg + TESTE | PASS |
| A6 | Concorrência: EM_ANDAMENTO recente bloqueia; abandonada há mais de 1 h é encerrada; escopo = unidade (o mesmo do índice da 150) | unitário + e2e pg + TESTE | PASS |
| A7 | Fuso: 00:00:00 e 23:59:59 (-03:00) ficam no próprio dia | unitário + TESTE | PASS |
| A8 | 401 interrompe; o resto fica NAO_EXECUTADO; a conexão é marcada | unitário + TESTE | PASS |
| A9 | Isolamento: nenhum uid ativo em dois tenants; o Açaí só no tenant do Açaí | e2e pg (destino ATIVO) + TESTE | PASS |
| A10 | Fechamentos independentes por organização; falha de um destino não impede a titular e deixa a competência pendente | e2e pg + TESTE | PASS |
| A11 | Dado pessoal descartado | TESTE | PASS |
| A12 | **Pendência nunca nasce CONSOLIDADO**: triagem, operação em dúvida, cancelamento em revisão, situação desconhecida ou taxa ausente → PRELIMINAR; depois de consolidado → CORRIGIDO com estado PROVISORIO; regra única `fechamentoDefinitivo()` (status E estado) | `foody-central-unidade.test.js`, `foody-compartilhada-revisao.test.js` | PASS |
| A13 | **Paridade com categorias separadas**: taxa logística (pares divergentes, soma da diferença, taxa de pedido só de um lado, taxa ausente na Foody), cancelamento (CANCELAMENTO_DIVERGENTE ≠ SITUACAO_DIVERGENTE; cancelados e cancelados com taxa por lado), triagem (Foody e revisão do Parser) e `LIMITACOES_API` sempre declaradas | `foody-paridade.test.js` 14/14 | PASS (sintético) |
| A14 | Homologação no TESTE não destrutiva | TESTE PASS 31/31 com ROLLBACK | PASS |
| B1 | Agendador só com ENABLED + AGENDADOR + allowlist + guarda de efeitos externos; o piloto manual (ENABLED + allowlist + compartilhamento) **não** liga o agendador | `foody-agendador-embutido.test.js` + `foody-inatividade-pos-deploy.test.js` | PASS |
| B2 | Primeiro ciclo atrasado 3 min; D-1..D-3 a cada 6 h | idem | PASS |
| B3 | Trava única entre a tela e o agendador | idem | PASS |
| B4 | Parada segura no SIGTERM | idem | PASS |
| B5 | 150: uma EM_ANDAMENTO por unidade; recusa com duplicatas (55000); rollback só remove o índice | `foody-agendador-embutido`/migrations (Postgres real) | PASS |
| B6 | **Kit da 150**: pré-voo só leitura; aplicação numa transação (índice + registro + autoverificação); recusa sem autorização/backup, com duplicata, com lock, ao reaplicar; recuperar só mexe em índice e registro; SHA-256 fixado | `foody-implantacao-150-pg.test.js` 10/10; **TESTE**: pré-voo PASS + ensaio aplica→valida→recupera com ROLLBACK PASS; **produção**: pré-voo só leitura PASS | PASS |
| C1 | Um dia, uma fonte; nunca Excel + Foody somados | `foody-fonte.test.js` | PASS |
| C2 | Quatro grandezas separadas | idem | PASS |
| C3 | Flag desligada: Parser idêntico e nenhuma consulta | idem + inatividade | PASS |
| C4 | Excel continua oficial para pagamento e distância | idem | PASS |
| C5 | **Dia com pendência = FOODY_PENDENTE**, fora do total, com os códigos das pendências; `diasForaDoTotal` | idem | PASS |
| D1–D5 | Bloco por empresa; R$ só para principal/financeiro; sem mensagem corretiva; limite de 1500 caracteres; nenhum envio real | `foody-relatorio-logistico.test.js` | PASS |
| D6 | **Pendência nunca parece fechamento**: PRELIMINAR/PROVISORIO/INCOMPLETO = "não fechado" + pendências, sem R$; a semana soma só dias definitivos e declara os dias fora da soma | idem | PASS |
| E1 | Regressão serial do backend (HEAD do #82) | ver "Regressão" | ver abaixo |
| E2 | Pedido REAL comparado ao relatório real | — | **NÃO EXECUTADO** (é o objetivo do 1º piloto) |

## Bloqueios reais (antes do 1º dia real)
1. **Autorização** de merge, deploy, aplicação da 150 e mudança de flags. Tecnicamente não há outro bloqueio.
2. **Paridade real (E2) não executada**: só o piloto a produz. Por isso Parser, relatórios e agendador continuam NO-GO.
3. **Lacunas conhecidas da API** (`LIMITACOES_API`): sem data de cancelamento, sem origem, entregador só por hash. Isso não bloqueia o piloto: a paridade declara essas lacunas e não as conta como divergência silenciosa.

## Sequência exata de publicação (cada passo para em caso de falha)
| Passo | Ação | Verificação | Interromper se | Recuperação |
|---|---|---|---|---|
| P1 | Marcar #79–#82 como prontos; mergear **#79** em `main` (merge commit) | GitHub reaponta o #80 para `main` | conflito ou CI vermelho | não mergear os próximos |
| P2 | Mergear #80, #81 e #82, nessa ordem, cada um depois que o anterior entrar | `git log main` com os 4 merges | idem | idem |
| P3 | O auto-deploy do Render publica (pode haver um deploy por merge; todos inertes) | o deploy **live** é o commit do merge do #82; `/health` OK; log sem `foody.embutido` iniciado (`habilitado:false`) | deploy falho ou health vermelho | rollback do Render para `cd38e4c` (o código é inerte; não há dado novo) |
| P4 | Conferir a inatividade em produção: a aba Sincronização aparece desligada; `POST` de sincronização → DESLIGADO | tela + log | qualquer coleta ou leitura Foody | flags já estão desligadas; rollback do deploy |
| P5 | **Backup** do dia confirmado no painel do Supabase | horário do backup anotado | sem backup recuperável | não aplicar a 150 |
| P6 | `node backend/testes-seguros/foody-150/kit150.mjs prevoo` (FOODY_ALVO=producao) | falhas `[]` | qualquer falha | nada a desfazer |
| P7 | `FOODY_AUTORIZO=SIM FOODY_BACKUP_CONFIRMADO=SIM node kit150.mjs aplicar` | "150 APLICADA e validada"; contagens iguais | erro (a transação desfaz tudo) | `FOODY_AUTORIZO=SIM node kit150.mjs recuperar` (só índice + registro) |
| P8 | `node kit150.mjs validar` | falhas `[]` | reprovação | `recuperar` |

## Primeiro dia real: piloto em sombra (uma sincronização, compartilhamento ligado desde o início)
**Escopo:** uma sincronização manual de **um** dia D, da conta Foody da Subway Saci (`00000000-0000-0000-0000-0000000000a1`), com o compartilhamento ligado. Na mesma coleta, os pedidos do Açaí vão para o tenant do Açaí no Grau Saci (`4d3b75bd-79b5-4335-ae5b-a183580c3555`), destino já ATIVO. **Nada é consumido**: o Parser, o Checklist, os relatórios e o WhatsApp não leem `foody_*` (flags PARSER e RELATORIO ausentes, agendador desligado).

**Escolha de D:** o dia mais recente, entre D-1 e D-3, cujo Excel já está importado e concluído no Parser da Subway Saci. Isso permite a paridade e mantém D dentro da janela de reprocessamento.

**Requisitos de segurança (todos obrigatórios)**
- Publicação P1–P8 concluída (ou a decisão explícita de seguir sem a 150, com 1 instância).
- Uma única mudança de variáveis no Render, com três valores: `FOODY_CENTRAL_ENABLED=true`, `FOODY_CENTRAL_UNIDADES=00000000-0000-0000-0000-0000000000a1` (só a Subway, a titular) e `FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED=true`.
- Continuam **ausentes ou falsas**: `FOODY_CENTRAL_AGENDADOR_ENABLED`, `FOODY_CENTRAL_PARSER_ENABLED(_UNIDADES)` e `FOODY_CENTRAL_RELATORIO_ENABLED(_UNIDADES)`. `FOODY_CENTRAL_SECRET` não é tocado.
- Antes de ligar, leitura só leitura: a conexão está ATIVA; o destino Açaí está ATIVO e aprovado; não há EM_ANDAMENTO; e as contagens de base estão anotadas (`parser_fd_pedidos`, `operacional_fechamentos`, fila de notificações e `foody_*`).
- A sincronização é feita por um Administrador da Subway Saci, sem impersonação, pela tela Configurações → Integrações → Foody → Sincronização, para **um** dia, com motivo "piloto em sombra".

**Execução**
1. Ligar as 3 variáveis (um único deploy ou restart) e esperar o health.
2. Sincronizar o dia D pela tela (1 clique).
3. Fazer as conferências (só leitura):
   - a execução está CONCLUIDA, com páginas ≤ 10 e pedidos ≤ 4000;
   - nenhum uid ativo em dois tenants;
   - o tenant do Açaí tem só `acai_no_grau`;
   - a titular não tem valor comercial do Açaí;
   - existem 2 fechamentos (Subway e Açaí), cada um no próprio tenant. Quando houver triagem ou cancelamento em revisão, o status esperado é **PRELIMINAR**, com pendências listadas; CONSOLIDADO só sem pendência;
   - as contagens de base fora de `foody_*` estão **idênticas** (Parser, Checklist, fila de notificações).
4. Paridade só leitura: `FOODY_PARIDADE_CONN=… node backend/scripts/foody-paridade.mjs --unidade 00000000-0000-0000-0000-0000000000a1 --de D --ate D --saida <arquivo novo>`. Classificar cada divergência por categoria: taxa (soma da diferença), cancelamento, triagem, só de um lado e limitações da API.
5. **Desligar** `FOODY_CENTRAL_ENABLED` (voltar a ausente) no mesmo dia. As linhas ficam como histórico, sem consumidor.

**Critérios de interrupção (qualquer um → passo 5 imediatamente, sem nova sincronização)**
- A execução FALHOU com um código diferente de NAO_EXECUTADO/LIMITE esperado, ou houve 401 (token): a conexão fica marcada, e não se insiste.
- Um uid aparece ativo em dois tenants, ou há dado do Açaí na titular além do mínimo, ou dado da Subway no Açaí.
- Há escrita fora de `foody_*`: qualquer contagem de base mudou.
- Algum item novo na fila de notificações, ou algum log de Parser/relatório lendo Foody.
- Erro 5xx na tela, reinício do serviço ou memória perto do limite.
- O fechamento sai CONSOLIDADO **com** pendência (violaria A12).

**Recuperação**
- Desligar `FOODY_CENTRAL_ENABLED` (e o compartilhamento) deixa o sistema inerte de novo.
- Dados errados em `foody_*` não são apagados no improviso. A correção é uma nova versão (CORRIGIDO, com motivo) depois do ajuste, ou uma limpeza **à parte, autorizada e com backup**. Nenhum consumidor lê essas linhas enquanto PARSER e RELATORIO estiverem desligados.
- 150: `kit150.mjs recuperar`. Código: rollback do deploy para `cd38e4c` (as migrations 147–150 continuam compatíveis com o código antigo).

**Aceite do dia 1:** conferências do passo 3 todas OK, e paridade PARIDADE ou DIVERGENTE só com divergências explicadas (triagem, limitações declaradas, cancelamento com justificativa). Taxa logística divergente sem explicação reprova o dia.

## Ativação depois do dia 1 (cada passo exige decisão própria)
| Passo | Ação | Pré-condição | Rollback |
|---|---|---|---|
| 2 | Repetir a sincronização manual por 3–7 dias | dia 1 aceito | ENABLED off |
| 3 | `FOODY_CENTRAL_AGENDADOR_ENABLED=true` | dias manuais estáveis e paridade aceita | flag off (parada segura) |
| 4 | `FOODY_CENTRAL_PARSER_ENABLED` + unidades (Subway, depois Açaí) | agendador estável | flag off (Parser idêntico) |
| 5 | `FOODY_CENTRAL_RELATORIO_ENABLED` + unidades; conferir a fila antes de liberar o envio | passo 4 + destinatários e papéis conferidos | flag off (mensagem original) |

## GO / NO-GO
| Item | Decisão |
|---|---|
| Publicação coordenada (merge #79→#82 + deploy, flags inalteradas) | **GO técnico**: falta só a autorização |
| Aplicação da 150 pelo kit (com backup) | **GO técnico**: pré-voo de produção PASS |
| 1º dia real: 1 sincronização manual, compartilhamento ligado, em sombra | **GO condicionado** a P1–P8 e aos requisitos acima |
| Agendador | **NO-GO** até dias manuais estáveis + paridade aceita |
| Parser / Dashboard | **NO-GO** até o agendador estável |
| Checklist / WhatsApp | **NO-GO** até o passo 4 + conferência de destinatários |

## Regressão
Preenchida na revisão integrada (ver o relatório no PR #82).
