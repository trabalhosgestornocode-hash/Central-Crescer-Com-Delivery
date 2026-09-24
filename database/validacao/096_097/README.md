# Validação das migrations 096 e 097 (Postgres real de TESTE)

**Somente em banco DESCARTÁVEL de teste — nunca em produção.** Os scripts criam e apagam dados com prefixo `ZZVAL`/UUIDs `…0096…` (inclui `auth.users`).

Ordem (psql, `-v ON_ERROR_STOP=1`):

1. `catalogo_fingerprint.sql` → salvar a saída ordenada como *baseline* (estado sem 096/097).
2. `096_comunicacao_central_conversas.sql` → `seed.sql` → `test096.sql` (53 verificações, tudo em transação com rollback; 0 FAIL esperado).
3. `097_whatsapp_conexao_identidade.sql` → `test097.sql` (54 verificações; 0 FAIL).
4. `097_rollback.sql` → conferir que o catálogo voltou ao estado pós-096 → `096_rollback.sql` → conferir que voltou ao *baseline* (diff vazio).
5. Reaplicar 096 e 097. `cleanup.sql` remove os dados de teste.

Os testes cobrem constraints, RLS com `SET ROLE anon/authenticated/service_role` (inclusive "grant acidental"), grants/EXECUTE, isolamento entre organizações, idempotência, retenção/purga, trava de operação e identidade. A concorrência (8 sessões simultâneas) foi validada com 8 processos `psql` em paralelo.
