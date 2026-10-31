# 23 — Webhook de status da Meta + migration 137 (NÃO aplicada em produção)

## O que é
- `database/migrations/137_notificacoes_webhook_eventos.sql`: tabela `comunicacao_provedor_eventos` (chave `provedorId:status` como PK = idempotência; sem telefone, sem corpo, sem texto) + RPC `comunicacao_provedor_registrar_eventos(jsonb)` (`on conflict do nothing`, até 200 itens, atômico). RLS ligada, sem política; só `service_role` (select/insert + execute). Não toca em D-1, cotas, destinatários ou consentimento.
- Rota `GET|POST /api/publico/notificacoes/webhook/whatsapp` (`notificacoes.webhookWhatsapp.js`), montada antes do `express.json()` (assinatura sobre o corpo CRU) **somente se `WHATSAPP_CLOUD_APP_SECRET` existir** — sem a variável a rota não existe (404), como hoje em produção. GET: handshake com `WHATSAPP_CLOUD_VERIFY_TOKEN` (sem token configurado nunca responde). POST: limite por IP → assinatura `X-Hub-Signature-256` (tempo constante; nada é lido do banco antes) → JSON (400) → eventos. Falha de banco → 500 sem detalhe (a Meta reentrega; a gravação é idempotente). Logs: só contagens.
- Fora de escopo (decisão futura): "SAIR" inbound e ligação do `provedor_msg_id` ao desafio OTP.

## Homologação
| Ambiente | Resultado |
|---|---|
| Testes HTTP (servidor real, banco falso) | 8/8: sem segredo=404; handshake certo/errado/sem token; assinatura inválida/adulterada=401 sem tocar o banco; JSON inválido=400; 8 entregas simultâneas=3 chaves; falha de banco=500 sem vazar; payload sem status=200 sem banco |
| PostgreSQL descartável (`testes-seguros/pg/webhook_137.sh`) | 25/25: aplica/reaplica; RLS; 8 sessões simultâneas = 1 linha; 7 negativos com o erro correto; anon/authenticated sem acesso; service_role sem update/delete; rollback e rollback idempotente |
| Supabase de teste (`wiqqsxnysbzhcrzrrean`) | aplicada; RLS on, 0 políticas, anon/authenticated sem privilégio, service_role executa; teste sintético 2→0 + check violado; dados removidos (0 linhas) |

Defeito achado e corrigido na homologação: regex da chave com `{3,260}` excede o limite do PostgreSQL (255); o teste negativo anterior "passava" pelo erro errado, agora exige o erro certo.

## Rollback
`137_rollback.sql` (drop function + drop table, idempotente). Sem dependências. No Render basta remover `WHATSAPP_CLOUD_APP_SECRET` para a rota sumir.

## Aplicação em produção (pendente de autorização)
Backup/ritual das 132–136 (transação única, pré-voo, validações) → aplicar 137 → merge → configurar `WHATSAPP_CLOUD_APP_SECRET` e `WHATSAPP_CLOUD_VERIFY_TOKEN` → cadastrar o webhook no painel da Meta (`https://centralcrescercomdelivery.com.br/api/publico/notificacoes/webhook/whatsapp`).
