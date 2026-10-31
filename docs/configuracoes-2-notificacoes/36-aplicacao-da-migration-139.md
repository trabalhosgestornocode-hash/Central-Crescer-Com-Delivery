# 36 — Aplicação da migration 139 em produção: pacote, pré-voo, validação e recuperação

**Preparado, NÃO executado.** A aplicação em produção exige a autorização expressa do responsável. Estado de referência: 31/10/2026 13:31 BRT.

## 1. O que a 139 faz — e o que não faz
- Cria **1 função** (`comunicacao_convites_piloto_guard`) e **1 gatilho** `BEFORE INSERT` em `comunicacao_convites`. Só INSERT; nada existente é lido nem alterado.
- **Não liga o piloto:** sem a chave `convites_unidades_piloto` em `comunicacao_configuracoes` o gatilho devolve a linha sem restrição. A migration **não insere** a chave (teste estático).
- **Não ativa convites nem SAIR:** `NOTIFICACOES_CONVITES_HABILITADOS` segue `false` e `NOTIFICACOES_PALAVRA_CHAVE_SAIR` não existe no Render; o gatilho não toca em variáveis.
- **Não toca** no D-1, nas cotas, nos 41 destinatários, nos consentimentos, no termo, no gateway. Único lock: breve, na tabela `comunicacao_convites` (hoje **0 linhas**, desligada); **nenhum** lock em `comunicacao_mensagens`.

## 2. Integridade do pacote
| Arquivo | SHA-256 |
|---|---|
| `database/migrations/139_notificacoes_convites_piloto.sql` | `fa0a02882385da4113248c17a9af59026d30f34640c997f395a8ee12ce3bb056` (sem `\r`) |
| `database/migrations/139_rollback.sql` | `37a173b1fece41e82cc8acd2474639571cce3acb277686bf7caf28a239a4699d` |
Referência da função (cliente **UTF-8**): `md5(pg_get_functiondef(...)) = a79b16190bb2cf6467eb1896504677e5`. Gatilho: habilitado (`O`), tipo 7 (linha, BEFORE, INSERT). Conferir o SHA-256 do blob do PR (`git show origin/<branch>:…`) imediatamente antes de aplicar.

## 3. Pré-voo de produção (somente leitura, 31/10 13:31 BRT) — OK
`postgres`, PostgreSQL 17.6, projeto `uqybgauuxcrqzquultfu` (status `ACTIVE_HEALTHY`); histórico termina em `138_notificacoes_otp_envios`; função e gatilho da 139 **ausentes**; `comunicacao_convites` e `comunicacao_configuracoes` presentes; chave do piloto **ausente**; 0 sessões `idle in transaction`, 0 esperando lock, transação mais longa 0 s, 0 locks pesados em `comunicacao_convites`.
Linha de base para comparar depois: **41 contatos** (hash `ef4696ce17`), categorias hash `69bad89c84`; convites 0, consentimentos 0; reservas de OTP 1 e desafios 1 (evidência do teste de 31/10); fila de hoje sem mudança de composição.
**Repetir o pré-voo imediatamente antes de aplicar**; adiar se houver lock, sessão presa ou D-1 em `SENDING` (não é necessário para a 139, mas é a regra do ritual).

## 4. Backup e recuperação
- **Backup disponível:** backup físico diário do Supabase de **31/10 14:14 UTC** (anterior à 138; a 139 é aditiva e independente dela) — conferir o mais recente no painel no dia (haverá um de 01/11). Mais os dumps cifrados `age` de 31/10 00:22 UTC.
- **Recuperação (não destrutiva):** `139_rollback.sql` (remove o gatilho e a função; idempotente; nada depende deles). Sem PITR; restauração física só como último recurso e com decisão sua. **Sem rollback automático** em caso de divergência: parar e relatar.

## 5. Aplicação (quando autorizada)
1. Repetir o pré-voo (§3) e conferir o SHA-256 (§2).
2. Aplicar **exclusivamente** a 139, num único `apply_migration` com o nome `139_notificacoes_convites_piloto` (UTF-8; sem `begin/commit` se for por MCP).
3. Rodar `backend/testes-seguros/producao/validar_pos_prod_139.sql`: **todos os itens `ok: true`** (função idêntica, gatilho habilitado, sem acesso público, **a chave do piloto continua ausente**, configuração existente intacta, RLS intacta, termo não alterado, 41 destinatários com os mesmos hashes).
4. Comparar com a linha de base (§3). Divergência crítica ⇒ interromper antes do merge do #62.
5. Só então o merge do #62 (com tudo desligado; ver doc 34).

## 6. Evidências já obtidas
PostgreSQL descartável **25/25** (inclui `null` e número no array do piloto, revogação do SAIR isolada por número e rollback idempotente); **Supabase de teste**: aplicada, hash idêntico, todos os formatos inválidos recusados, transação desfeita sem resíduo; validador pós-aplicação **10/10** na cadeia de referência.
