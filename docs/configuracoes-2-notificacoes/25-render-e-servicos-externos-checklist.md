# 25 — Checklist: variáveis do Render e serviços externos (nada executado)

## A. Render (`crescercomdelivery`, `srv-d96rl5naqgkc73ccflr0`) — ordem obrigatória
0. **Pré-requisito:** PR #59 mergeado e deployado (sem ele, definir o segredo liberaria a criação de convites).
1. Gerar o segredo: `! bash backend/testes-seguros/producao/gerar_segredo_notificacoes.sh` (nunca exibe o valor; cópia cifrada com `age` em `~/backups-prod/pr55-132-136/`; valor só na área de transferência por 120 s; recusa sobrescrever).
2. Render → Environment → adicionar **em um único salvamento** (um só deploy):
   | Variável | Valor |
   |---|---|
   | `NOTIFICACOES_SEGREDO_MESTRE` | colar da área de transferência |
   | `APP_URL_PUBLICA` | `https://centralcrescercomdelivery.com.br` |
   | `NOTIFICACOES_CONVITES_HABILITADOS` | `false` (explícito; o padrão já é desligado) |
3. Verificação pós-deploy (somente leitura): `/health` 200 e `ifoodEvents` ativo; lista de **nomes** das variáveis; criar convite continua 503 `CONVITES_DESLIGADOS`; D-1 intacto (41 destinatários, fila).
4. Reversão: remover as duas variáveis. **Não rotacionar** o segredo depois que existirem dados cifrados.
Efeito esperado: nenhum envio, nenhum convite possível; só habilita cifra/links para a homologação.

## B. Resend (e-mail de convite)
| Item | Quem | Estado |
|---|---|---|
| Conta Resend (plano gratuito basta: 100/dia, 3.000/mês) | responsável | pendente |
| Subdomínio de envio (sugestão `envio.centralcrescercomdelivery.com.br`) e registros SPF/DKIM/DMARC no DNS | quem administra o DNS | pendente; **DNS não alterado** |
| Chave de API só de envio | responsável | pendente |
| Supabase Auth → SMTP (`smtp.resend.com`, 465, usuário `resend`), Site URL, Redirect URL, template "Invite user" (doc 21), ajuste do limite de e-mails/hora | responsável, primeiro no projeto de teste | pendente |
| Render: `USUARIOS_CONVITE_EMAIL=supabase` | após o teste | pendente |

## C. Meta Cloud API (OTP)
| Item | Quem | Estado |
|---|---|---|
| Business Manager verificado + conta WhatsApp Business (WABA) | responsável | pendente (requisitos de verificação: confirmar no painel) |
| Número dedicado (diferente do número do gateway Baileys do D-1) | responsável | pendente |
| Modelo de **autenticação** pt_BR aprovado (ex.: `codigo_verificacao`) | responsável | pendente |
| Usuário do sistema + token permanente; App Secret; Verify Token (valor escolhido por você) | responsável | pendente |
| Tarifa BRL de autenticação do Brasil (arquivo oficial de tarifas) e orçamento | responsável | pendente |
| Webhook: URL `https://centralcrescercomdelivery.com.br/api/publico/notificacoes/webhook/whatsapp` | após #58 + migration 137 | pendente |
| Render (na ativação): `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, `_TOKEN`, `_TEMPLATE_OTP`, `_APP_SECRET`, `_VERIFY_TOKEN`, `NOTIFICACOES_OTP_TRANSPORTE=oficial`, `NOTIFICACOES_OTP_OFICIAL_AUTORIZADO=true`, `NOTIFICACOES_CONVITES_HABILITADOS=true` | cada uma com autorização própria | pendente |

## D. Decisões
Aprovação jurídica do termo (doc 22 §4) e inserção da versão não-rascunho; orçamento; quem administra o DNS; data de ativação.
