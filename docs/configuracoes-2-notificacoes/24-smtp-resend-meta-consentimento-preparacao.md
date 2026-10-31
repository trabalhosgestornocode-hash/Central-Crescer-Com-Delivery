# 24 — Preparação final: SMTP (Resend), Meta Cloud API e termo de consentimento

Nada foi contratado, configurado ou enviado. DNS não foi alterado.

## 1. Resend + Supabase Auth (convites)
**Requisitos verificados na [página de preços do Resend](https://resend.com/pricing)** (31/10/2026): plano gratuito = 100 e-mails/dia, 3.000/mês e 3 domínios; SMTP incluído em todos os planos; Pro US$ 20/mês (50 mil e-mails, sem limite diário). Convites são poucos por dia: o plano gratuito basta para começar (**o limite de 100/dia vale também para recuperação de senha/confirmações enviadas pelo mesmo SMTP** — reavaliar se o volume crescer).
**Configuração (a fazer só com autorização e credenciais):**
1. Resend → Domains → adicionar um **subdomínio** de envio (sugestão: `envio.centralcrescercomdelivery.com.br`, isola a reputação do domínio principal). O Resend mostra os registros SPF (TXT), DKIM (CNAME/TXT) e MX de retorno; **quem administra o DNS os cadastra** (não alterei DNS). Recomendado também DMARC (`_dmarc`, `p=none` no início).
2. Resend → API Keys → chave com permissão **somente de envio**, restrita ao domínio.
3. Supabase (primeiro o projeto de teste) → Authentication → SMTP: host `smtp.resend.com`, porta 465, usuário `resend`, senha = chave de API, remetente `convites@envio.centralcrescercomdelivery.com.br`. Em Rate Limits, ajustar o limite de e-mails/hora (o padrão do Supabase com SMTP próprio é baixo).
4. Authentication → URL Configuration: Site URL = `https://centralcrescercomdelivery.com.br`; Redirect URLs inclui `https://centralcrescercomdelivery.com.br/convite-usuario.html`.
5. Email Templates → "Invite user": texto em português do doc 21 §1 (assunto e HTML prontos). Validade do link do Supabase: conferir (o convite do nosso lado vale 72 h).
6. Render (somente depois do teste): `USUARIOS_CONVITE_EMAIL=supabase`.
**Homologação (destinatário de teste autorizado):** chegada e remetente; o link preserva `#t=<token>` depois que o Supabase anexa a sessão (a página `/convite-usuario.html` já junta os fragmentos `#t=…#access_token=…`; confirmar na prática); senha definida pelo convidado; reabrir = "já usado"; expirado (>72 h) recusado; e-mail divergente recusado; SMTP errado → 502 e convite revogado.

## 2. Meta WhatsApp Cloud API (OTP)
**Verificado na [documentação oficial de preços](https://developers.facebook.com/docs/whatsapp/pricing):** cobrança em **BRL** para contas elegíveis (disponível desde 01/07/2026; migração obrigatória das contas até 30/06/2027); tarifas por mensagem em tabela por mercado e categoria (Brasil é mercado próprio; autenticação tem faixas de volume que reiniciam todo mês). **O valor em reais da autenticação no Brasil está só no arquivo de tarifas (CSV/PDF) da Meta e não foi lido por esta preparação** — o valor ≈ US$ 0,0068 do doc 21 é de terceiros; o orçamento deve usar o arquivo oficial. Requisitos de verificação de empresa **não constam** nessa página: confirmar no painel da Meta ao criar a conta.
**Checklist de contratação (responsável):** Business Manager da empresa → conta WhatsApp Business (WABA) → número dedicado (não pode ser o número do gateway Baileys do D-1) → modelo de **autenticação** (nome sugerido `codigo_verificacao`, pt_BR, botão "copiar código") aprovado → usuário do sistema com token permanente → App Secret e Verify Token do aplicativo.
**Variáveis (nomes, no Render, só na ativação):** `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, `WHATSAPP_CLOUD_TOKEN`, `WHATSAPP_CLOUD_TEMPLATE_OTP`, `WHATSAPP_CLOUD_TEMPLATE_LANG`, `WHATSAPP_CLOUD_API_VERSION`, `WHATSAPP_CLOUD_APP_SECRET`, `WHATSAPP_CLOUD_VERIFY_TOKEN`, `NOTIFICACOES_OTP_TRANSPORTE=oficial`, `NOTIFICACOES_OTP_OFICIAL_AUTORIZADO=true`. Qualquer uma ausente → OTP segue desligado.
**Garantias já provadas:** nenhum import do Baileys; limites de tentativas/reenvio/IP no **banco** (compartilhados entre instâncias); idempotência por desafio; webhook assinado e idempotente (doc 23).

## 3. Termo de consentimento — versão técnica final
O mecanismo já existe (migration 134): `comunicacao_termos` **imutável** (trigger bloqueia update/delete), versão inteira, `hash = sha256(texto)` verificado por CHECK, `rascunho` boolean; cada consentimento no livro-razão grava `termo_versao` + `termo_hash` + data + categoria + IP/origem (prova do aceite) e a revogação é um novo registro (histórico preservado). A v1 é rascunho de simulação.
**Para publicar a versão jurídica:** inserir a linha `versao = 2` com `rascunho = false` **somente após aprovação** (nenhuma migration insere o texto; é um ato de dados com revisão). Trava adicionada nesta branch (`consentirConvite`): fora da simulação, com termo rascunho ou ausente, o consentimento é recusado com 409 `TERMO_NAO_APROVADO` e nada é gravado (teste incluído). Antes desta trava `rascunho` só era repassado à tela. Nenhum consentimento real foi registrado.
Texto pendente de revisão: doc 22 §4.
