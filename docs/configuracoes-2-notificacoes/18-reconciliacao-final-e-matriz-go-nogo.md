# 18 — Reconciliação final do PR #55 e matriz GO/NO-GO (30/10/2026, 23:50 UTC)

Somente leitura em produção. Nada foi escrito em produção.

## 1. Estado do repositório

| Item | Valor |
|---|---|
| `main` | `9da8210` (inalterada; a branch tem a `main` como ancestral, sem conflito) |
| HEAD remoto do PR #55 | `b76a81a` — OPEN, MERGEABLE, CLEAN; checks: só Vercel (preview protegido por login) |
| HEAD local | descendente linear de `b76a81a`, **4 commits só locais** (não enviados) |
| Só locais | `11ce97a` doc 17 (pré-voo de produção) · `1ec9cae` `aplicar_prod_132_136.sh` + pré-voo final · `4fbd0e8`/`1000cfd` doc 16 (136 e sequência) · + o commit desta reconciliação |
| Migrations/gerador: remoto × local | **sem diferença** (`git diff b76a81a HEAD -- database/migrations backend/testes-seguros/supabase-teste` vazio) |
| 132–135 × o que foi homologado em `d30a830` | idênticas; desde então só foram acrescentados os arquivos 136 |

**Consequência:** o `aplicar_prod_132_136.sh` (que fixa o commit `b76a81a` para as migrations) só existe nos commits locais. Quem for aplicar precisa deles no clone → enviar os commits só de documentação/script ao PR (push exige autorização) ou usar este mesmo clone.

## 2. Pacote 132–136 (produção)

Regenerado agora de `HEAD` com `gerar_pacote.mjs --transacao` (2×, determinístico, 0 `\r`):

| Arquivo | Bytes | SHA-256 |
|---|---|---|
| `pacote_aplicar.sql` | 178.229 | `ecbd2aaa06ad5ae5afdd0e7bfa626beb836c45f55bc94770b0818f1988fe17f5` |
| `pacote_reverter.sql` | 15.436 | `3f9371a904f0fd077c8c4c712615b0eec6821fc853e159a8950134a517dd226e` |

Iguais aos do doc 17 e aos fixados em `aplicar_prod_132_136.sh`. SHA-256 dos arquivos-fonte (16 primeiros): 132 `a1cc3469…`, 133 `475d430f…`, 134 `d33af784…`, 135 `75ac2903…`, 136 `14920af7…`.

**Uma transação preservada**: 1 `begin;`/1 `commit;` fora de texto (os outros 5 pares estão dentro do texto original guardado no histórico, entre `$pacote_registro$`), nenhum `rollback`/`savepoint`, `lock_timeout` 5 s por migration, trava inicial e registro das 5 migrations na MESMA transação. Não há impedimento técnico para a transação única; cinco transações separadas **não** são adotadas.

**O que foi e o que não foi executado no teste (sem inflar):**
- Executado no teste: as migrations 132–135 (pacote `b22f0d01…`, aplicar → reverter → reaplicar) e a 136 (2×, `a226a4ae…`). O conteúdo das migrations é o mesmo.
- **Não executado no teste:** o pacote de produção como um todo (trava + registro no histórico + 136 numa só transação). Foi ensaiado só no PostgreSQL local da cadeia real da main (95/95) e o formato da linha de histórico foi aceito pela tabela real do teste numa transação desfeita.
- Histórico: formato conferido hoje contra produção (`version`, `statements` de 1 elemento, `created_by` texto livre, `idempotency_key` nula, colunas idênticas às do teste); 25 linhas, última `20261030063708`, **0** de 132–136. O teste **não** registra 132–136 (17 linhas) — escrita não autorizada.

## 3. Backup-base (painel de produção, lido agora, sem clicar em Restore)

| Item | Resultado |
|---|---|
| Backups diários (físicos) | 9 listados; o último **30/10/2026 14:17:16 UTC**; anteriores diários (29/10 14:44 e 14:14, 28/10, 27/10…) |
| Restore | botão disponível em todos (não exercitado: restaurar sobrescreve o projeto inteiro) |
| PITR | **não habilitado** (add-on pago) |
| Dump complementar | `C:\Users\ponte\backups-prod\pr55-132-136\` (4 tabelas + esquema `public`, cifrados com `age`, fora do Git; restauração testada no PostgreSQL local: contagem e hash idênticos), de 30/10 ~19:35 UTC |

**Avaliação:** a existência, a data e a oferta de restauração do backup diário estão comprovadas; a restauração **efetiva** não foi exercitada (e não deve ser). Como não há PITR, o backup do painel é o último recurso e restaura **tudo** (perde dados posteriores); a recuperação cirúrgica é o `pacote_reverter.sql` + os dumps. Na janela: reconferir a lista (deve haver o backup de 31/10 ~14:17 UTC) e refazer o dump das 4 tabelas, porque o de 30/10 já terá ficado velho.

## 4. Render

O conector do Render desta sessão só enxerga o workspace "Atlaz Company" (mabruk-acai, atlaz-imobiliario, Sistema-SUED), **não** o `crescercomdelivery`. Reconfirmação possível agora: `render.yaml` do repositório (`buildCommand: cd backend && npm ci`; `startCommand: cd backend && exec node src/server.js`; sem hook de migration), `/health` público 200 e o frontend no ar sem os arquivos novos. O registro do doc 17 (`autoDeploy: yes`, gatilho `commit`, branch `main`, deploy `dep-dbi3mo142hec73f73jlg` = `9da8210`) vem de leitura anterior; **não reconfirmado hoje** no painel do serviço.
Nenhum comando de build/start executa migrations; o código lê só as tabelas/colunas novas dentro de tratamento de erro.

## 5. Janela

Calendário: 31/10 sáb, **01/11 dom**, 02/11 seg (Finados), 03/11 ter. Pela configuração (janelas `dom` sem envio; reforço "não domingo" em `comunicacao.alertas.service.js`) o **domingo 01/11 não tem envio do D-1** — a janela mais segura: sem lote das 10h/11h nem reforço das 20h durante a aplicação. Alternativa (doc 17): dia útil 07:00–07:45 BRT, antes das 08:00. Em qualquer caso, só aplicar com `SCHEDULED` = 0 ou nenhum vencendo em 30 min, e fazer o merge **depois** da validação.

## 6. Comparação antes/depois (obrigatória na janela)

Antes (agora, linha de base de produção) e depois devem ser iguais, exceto o previsto:

| Grupo | Linha de base (hoje 23:47 UTC) | Depois |
|---|---|---|
| Destinatários D-1 | `comunicacao_destinatario_categorias` `5c5835a8…`:41; contatos da empresa 41 (`6f34c643…`); `contatos_whatsapp` 29 (`d1302187…`) | iguais |
| Mensagens | CANCELLED 303, DELIVERED 698, SENT 131, READ 107 | só mudam pelo worker (aplicação não toca) |
| Cotas / expiração / idempotência | `comunicacao_reservar_envio` `0b6386a2…`; índice único de idempotência | iguais |
| Funções | agendamento `f37bf6e1…` → **`7b7c0a59…`** (única mudança prevista); resolvedor `accc3bc6…`, cota `0b6386a2…`, remapeamento `31426ffd…` | só o agendamento muda |
| Permissões | anon/authenticated sem as 7 tabelas e sem as 24 funções novas; `unidades_validar_fuso_horario` só do dono | `validar_pos_prod_132_136.sql` 18/18 |
| M3 | chave `selecao_por_escopo` ausente | ausente; snapshot e escopos vazios |
| Histórico | 25 linhas | 30 linhas (132–136) |

## 7. Recuperação (nenhuma reversão automática)

- **Antes do COMMIT** (erro, lock de 5 s, queda): o PostgreSQL desfaz tudo. Conferir com o pré-voo que não há 132–136, 0 registros no histórico e funções de referência iguais; investigar e repetir só com nova autorização.
- **Depois do COMMIT** (validação com item `ok:false`): congelar, **não** fazer o merge, guardar o JSON, investigar. O código no ar (`9da8210`) funciona com 132–136. Reversão só por decisão explícita: `pacote_reverter.sql` (136→132 e remove o histórico), depois de exportar as tabelas novas que tiverem linhas.
- **Depois do deploy:** primeiro o código — deploy anterior (`9da8210`) no Render ou `git revert -m 1 <merge>`; preservar as tabelas novas; reverter migrations é decisão separada.
- **Último recurso:** backup diário do painel (restaura o projeto inteiro).

## 8. Condições de interrupção

Interromper e não escrever (ou parar e congelar) se: lock esperando nas tabelas-alvo ou "idle in transaction"; `SCHEDULED` vencendo em 30 min; qualquer hash de referência diferente do pré-voo; 132–136 já registradas ou objetos já presentes; SHA-256 do pacote diferente; `\r` no pacote; lista de backups sem o do dia ou sem Restore; dump refeito sem sucesso; `main` diferente de `9da8210`; qualquer item da validação pós-aplicação com `ok:false`.

## 9. Matriz GO/NO-GO

| Condição | Estado |
|---|---|
| Código/PR (`b76a81a`, mergeável) e `main` `9da8210` | OK |
| Pacote × migrations homologadas, SHA-256 | OK (`ecbd2aaa…` / `3f9371a9…`) |
| Uma transação, trava e histórico | OK |
| Pacote de produção executado no teste | **Não** (ensaio local 95/95) |
| Backup diário (data, Restore) | OK — 30/10 14:17 UTC; restauração efetiva não exercitada; sem PITR |
| Dump complementar restaurável | OK (refazer na janela) |
| Produção limpa, funções de referência, sem locks | OK agora |
| Render (autoDeploy) | **Não reconfirmado hoje** (conector sem acesso ao serviço) |
| Variáveis / SMTP | Nenhuma exigida para aplicar |

**Decisão técnica: GO condicionado para a escrita das migrations** — somente se, no início da janela, (1) o pré-voo e a lista de backups forem repetidos com o mesmo resultado, (2) o dump das 4 tabelas for refeito, (3) o painel do Render confirmar `autoDeploy`/branch, e (4) você autorizar com suas palavras. **NO-GO** para o merge até as migrations estarem validadas em produção. Sem a autorização expressa, mantém-se NO-GO para qualquer escrita.
