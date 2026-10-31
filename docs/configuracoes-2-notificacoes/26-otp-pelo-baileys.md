# 26 — OTP pelo Baileys (decisão definitiva) — implementação, evidências e plano de ativação

Substitui, para o OTP, a rota Meta/Cloud API dos docs 21–25. O adaptador da Meta (PR #57) e a migration 137/webhook (PR #58) ficam instalados e **inativos**; nada é revertido. Meta, número dedicado, token e tarifa deixam de ser dependências.
**Nada deste documento está em produção:** branch `feat/central-otp-baileys`, PR aberto, sem merge, sem migration 138 em produção, sem variável alterada.

## 1. O "Erro interno" do 503 (investigado)
`pedirCodigoConvite` → segredo presente → `capacidades().otp = false` → `ApiError(503, …, { codigo: "VERIFICACAO_INDISPONIVEL" })` = **desligamento intencional**. O `errorHandler` troca a mensagem de TODO erro 5xx por "Erro interno" em produção e só repassa `err.codigo`, mas o código de negócio vive em `err.details.codigo`: o 503 intencional ficava indistinguível de uma falha real. Correção: 503 com `details.codigo` no vocabulário `^[A-Z0-9_]{1,40}$` devolve `{ error, codigo }` (mensagens nossas, sem detalhe técnico); qualquer outro 5xx continua mascarado (provado em processo filho com `NODE_ENV=production`: erro com string de conexão não vaza; 503 sem código continua genérico; código fora do vocabulário não é refletido).

## 2. Desenho
```
Gestor cadastra destinatário → convite (token) → titular abre a página → pede o código
  → criarDesafio (banco: 60 s, 5/h e 10/dia por número HMAC, 20/h por IP HMAC, 5 min, 5 tentativas, uso único)
  → entregarCodigoOtp [modo baileys] → comunicacao.otp.js
      1. lista autorizada (se definida)                 → fora dela: nada acontece
      2. comunicacao_otp_reservar (banco, atômico)      → dedupe + cota própria + prioridade do D-1
      3. whatsapp.service#enviarTexto                   → kill switch do modo global + conta confirmada → gateway Baileys
      4. comunicacao_otp_registrar_resultado            → ENVIADO | FALHOU | INCERTO (motivo de vocabulário fixo)
  → titular digita o código → verifica o telefone → (termo APROVADO) consente → escolhe categorias
```
- **Fila lógica/cota próprias:** `comunicacao_otp_envios` (migration 138): 1 desafio = 1 reserva; limites por hora (30), dia (150) e simultâneos (3), ajustáveis por `NOTIFICACOES_OTP_MAX_HORA|DIA|SIMULTANEOS`. Não lê nem escreve a fila ou as cotas do D-1.
- **Prioridade do D-1:** o OTP adia (`AGUARDE 60 s` ao titular) se há D-1 em `PROCESSING/SENDING` nos últimos 90 s ou recém-vencido (<2 min). Backlog antigo/parado e agendamento futuro **não** bloqueiam (sem inanição).
- **Código:** 6 dígitos de CSPRNG (já existia), em claro só na memória da requisição; no banco só HMAC. Validade 5 min, uso único, 5 tentativas, reenvio ≥ 60 s (banco).
- **Falhas:** provado pré-envio (gateway desconectado, número sem WhatsApp, modo DISABLED, conta não confirmada) ⇒ `FALHOU`; timeout/5xx/conexão cortada ⇒ `INCERTO` e **nunca reenvio automático** (o desafio segue válido; o titular pede outro depois de 60 s). Falha ao gravar o resultado não derruba o envio.
- **Privacidade:** logs só com id do desafio e motivo; número decifrado apenas em `envio.js` e passado em memória; o gateway ignora o eco `fromMe` e não guarda texto de envios próprios; nada de OTP em `comunicacao_mensagens`.
- **Legados:** nenhum caminho automático — o OTP só nasce de convite/gestão iniciados por pessoa; o CHECK da 134 continua impedindo categorias novas para LEGACY_ACTIVE; teste arquitetural garante que só `notificacoes.envio.js` usa a ponte.
- **Gateway:** **não foi alterado** (nenhuma linha em `gateway-whatsapp/`).

## 3. Ativação (variáveis; tudo desligado por padrão)
`NOTIFICACOES_OTP_TRANSPORTE=baileys` **e** `NOTIFICACOES_OTP_BAILEYS_AUTORIZADO=true` **e** `WHATSAPP_GATEWAY_URL/SECRET` (já existentes). Opcional `NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164` (números autorizados separados por vírgula — usar na homologação real). Convites: `NOTIFICACOES_CONVITES_HABILITADOS=true` só quando o termo estiver aprovado.

## 4. Evidências (sintéticas, sem envio real)
| Camada | Resultado |
|---|---|
| `notificacoes-otp-baileys.test.js` (provider falso + whatsapp.service REAL) | 21/21: 3 chaves de modo; sucesso com chave `otp:<desafio>`; 6 chamadas simultâneas = 1 envio; cota/saturação/prioridade D-1 sem envio; reserva indisponível = fail-closed; kill switch e conta não confirmada; gateway ausente; desconexão; número sem WhatsApp; incerto/timeout sem reenvio; resultado imutável; lista autorizada; dados inválidos; logs sem número/código/segredo; AGUARDE/LIMITE ao titular; termo rascunho nunca consente; 503 intencional × falha real; arquitetura |
| PostgreSQL descartável `testes-seguros/pg/otp_baileys_138.sh` (cadeia real 132–137 + 138) | 38/38: reaplicação; 8 sessões no mesmo desafio = 1 linha; 8 desafios com limite 3 = exatamente 3; cota hora/dia; reserva antiga fora da cota; prioridade D-1 (futuro/backlog antigo/SENDING antigo/SENT não bloqueiam; vencido/SENDING/PROCESSING bloqueiam); fila do D-1 inalterada; estado final imutável; limites inválidos; anon/authenticated sem acesso; service_role sem delete/update fora de status/motivo; cascata; rollback e rollback idempotente |
| Já existente (103/103 no harness 132–136) | OTP/consentimento/revogação imediata/D-1 idêntico |
Regressão completa comparada à `main`: ver o PR.

## 5. Teste real (NÃO executado — exige autorização)
`backend/testes-seguros/homologacao/otp_baileys_real.mjs`: 1 código a 1 número expressamente autorizado (nunca cliente), mesmo caminho do produto, reservas em memória (não toca no banco), número mascarado, código não impresso. Recusa sem `OTP_REAL_AUTORIZO=SIM` e com mais de um número. Pré-requisitos: gateway conectado, conta confirmada, modo ≠ DISABLED, nenhum D-1 em envio.

## 6. Consentimento (texto para revisão jurídica — v2 rascunho; NÃO inserido)
Separado da verificação do telefone (verificar ≠ consentir). Registro por categoria no livro-razão com `termo_versao` + `termo_hash` + data + origem; revogação = novo registro (histórico preservado); `comunicacao_termos` é imutável. Consentimento real com termo rascunho/ausente: **409 TERMO_NAO_APROVADO** (PR #59, já em produção). Texto em `22-…md §4`; ao aprovar, inserir a linha `versao = 2, rascunho = false` (ato de dados, com revisão). LEGACY_ACTIVE não ganha categorias novas.

## 7. Bloqueios reais para a experiência completa
1. **Autorização** para: merge do PR, aplicar a migration 138 em produção, e definir `NOTIFICACOES_OTP_TRANSPORTE`/`_AUTORIZADO` (+ allowlist) no Render.
2. **Número autorizado** para o teste real (um aparelho do responsável).
3. **Termo aprovado pelo jurídico** (sem ele ninguém consegue consentir — por desenho).
4. **E-mail de convite** só é necessário para criar CONTA de usuário nova (Resend); o convite de destinatário de notificações é por link/token e **não depende de e-mail**.
