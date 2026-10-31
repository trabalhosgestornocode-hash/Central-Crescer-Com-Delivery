# 21 — Preparação: convites por e-mail (SMTP) e WhatsApp oficial para OTP

Preparação **sem envio real**. Nada foi configurado no Supabase de produção, no Render ou em provedores.

## 1. Convites por e-mail (Fase 4)

### O que o código já faz
Conta **nova** + `USUARIOS_CONVITE_EMAIL=supabase` + `APP_URL_PUBLICA` → cria o convite (token 32 bytes, só o SHA-256 no banco, 72 h, uso único) e chama `auth.admin.inviteUserByEmail` com `redirectTo = <APP_URL_PUBLICA>/convite-usuario.html#t=<token>`.
Se o e-mail falhar, o convite é **revogado na hora** (502). Sem a variável, conta nova é recusada com 409 e nada é criado. Conta que já existe recebe o acesso como antes. A página `/convite-usuario.html` junta os fragmentos (`#t=` e os do Supabase) e consome o convite no servidor, só para o e-mail convidado.

### O que falta (só você ou um provedor)
| Item | Quem | Observação |
|---|---|---|
| Provedor SMTP (host, porta, usuário, senha) e domínio remetente com SPF/DKIM/DMARC | responsável | o SMTP padrão do Supabase é limitado e só serve para teste |
| Supabase Auth → SMTP próprio, no projeto **de teste** primeiro | responsável (credenciais) | não há token da API de gestão nesta sessão |
| *URL Configuration*: Site URL e `…/convite-usuario.html` em *Redirect URLs* | responsável | |
| Template "Invite user" em português | pronto (abaixo) | colar em Auth → Email Templates |
| Validade do link do e-mail do Supabase ≥ 72 h (ou aceitar que o convidado peça novo convite) | responsável | |

### Template (português) — "Invite user"
Assunto: `Você foi convidado(a) para a Crescer com Delivery`
```html
<h2>Você foi convidado(a)</h2>
<p>Olá! Você recebeu acesso à plataforma Crescer com Delivery.</p>
<p>Para criar a sua senha e entrar, use o botão abaixo. O link vale por tempo limitado e só pode ser usado uma vez.</p>
<p><a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 20px;background:#D81324;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Aceitar convite</a></p>
<p style="color:#666;font-size:13px">Se você não esperava este convite, ignore esta mensagem: nada será criado. Ninguém da Crescer pede a sua senha.</p>
```

### Plano de homologação (ambiente de teste, destinatário de teste autorizado)
1. Configurar SMTP e template no projeto de **teste**; `USUARIOS_CONVITE_EMAIL=supabase` e `APP_URL_PUBLICA` só no ambiente de teste.
2. Conferir pela caixa de entrada (não pela resposta da API): chegada, remetente, assunto, link.
3. **Crítico:** confirmar que o redirect **preserva** `#t=<token>` quando o Supabase anexa a sessão. Se sobrescrever o fragmento, o token precisa ir por outro meio (ex.: parâmetro de consulta com `Referrer-Policy: no-referrer`) — ajuste de código antes de produção.
4. Aceite: senha definida pelo convidado, vínculo criado, convite consumido; reabrir o link → "já usado".
5. Falhas: SMTP errado → 502 e convite revogado (sem pendência); e-mail divergente → recusa; expirado (>72 h) → recusa; reenvio = cancelar e convidar de novo.
6. Conta já existente: acesso imediato, sem e-mail. Perfil por empresa/unidade respeitado.

## 2. WhatsApp oficial para OTP (Fase 5)

Separado do gateway Baileys: o código **recusa** transporte real hoje (`capacidades().envioReal = false`) e nenhum módulo da Central importa o gateway (teste arquitetural).

### Requisitos e custos (conferir na fonte oficial antes de contratar)
A busca desta preparação **não** retornou a tabela oficial da Meta; os números abaixo vêm de guias de terceiros e são estimativas:
- Cobrança por mensagem de modelo entregue (desde 01/07/2025), pelo **país do destinatário**; [Courier](https://www.courier.com/guides/whatsapp-pricing), [Authgear](https://www.authgear.com/post/whatsapp-api-pricing).
- Autenticação no Brasil: **≈ US$ 0,0068 por mensagem (≈ US$ 680 por 100 mil códigos)**, segundo [Authgear](https://www.authgear.com/post/whatsapp-api-pricing); marketing ≈ 8× utilidade. Há menção a cobrança em BRL a partir de meados de 2026 — **verificar**.
- Documentação oficial a conferir: [Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md).
- Modelo de **autenticação** usa o formato predefinido da Meta (botão copiar código ou toque único, aviso de validade) e aprovação rápida; não aceita texto livre.
- Restrição de contas fora do Brasil mensagearem números brasileiros foi citada por fontes de terceiros — **confirmar o status atual** antes de escolher o provedor/WABA.
- Verificação de empresa na Meta (Business Manager): requisitos **não confirmados** nesta busca.

### O que o código precisa (Etapa 6, depois da contratação)
1. Adaptador do provedor em `notificacoes.envio.js` (única porta de saída do OTP) com `capacidades().otp = true`, `envioReal = true` e entrega por **modelo de autenticação aprovado**.
2. Limite de tentativas já é do **banco** (60 s, 5/h e 10/dia por número, 20/h por IP em HMAC, 5 tentativas por código, 5 min), válido com várias instâncias; o limitador em memória das rotas públicas é só uma camada extra por instância.
3. Texto do **termo de consentimento** aprovado (hoje a versão 1 é RASCUNHO só para simulação) e registro de `termo_hash` no livro-razão (já implementado).
4. Consentimento **separado** da posse do número (já é: a verificação não concede nada; categorias vêm desmarcadas) e **nenhuma** categoria nova para legados (CHECK no banco).
5. Webhooks de status/inbound do provedor (palavra SAIR) e reaproveitamento do mesmo caminho de revogação.

### Decisões para o responsável
Escolher o provedor/BSP (ou Cloud API direta), o número e a empresa verificada, a aprovação jurídica do termo e o orçamento mensal estimado (volume de OTP × tarifa).
