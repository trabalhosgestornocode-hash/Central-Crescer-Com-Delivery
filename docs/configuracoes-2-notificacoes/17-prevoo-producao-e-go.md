# 17 — Pré-voo de PRODUÇÃO das migrations 132–136 e decisão GO/NO-GO (30/10/2026)

Somente leitura. Nenhuma escrita em produção, nem teste com ROLLBACK. Produção = `uqybgauuxcrqzquultfu`.

## 1. Como foi lido

`psql` com a sessão aberta em `default_transaction_read_only=on`, `statement_timeout=30s`, `lock_timeout=2s` e
`idle_in_transaction_session_timeout=60s`, por um invólucro que só aceita o host direto `db.uqybgauuxcrqzquultfu.supabase.co:5432`
(ou o pooler de sessão), recusa o ref de teste e a porta 6543 e nunca imprime a conexão. Consultas versionadas:
`backend/testes-seguros/producao/prevoo_prod_132_136.sql` (ensaiada antes no teste). Evidência: `evidencias/producao/prevoo-prod-2026-10-30.json`
(só hashes, contagens e configuração; sem telefone, nome ou conteúdo).

## 2. Resultado

| Item | Produção | Situação |
|---|---|---|
| Identidade | `postgres`, PostgreSQL **17.6**, primário (não réplica), `system_identifier` `7656985631…` (≠ teste `7678069749…`), 257 MB | OK |
| Migrations | 25 registradas, última `131_checklist_metas_transferencia_unidade` (20261030063708); **0** de 132–136 registradas. 120–128 aplicadas pela ferramenta antiga (`prod-migrar*.mjs`, que não registra) | OK |
| Ausência de 132–136 | 0 das 7 tabelas, 0 das 24 funções novas, 0 dos 9 gatilhos, 0 das 9 colunas, sem a chave `selecao_por_escopo` | OK |
| Funções de que o pacote depende | agendamento = 104 da main (`f37bf6e1…`), resolvedor `accc3bc6…`, cota `0b6386a2…`, remapeamento `31426ffd…` — **iguais às referências homologadas**; transferência `9c522caa…` = a do teste | OK |
| `unidades` | 53 linhas (48 ativas); gatilhos `desenvolvimento_transferir_escopo`, `trg_und_upd`, `trg_unidades_guarda_financeiro`; política `rls_unidades_tenant` (igual ao teste — o achado da 136 vale para produção) | OK |
| Financeiro | 14 tabelas, regra da 126 ativa em `gfc_validar`, guarda de `unidades` presente. 132–136 não tocam o Financeiro; a guarda e o gatilho da 136 são independentes (transferência homologada com a guarda presente) | Compatível |
| Sessões e bloqueios | 13 conexões (PostgREST 5, realtime 3, pg_net, exporter…), **0** "idle in transaction", transação mais longa 0 s, **0** locks nas tabelas-alvo, 0 esperando lock | OK agora (refazer na janela) |
| Agendador do D-1 | Sem `pg_cron` neste banco: o worker do backend agenda. Janelas `seg_sex 08–18`, `sab 08–13`, `dom` sem envio; dados após 10:00, envios após 10:30; `modo` = **NORMAL** (envio real ligado) | Ver janela §5 |
| Fila do D-1 | DELIVERED 690, READ 107, SENT 128, CANCELLED 296, **SCHEDULED 4** (próxima 31/10 11:52 BRT); 324 mensagens do D-1 em 7 dias; última enviada 30/10 11:50 BRT. Envios por hora (BRT, 14 dias): lote às **10h**, complemento às **11h**, reforço às **~20h** | Linha de base |
| Recuperação | `archive_mode=on`, `wal_level=logical`, 865 segmentos de WAL arquivados, último 1 min antes da leitura, **0 falhas** | WAL OK; **backup diário/PITR: confirmar no painel** (§6) |
| Papel `postgres` | sem `statement_timeout` próprio (o pacote não é cortado no meio); `authenticated` 8 s, `anon` 3 s | Fixar 300 s na aplicação |
| Render | `crescercomdelivery`: `autoDeploy: yes`, gatilho `commit`, branch `main`, health `/health`; no ar `9da8210`. `gateway-whatsapp`: `autoDeploy: no` | Merge = deploy |

## 3. Preservação do Dashboard iFood (D-1) — linha de base × critérios da homologação

| Critério | Linha de base em produção | Por que se mantém | Como conferir depois |
|---|---|---|---|
| Destinatários | `comunicacao_destinatario_categorias` 41 (`5c5835a8…`), contatos da empresa 41 (`6f34c643…`), `contatos_whatsapp` 29 (`d1302187…`) | 132–136 não escrevem nessas tabelas; resolvedor intacto; D-1 equivalente por unidade (homologado em todas as unidades do teste) | mesmos hashes + `d1_equivalente_todas_unidades` |
| Mensagens | contagem por status acima; 4 SCHEDULED | nenhuma linha da fila é tocada; o `insert into comunicacao_mensagens` da 133 é o corpo da função | `mensagens_por_status` (só pode mudar pelo worker) |
| Cotas | `comunicacao_reservar_envio` `0b6386a2…`; limites 3/contato/dia e 5/min | função intacta; a cota nova (135) só vale para categorias novas, inativas | `cota_d1_intacta` |
| Horários | janelas e disponibilidade acima | configuração não é alterada (a 133 só ACRESCENTA a chave `selecao_por_escopo`, desligada) | `configuracoes_hash_sem_chave_nova` = `50916c76…` |
| Expiração | TTL padrão do código (24 h; sem linha `ttl_horas`) | intocado | — |
| Idempotência | índice único `comunicacao_mensagens_idempotency_unica` | intocado; a 133 gera as MESMAS chaves (ensaio: mesmas mensagens/chaves/conteúdo/horários) | `agendar_uma_linha` = `7b7c0a59…` |
| Revogação | revogação/reativação pelo Painel ADM | o gatilho novo em `comunicacao_destinatario_categorias` só bloqueia reativação se houver REVOGADO em `comunicacao_consentimentos` — tabela nova, **vazia** → sem efeito até a Central ser ativada | `snapshot_e_escopos_vazios` + consentimentos 0 |
| M3 | — | nasce desligada; ativação travada por variável que não existe em produção | `m3_desligada` |

## 4. Pacote (preparado e validado, NÃO executado)

Gerado de `b76a81a` (migrations idênticas às de `bce1875`): `node backend/testes-seguros/supabase-teste/gerar_pacote.mjs <pasta> --transacao`

| Arquivo | Bytes | SHA-256 |
|---|---|---|
| `pacote_aplicar.sql` | 178.229 | `ecbd2aaa06ad5ae5afdd0e7bfa626beb836c45f55bc94770b0818f1988fe17f5` |
| `pacote_reverter.sql` | 15.436 | `3f9371a904f0fd077c8c4c712615b0eec6821fc853e159a8950134a517dd226e` |

- Determinístico (gerado 2× com os mesmos bytes); **0** `\r`.
- **Uma transação**: fora de strings há exatamente 1 `begin;` e 1 `commit;`, nenhum `rollback`/`savepoint` (os 5 `begin;/commit;` restantes estão dentro do texto original guardado no registro, em `$pacote_registro$…$pacote_registro$`).
- `set local lock_timeout = '5s'` em cada migration (vale para a transação inteira): se uma tabela estiver ocupada, falha limpa em 5 s.
- Trava inicial (recusa se alguma 132–136 já estiver registrada) e registro das 5 no histórico na mesma transação, no formato das 129–131.
- Ferramenta: `psql -v ON_ERROR_STOP=1 -f`, conexão direta 5432 (ou pooler de SESSÃO 5432; nunca o de transação 6543). **Não** usar `apply_migration` (registraria um 6º nome e embrulharia o `begin/commit`). SQL Editor também serve (uma execução).
- Erro em qualquer ponto → o `psql` para e a transação é desfeita (ensaio local: falha no último passo, o registro, deixou 0 tabelas e 0 registros).
- Ensaio local 95/95; homologação no teste (doc 16).

## 5. Janela recomendada

Fora do lote das 10h/11h e do reforço das 20h (BRT), com pouco uso das lojas: **dia útil, 07:00–07:45 BRT** (10:00–10:45 UTC) —
antes da abertura das janelas (08:00) e da disponibilidade dos dados (10:00). Alternativa: 22:00–23:00 BRT. O merge (deploy) logo
depois da validação, para o código novo já estar no ar no lote das 10h, que é a primeira observação.

## 6. Bloqueio para GO

- **Backup:** o arquivamento de WAL está ativo e sem falhas, mas o backup diário (data do último) e a disponibilidade de PITR só
  aparecem no painel (Database → Backups) — conferir e registrar antes de aplicar (o mesmo que a ferramenta antiga exige com
  `PROD_BACKUP_CONFIRMADO=SIM`). Recomendado também um `pg_dump` só leitura das tabelas tocadas (`unidades`, `comunicacao_categorias`,
  `comunicacao_configuracoes`, `comunicacao_destinatario_categorias`) guardado fora do Git.

## 7. Procedimento de implantação (cada passo com autorização própria)

1. Na janela: repetir o pré-voo (`prevoo_prod_132_136.sql`) e guardar o JSON (linha de base imediata). Parar se houver lock nas
   tabelas-alvo, "idle in transaction" ou SCHEDULED vencendo nos próximos 30 min.
2. Gerar o pacote de `b76a81a` e conferir SHA-256 e 0 `\r`.
3. `PGOPTIONS="-c statement_timeout=300000" psql "<conexão direta>" -X -v ON_ERROR_STOP=1 -f pacote_aplicar.sql`.
4. `validar_pos_prod_132_136.sql` (18/18 `ok`) e de novo `prevoo_prod_132_136.sql`: mesmos hashes de unidades (sem as colunas novas),
   destinatários, contatos, configurações (sem a chave nova) e categoria ativa; fila só com mudanças do worker.
5. Merge do PR #55 (deploy automático); `/health` e deploy `live` no commit do merge.
6. Observar o D-1 das 10h e das 20h e 24 h no total: mesma quantidade de mensagens e destinatários da véspera.

## 8. Recuperação

**A. Falha antes do COMMIT** (erro, timeout de lock, queda de conexão): a transação é desfeita pelo PostgreSQL. Conferir com
`prevoo_prod_132_136.sql` que `ausencia_132_136` continua vazia, `ja_registradas_132_136` = 0 e as funções de referência iguais;
investigar a causa e repetir só com nova autorização.

**B. Falha após o COMMIT** (validação com item `ok:false`): **não** reverter automaticamente. Congelar (não fazer o merge), registrar
o JSON da validação, investigar o item e conferir dados e dependências. Se o D-1 estiver em risco, o código no ar (main) segue
funcionando com 132–136 (não lê as colunas novas; a função de agendamento é equivalente). Reversão só com decisão explícita:
`pacote_reverter.sql` (136→132 e remove as 5 linhas do histórico), depois de exportar as tabelas novas que tiverem linhas.

**C. Falha após o merge:** primeiro o **código** — reimplantar o deploy anterior (`9da8210`) no Render ou reverter o merge; o
código anterior convive com 132–136. **Preservar** os dados das tabelas novas (convites, escopos, consentimentos, termos). Reverter as
migrations é decisão separada, só se o problema estiver no banco e depois de exportar essas tabelas.

## 9. Riscos restantes

1. Merge = deploy imediato (Render, `autoDeploy` na main).
2. `ALTER TABLE unidades` pede lock exclusivo por instantes; com `lock_timeout` de 5 s falha limpa se a tabela estiver ocupada (cenário A).
3. 44 funções antigas de produção têm `\r` no corpo (aplicações anteriores pelo editor no Windows) — pré-existente; o pacote não tem `\r`
   e a validação confere as funções novas.
4. Produção tem `desenvolvimento_transferir_escopo` em `unidades`, ausente no teste; o ensaio local (cadeia real da main) tem esse
   gatilho e a transferência passou.
5. Escrita direta nas DEMAIS colunas de `unidades` por membro logado (pré-existente, fora desta frente).
6. 132–136 aplicadas no teste, mas não registradas no histórico do teste.

## 10. Recomendação

**GO condicionado** para aplicar as migrations em produção na janela do §5, assim que o backup do dia for confirmado no painel
(§6). Tudo o que dá para verificar por leitura está conforme: ausência total de 132–136, dependências iguais às homologadas,
nenhuma sessão ou lock que impeça, linha de base do D-1 registrada e pacote determinístico, atômico e com registro.
