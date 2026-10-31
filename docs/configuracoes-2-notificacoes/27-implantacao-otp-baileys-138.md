# 27 — Implantação controlada do OTP pelo Baileys (migration 138 + PR #60)

Estado em 31/10/2026 11:20 BRT. **Nada abaixo foi executado em produção** (a 138 está só no Supabase de teste e em PostgreSQL descartável).

## 1. Revalidação
- PR #60 (`14be851`): `MERGEABLE/CLEAN`, Vercel ok, **contém a `main` atual** (`c178295`, sem drift).
- Compatibilidade código × migration: as chamadas de `comunicacao.otp.repo.js` usam `comunicacao_otp_reservar(p_desafio_id, p_max_hora, p_max_dia, p_max_simultaneos)` e `comunicacao_otp_registrar_resultado(p_desafio_id, p_status, p_motivo)` — assinaturas idênticas às da 138. **Qualquer ordem é segura:** com o OTP desligado (padrão) o código novo nunca chama as funções; a 138 sem o código novo é só uma tabela vazia. Recomendada: 138 → merge.
- Arquivos íntegros: `138_notificacoes_otp_envios.sql` sha256 `96c54654a36504368657d84fa849ffb59c7df136487947d7fbcc8349843fbd0d`; `138_rollback.sql` sha256 `aa3897b4943d1497dd27fe38279326d921675d96180281b64f53129e235d91aa`; sem `\r` (disco = blob do git).
- Regressão do PR: backend 5828 testes/24 falhas (todas pré-existentes, 0 só na branch); frontend 1649/0; PG descartável 38/38; transporte 21/21.

## 2. Homologação no Supabase de teste (`wiqqsxnysbzhcrzrrean`) — FEITA
Aplicada (conteúdo do arquivo sem `begin/commit`). Hashes **idênticos** à referência (gerada em PostgreSQL descartável com a cadeia real, cliente UTF-8): função reservar `62dcba42…`, função resultado `ed17f9aa…`, colunas `5a4b0d50…`, restrições `e3cb198d…`. RLS ligada, 0 políticas, anon/authenticated sem acesso, service_role só select/insert/execute. Teste funcional sintético (T1–T11): reserva, `JA_RESERVADO`, estado final imutável, `LIMITE_ATINGIDO`, `SATURADO`, limites/estado inválidos recusados, **fila do D-1 com hash idêntico antes/depois**, cascata — dados removidos (0 linhas).

> Lição registrada: ao gerar a referência com `psql -f` **sem** `PGCLIENTENCODING=UTF8`, os acentos dos comentários dentro do corpo das funções são regravados e o hash muda. A aplicação em produção é por MCP (UTF-8) e a validação usa os hashes UTF-8.

## 3. Pré-voo de PRODUÇÃO (somente leitura, 11:18 BRT) — OK
Banco `postgres`, PostgreSQL 17.6; histórico termina em `137_notificacoes_webhook_eventos`; `comunicacao_otp_envios` e funções `comunicacao_otp_*` **ausentes**; `comunicacao_desafios_titular` e `comunicacao_mensagens` (colunas `status, disponivel_em, updated_at, expira_em`) presentes; `service_role` existe; 0 sessões `idle in transaction`, 0 esperando lock, transação mais longa 0 s.
**Linha de base:** 41 contatos, hash `ef4696ce17`; 0 desafios, 0 convites, 0 consentimentos, 0 eventos da 137; fila de hoje `{READ 1, SENT 9, CANCELLED 4, DELIVERED 19, SCHEDULED 8}`.
**Repetir o pré-voo imediatamente antes de aplicar** (e adiar se houver sessão presa, lock ou D-1 em `SENDING`).

## 4. Backup e recuperação
- **Backup:** físico diário do Supabase de **31/10 14:14 UTC** (posterior a 132–137), mais os dumps cifrados `age` de 31/10 00:22 UTC (`~/backups-prod/pr55-132-136/`). A 138 **só cria** uma tabela e duas funções (não altera dado existente), então o ponto de volta real é o rollback abaixo; o backup é rede de segurança.
- **Recuperação (não destrutiva por padrão):** `138_rollback.sql` (drop das 2 funções e da tabela; idempotente; nada depende delas). Sem PITR (add-on pago): restauração física só em último caso e com decisão sua.
- **Falha durante a aplicação:** a aplicação é uma transação; se falhar, o PostgreSQL desfaz tudo; conferir a ausência dos objetos e parar (sem rollback automático).

## 5. Aplicação (quando autorizada)
1. Repetir o pré-voo (§3).
2. Aplicar `138_notificacoes_otp_envios.sql` (UTF-8, sem `begin/commit` se for por MCP; um único `apply_migration` com o nome `138_notificacoes_otp_envios`).
3. Rodar `backend/testes-seguros/producao/validar_pos_prod_138.sql`: todos os itens com `ok: true`.
4. Comparar a linha de base (41 contatos / hash `ef4696ce17`; a fila só muda pelo worker).
5. A validação (sem escrita) basta; o teste sintético de reserva com limpeza é opcional.
6. Merge do #60 → deploy → `/health` com `ifoodEvents: active` (≈2 min depois de "Deploy live"); rotas com 401/403; OTP continua desligado (503 com código `VERIFICACAO_INDISPONIVEL`).

## 6. Ativação futura com um único número (NÃO executar sem autorização específica)
No Render, **num único salvamento** (um deploy): `NOTIFICACOES_OTP_TRANSPORTE=baileys`, `NOTIFICACOES_OTP_BAILEYS_AUTORIZADO=true`, `NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164=+55…` (o número de teste) e, opcionalmente, `NOTIFICACOES_OTP_MAX_HORA=5`, `NOTIFICACOES_OTP_MAX_DIA=10`.
`NOTIFICACOES_CONVITES_HABILITADOS` permanece `false`: o teste real usa `otp_baileys_real.mjs`, que não precisa de convite nem de banco.
Efeito: qualquer número fora da lista é recusado antes de qualquer reserva. Reversão: `NOTIFICACOES_OTP_BAILEYS_AUTORIZADO=false` (ou remover).
Pré-condições do envio: gateway conectado, conta confirmada na aba Conexão, modo ≠ DISABLED, nenhum D-1 em envio.
**Necessário de você:** o número de teste (E.164) e a autorização específica.

## 7. Termo v2
`termo-v2-rascunho-para-revisao-juridica.md` (nesta pasta): texto, pendências e procedimento técnico de publicação. **Nada é considerado aprovado** e nada foi inserido.

## 8. D-1
Lote 11:35–11:59 BRT: 8 mensagens `SCHEDULED` às 11:18. O resultado é registrado pelo acompanhamento das 12:17 BRT.
