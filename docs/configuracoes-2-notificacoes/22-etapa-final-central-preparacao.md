# 22 — Etapa final da Central: preparação (sem ativação)

Nada aqui foi ativado. Nenhuma variável do Render foi alterada, nenhum serviço pago foi configurado, nenhuma mensagem real foi enviada, M3, Central de escrita, OTP real e corte do fuso seguem desligados.

## 1. O que ficou pronto no código (branch `feat/central-oficial-otp-preparacao`)
| Item | Estado |
|---|---|
| Adaptador Cloud API oficial (`notificacoes.whatsappOficial.js`), sem nenhum import do Baileys | pronto, testado com Graph API falsa (79 testes de notificações + 211 de configurações/arquitetura/segurança/usuários, 0 falhas) |
| Modo `oficial` em `notificacoes.envio.js` | exige **três** condições: `NOTIFICACOES_OTP_TRANSPORTE=oficial`, `NOTIFICACOES_OTP_OFICIAL_AUTORIZADO=true` e credenciais completas. Qualquer falta → `desligado` |
| Idempotência | 1 desafio = 1 mensagem (memória) + banco (1 desafio = 1 código). Timeout/rede **não** repete (não se sabe se saiu) |
| Auditoria/logs | só id do desafio e motivo fixo; número, código e token nunca aparecem (teste captura o log) |
| Limites compartilhados | já no banco: 60 s, 5/h e 10/dia por telefone (HMAC), 20/h por IP (HMAC), 5 tentativas, 5 min. Valem para várias instâncias |
| Webhook: assinatura `X-Hub-Signature-256` (corpo cru, tempo constante), handshake, extração de status com chave `provedorId:status` | funções prontas e testadas; **a rota HTTP e a tabela de eventos NÃO existem** (ver §3) |

## 2. Credenciais e variáveis necessárias (só nomes)
Meta: `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, `WHATSAPP_CLOUD_TOKEN` (usuário do sistema, permanente), `WHATSAPP_CLOUD_TEMPLATE_OTP` (modelo de **autenticação** aprovado), `WHATSAPP_CLOUD_TEMPLATE_LANG` (padrão `pt_BR`), `WHATSAPP_CLOUD_API_VERSION` (padrão `v21.0`), `WHATSAPP_CLOUD_APP_SECRET` e `WHATSAPP_CLOUD_VERIFY_TOKEN` (webhook).
Central: `NOTIFICACOES_SEGREDO_MESTRE`, `APP_URL_PUBLICA`, `NOTIFICACOES_OTP_TRANSPORTE=oficial`, `NOTIFICACOES_OTP_OFICIAL_AUTORIZADO=true`.
E-mail: `USUARIOS_CONVITE_EMAIL=supabase` + SMTP no Supabase Auth (doc 21: Resend, `smtp.resend.com`, porta 465, usuário `resend`, chave de API como senha, domínio com SPF/DKIM/DMARC).
Custos e exigências de terceiros (Meta ≈ US$ 0,0068/autenticação no Brasil; plano gratuito do Resend; verificação de empresa na Meta) **continuam por confirmar nas páginas oficiais** antes de contratar (ver doc 21).

## 3. Webhook de status: proposta de migration (NÃO aplicada)
Tabela `comunicacao_provedor_eventos` (`chave text primary key` = `provedorId:status`, `desafio_id uuid null`, `status text`, `codigo_erro int null`, `recebido_em timestamptz default now()`), RLS ligada sem política (só service role), `insert … on conflict do nothing` para idempotência, sem telefone. Rota `POST /api/notificacoes/webhook/whatsapp` com corpo cru, verificação de assinatura **antes** de qualquer leitura e limite por IP; `GET` para o handshake. Palavra "SAIR" (inbound) reaproveita a revogação existente. Precisa de migration 137 e rota: **aguarda autorização**, pois muda schema de produção.

## 4. Texto do termo (rascunho v2 — somente para revisão jurídica; NÃO inserido em produção)
> **Termo de consentimento para notificações da Crescer com Delivery (v2 — rascunho)**
> 1. **Quem somos.** A Crescer com Delivery ([razão social e CNPJ — preencher]) enviará mensagens ao número que você confirmou.
> 2. **O que enviaremos.** Somente as categorias que você marcar abaixo (por exemplo: avisos operacionais da sua unidade, alertas do dashboard). Nenhuma categoria vem marcada.
> 3. **Como confirmamos o número.** Enviamos um código de 6 dígitos por WhatsApp, válido por 5 minutos. Confirmar o número **não** autoriza nenhuma mensagem: a autorização é este termo.
> 4. **Dados tratados.** Número de telefone (guardado cifrado), categorias escolhidas, data/hora e versão deste termo. Base legal: consentimento (LGPD, art. 7º, I). [Retenção e compartilhamento com a Meta — confirmar com o jurídico.]
> 5. **Como sair.** Responda **SAIR** a qualquer mensagem ou desative em Configurações → Notificações. A revogação vale imediatamente e fica registrada.
> 6. **Contato do encarregado (DPO).** [preencher].
>
> Decisões do jurídico: razão social/CNPJ, retenção, base legal para destinatários já existentes (o código **não** lhes concede categorias novas nem exige OTP retroativo), DPO, texto de recusa.
Ao aprovar, o hash do texto final é gravado no livro-razão (já implementado); a v1 continua como rascunho de simulação.

## 5. Pré-voo de ativação de `APP_URL_PUBLICA` e `NOTIFICACOES_SEGREDO_MESTRE` (sem executar)
- `APP_URL_PUBLICA` = `https://centralcrescercomdelivery.com.br` (https, só origem). Efeito: links de convite deixam de dar 503 `URL_PUBLICA_AUSENTE`. Não habilita escrita nem envio.
- `NOTIFICACOES_SEGREDO_MESTRE`: gerado por `backend/testes-seguros/producao/gerar_segredo_notificacoes.sh` (nunca exibido; cópia cifrada com `age` fora do OneDrive; valor só na área de transferência por 120 s; recusa sobrescrever). **Nunca rotacionar depois de cifrar dados.**
- Ambos exigem alterar variável de produção → um redeploy do serviço `srv-d96rl5naqgkc73ccflr0`. Reversão: remover as variáveis (a Central volta a responder 503 nas rotas dependentes; D-1 não usa nenhuma delas).
- Confirmação pós-troca (somente leitura): `/health` 200, `ifoodEvents` ativo, lista de nomes das variáveis, comprimento (não valor) do segredo.

## 6. Decisão consolidada pedida ao responsável (uma só)
1. Autorizar a PR da branch `feat/central-oficial-otp-preparacao` (adaptador desligado; zero efeito em produção) e o merge/deploy dela.
2. Autorizar definir `APP_URL_PUBLICA` e `NOTIFICACOES_SEGREDO_MESTRE` no Render (§5).
3. Autorizar a migration 137 + rota do webhook (§3), em branch separada, com o mesmo ritual de backup/transação único das 132–136.
4. Contratar/decidir, fora do código: conta Resend + domínio; WABA/número/modelo de autenticação na Meta; aprovação jurídica do termo (§4).
5. Só depois das 1–4, e **cada uma com autorização própria**: SMTP no Supabase, credenciais Meta, `NOTIFICACOES_OTP_*`, Central de escrita, M3, fuso.
