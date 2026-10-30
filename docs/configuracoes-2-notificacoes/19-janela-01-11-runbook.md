# 19 — Janela de implantação: domingo 01/11/2026, 07:00–07:45 BRT (10:00–10:45 UTC)

Preparação. **Nenhuma escrita em produção foi feita.** Cada etapa de escrita só acontece com autorização expressa do responsável.
Commit do pacote: `b76a81a` (migrations idênticas em todos os commits posteriores). PR #55 em `3620a91`.

## Por que domingo
Janelas `dom` sem envio na configuração do D-1 e reforço "não domingo" (`comunicacao.alertas.service.js`): nenhum lote (10h/11h) nem reforço (20h) coincide com a aplicação.
Verificação obrigatória na hora (não presumir): fila sem `SCHEDULED`/`PROCESSING`/`SENDING`, ou nenhuma com `disponivel_em` antes de 08:30 BRT.

## Condições obrigatórias × estado hoje (30/10) × o que fazer na janela

| # | Condição | Estado hoje | Na janela |
|---|---|---|---|
| 1 | Pré-voo imediatamente antes | feito em 30/10 (doc 17/18) | `bash aplicar_prod_132_136.sh prevoo` (só leitura, sessão `read_only`) logo antes |
| 2 | Backup e recuperação | painel: backup diário de 30/10 14:17 UTC, Restore disponível, **sem PITR**; dumps de 30/10 19:34 UTC restauráveis | reabrir Database → Backups; deve existir o de 31/10 (~14:17 UTC); registrar data/hora |
| 3 | Dump complementar das 4 tabelas | de 30/10 (velho na janela) | `bash dump_prod_4tabelas.sh` (read-only, cifrado com `age`); conferir `.sha256` e `.hashes.txt` = hashes do pré-voo |
| 4 | Render: auto-deploy e branch | **confirmado hoje no painel**: repo `Central-Crescer-Com-Delivery`, branch `main`, root `backend`, build `npm ci`, **pre-deploy vazio**, start `node src/server.js`, Auto-Deploy *On Commit*, health `/health`, PR Previews **Off** | reconfirmar a tela de Settings; deploy vigente `9da8210` |
| 5 | Conflito com D-1 | linha de base registrada (doc 18 §6) | consulta de fila na janela (acima); parar se houver envio vencendo |
| 6 | Hashes e uma transação | `ecbd2aaa…` / `3f9371a9…`; 1 `begin`/1 `commit`; `\r`=0 | `aplicar_prod_132_136.sh pacote` regera e confere |
| 7 | Histórico | pacote registra as 5 migrations na mesma transação; formato igual ao de produção; hoje 25 linhas, 0 de 132–136 | depois: 30 linhas; `validar` confere |
| 8 | M3 desligada e notificações atuais | chave ausente; D-1 equivalente | `validar` (18 itens) + comparação de hashes de destinatários/mensagens |

## Cronograma (BRT)

| Hora | Ação | Quem | Escrita? |
|---|---|---|---|
| 06:30 | `pacote`, `prevoo`, lista de backups, Render Settings, consulta de fila, `dump_prod_4tabelas.sh`; relatório de GO/NO-GO | agente (leitura) + operador (terminal com `PROD_CONN`) | não |
| 06:50 | **Decisão do responsável**: autoriza (ou não) a aplicação com palavras próprias | responsável | — |
| 07:00 | `PROD_AUTORIZO=SIM PROD_BACKUP_CONFIRMADO=SIM bash aplicar_prod_132_136.sh aplicar` (pacote + pré-voo como portão + UMA transação + validação) | **operador** no próprio terminal | **sim** |
| 07:10 | `validar` e `prevoo` pós: 18/18 `ok`, hashes de destinatários/contatos/configuração iguais, só o agendamento mudou (`7b7c0a59…`), 30 linhas no histórico | agente (leitura) | não |
| 07:20 | Decisão separada sobre o **merge** (deploy automático). Só se 07:10 estiver 100% | responsável | — |
| 07:25–07:45 | Se houve merge: `/health`, deploy `live` no commit do merge, arquivos novos servidos, log sem erro | agente | não |
| 2ª 10h | Observar o D-1 de segunda 02/11 (10h/11h): mesma quantidade de destinatários e mensagens da véspera | agente | não |

Sem pressa de merge: se 07:45 chegar sem tudo verde, **para-se** e o merge fica para outra janela.

## Interrupção (não aplicar / não fazer merge)

Lock esperando ou "idle in transaction" nas tabelas-alvo · envio do D-1 vencendo na janela · qualquer hash de referência diferente · 132–136 já registradas ou objetos já presentes · SHA-256 do pacote diferente ou `\r` · backup do dia ausente ou sem Restore · dump refeito sem sucesso ou hashes diferentes do pré-voo · `main` ≠ `9da8210` · Render com `autoDeploy`/branch/pre-deploy diferentes do esperado · qualquer item da validação com `ok:false`.

## Recuperação (nada automático)

- **Antes do COMMIT:** o PostgreSQL desfaz tudo; conferir com `prevoo` que não ficou nada; investigar.
- **Depois do COMMIT, validação falhou:** congelar, sem merge. O código atual (`9da8210`) convive com 132–136. Reverter só por decisão explícita: `pacote_reverter.sql` (136→132 e remove as 5 linhas do histórico), exportando antes as tabelas novas que tiverem linhas.
- **Depois do deploy:** primeiro o código (Render → Events → deploy anterior → Rollback; depois `git revert -m 1 <merge>`). Preservar as tabelas novas.
- **Último recurso:** backup do painel (restaura o projeto inteiro) ou os dumps cifrados.

## Fora desta janela (sem autorização)

Variáveis (`APP_URL_PUBLICA`, `NOTIFICACOES_SEGREDO_MESTRE`), SMTP, ativação da Central, M3, novos tipos de notificação, gateway WhatsApp.

## Limites desta preparação

`dump_prod_4tabelas.sh` foi testado só nas travas (4 recusas); o caminho feliz repete o procedimento manual de 30/10 e deve ser conferido no pré-voo da janela. O pacote de produção inteiro não foi executado no teste (ensaio local 95/95).
