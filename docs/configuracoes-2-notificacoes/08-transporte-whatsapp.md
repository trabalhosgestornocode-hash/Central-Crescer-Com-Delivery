# 08 — Estratégia de transporte WhatsApp

## 1. O que existe

- **Gateway próprio** (`gateway-whatsapp/`, serviço privado no Render) com **Baileys 6.7.24** fixado.
- O gateway faz: sessão, auth-state cifrado, lease, envio de texto/imagem/documento, inbound, receipts, cache de retry (105) e grupo interno restrito a um JID (`README.md`). **Não** decide destinatário, política ou cota.
- O backend fala com o gateway por HTTP + HMAC (`baileysGateway.provider.js`).
- **Contrato de provider** (`backend/src/modules/comunicacao/whatsapp.provider.js`): `connect`, `disconnect`, `getStatus`, `sendText`, `sendImage`, `sendDocument`, `onMessage`, `markAsRead` e `getMessageStatus`. Foi desenhado para "trocar Baileys pela API oficial sem reescrever as camadas acima". Há **teste arquitetural** que impede chamar o provider fora de `whatsapp.service.js`.
- **Produção:** 1 conexão `baileys/CONNECTED` com identidade confirmada. Envio real diário (D-1 e grupo interno).
- **Histórico de fragilidade:** sync offline travado até o re-pareamento de 25/09/2026 (`docs/gateway-whatsapp-offline-recovery-investigacao.md`; memória do projeto).

**O gateway atual não equivale à API oficial.**
- Baileys é um cliente não oficial do protocolo multi-device: não há templates, categorias de cobrança, webhook oficial nem garantias de política.
- O risco de restrição do número é do operador.

## 2. Requisitos da WhatsApp Business Platform (oficial)

Fontes consultadas em 30/10/2026; conferir na data da homologação:
- [Authentication templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/authentication-templates/)
- [Copy code authentication templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates)
- [Template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization)
- [Get opt-in for WhatsApp](https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in)
- [WhatsApp Business Policy](https://business.whatsapp.com/policy)
- [Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [Service messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)

| Requisito | Impacto no projeto |
|---|---|
| **Opt-in obrigatório** antes de mensagem iniciada pela empresa, deixando claro que a pessoa aceita receber e **identificando o nome da empresa**. A Meta recomenda opt-in por categoria e instruções de saída | o consentimento do doc 05 (por empresa, por categoria, texto com o nome do negócio, como sair) atende e é a evidência |
| Fora da **janela de 24 h** de atendimento só **templates aprovados**; a Meta pode pausar ou rejeitar templates | o D-1 e o fechamento viram templates **utility** com variáveis; o texto livre só vale dentro da janela |
| **OTP só por template de autenticação**. Botão "copiar código" (ou preenchimento automático no Android); **sem URL, mídia ou emoji**; código até 15 caracteres; expiração configurável de 1 a 90 min; aviso de segurança opcional | o código de 6 dígitos com 5 min cabe; o convite com link precisa de outro canal ou de template utility (doc 05 §2) |
| **Cobrança por mensagem entregue** (desde 01/07/2025), por categoria e país. A documentação indica que mensagens de serviço e utility dentro da janela passaram a ser cobradas a partir de 01/10/2026 | o volume atual (≈ 1.200 D-1/mês + futuros fechamentos + OTPs) precisa de **estimativa com a tabela vigente para o Brasil** antes da ativação (decisão D-13) |
| Templates de autenticação têm TTL de 10 min | coerente com OTP de 5 min |
| Qualidade e limites: bloqueios/denúncias reduzem o limite do número | agrupamento e cotas (doc 04 §6) protegem a qualidade |

## 3. Camada de transporte desacoplada (proposta)

Estender o contrato atual sem quebrar o Baileys:

```
WhatsAppProvider (existente)            + extensões
  sendText / sendImage / sendDocument      sendTemplate({telefoneE164, template, idioma, parametros, categoria, idempotencyKey})
  getStatus / getMessageStatus             onStatus(callback)  — webhooks: sent | delivered | read | failed (+ código de erro, preço/categoria)
  onMessage                                capabilities(): { templates: bool, otp: bool, inboundConfiavel: bool, custoPorMensagem: bool }
```

| Transporte | Uso |
|---|---|
| `noop` (simulação) | desenvolvimento e homologação de toda a Etapa 1–5; grava `SIMULATED`; nenhum envio (padrão do fechamento 2.0) |
| `baileys` (existente) | continua com o D-1 e o grupo interno até a migração. **Nunca** para OTP |
| `meta_cloud` ou BSP homologado (novo) | OTP (authentication), D-1 e fechamento (utility), inbound/opt-out por webhook |

- **Roteamento por categoria:** `comunicacao_categorias.transporte` decide (ex.: `pendencia_d1 → baileys` até a virada; `verificacao_otp → meta_cloud`; `fechamento_operacional_diario → noop` até a ativação). Trocar de transporte vira uma mudança de configuração auditada e reversível.
- **Callbacks:** endpoint de webhook com verificação de assinatura (`X-Hub-Signature-256`), idempotente por `provider_message_id`. Ele atualiza `comunicacao_mensagens` pelos mesmos caminhos do status do provider atual (095).
- **Templates:** o catálogo `comunicacao_templates` (nome, idioma, categoria Meta, versão, estado de aprovação, mapeamento de variáveis) é configuração, não código. O texto renderizado segue o snapshot da mensagem.
- **Custos:** grava `categoria_cobranca` e preço informado pelo webhook (quando houver) em `metadados`, com relatório mensal por empresa.
- **Erros:** mapear os códigos oficiais para RETRYAVEL/PERMANENTE/INCERTO (mesma classificação de `comunicacao_tentativas`).

## 4. Homologação do WhatsApp real (Etapa 6, futura e com autorização explícita)

1. Escolha do provedor (Cloud API direto × BSP brasileiro), comparando custo, suporte e LGPD (operador de dados, contrato e DPA) (**decisão D-13**).
2. Conta comercial verificada, número dedicado (**não** o número do Baileys durante a transição), nome de exibição aprovado.
3. Submissão e aprovação dos templates (autenticação OTP, D-1, D-1 reforço, fechamento, correção de fechamento), com textos aprovados por você.
4. Ambiente de teste (número de teste da Meta), com OTP e templates ponta a ponta sem cliente real.
5. Piloto com 1 empresa voluntária: OTP e consentimento reais, D-1 pelo transporte oficial **em paralelo controlado** (o Baileys desligado para essa empresa, nunca os dois).
6. Virada por categoria e por empresa, com reversão por configuração.
7. Desativação do Baileys só depois de N semanas estáveis (**decisão**).
