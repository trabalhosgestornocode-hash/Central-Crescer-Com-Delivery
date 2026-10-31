# 40 — Variáveis `NOTIFICACOES_RELATORIOS_*` (preparadas; TODAS desligadas)

Serviço Render: `crescercomdelivery`. **Nada abaixo está definido hoje; o código publicado (PR #67) é inerte sem elas.** Os números de telefone nunca entram no repositório: a lista é preenchida direto no painel do Render por quem tem a autorização do titular.

| Variável | Valor para a homologação | Efeito | Padrão (ausente) |
|---|---|---|---|
| `NOTIFICACOES_RELATORIOS_ENVIO_HABILITADO` | `true` só no dia da homologação real | liga o despacho da fila pelo gateway Baileys | desligado |
| `NOTIFICACOES_RELATORIOS_ALLOWLIST_E164` | números autorizados em E.164, separados por vírgula (**preencher no Render**) | só estes números recebem; os demais itens aguardam e expiram | sem lista ⇒ despacho recusado (`ALLOWLIST_OBRIGATORIA`) |
| `NOTIFICACOES_RELATORIOS_EXIGE_ALLOWLIST` | **não definir** (só `false` por decisão de disponibilidade geral) | dispensa a lista | exige |
| `NOTIFICACOES_RELATORIOS_MAX_DIA` | `3` (ou menos na homologação: `1`) | cota por destinatário/categoria/dia | 3 |
| `NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO` | `true` só quando o agendador for ligado ao worker | permite `iniciar()` do agendador (hoje **não** chamado pelo `server.js`) | recusa iniciar |

Reaproveitadas (já existem no serviço): `WHATSAPP_GATEWAY_URL`, `WHATSAPP_GATEWAY_SECRET` (gateway Baileys existente; kill switch do modo global e conta confirmada seguem valendo).

## Lista de destinatários autorizados (homologação)
1. Um número por pessoa que **autorizou** (titular), já cadastrada como destinatário da empresa, com escopo da unidade nas categorias `fechamento_operacional_diario` e/ou `resumo_semanal`, origem convite+OTP e consentimento vigente.
2. Sem termo v2 aprovado não há consentimento real: a lista sozinha **não** autoriza envio (a autorização é relida no envio).
3. Unidade elegível hoje: 1 de 53 com Checklist + integração de pedidos + pedidos reais.

## Ordem para ligar (cada passo com autorização)
termo v2 aprovado → convite+OTP do destinatário → `ALLOWLIST_E164` → `ENVIO_HABILITADO=true` → acompanhar o primeiro ciclo → (depois) ligar o agendador no worker. Desligar = remover `ENVIO_HABILITADO`.
