# 40 — Variáveis `NOTIFICACOES_RELATORIOS_*`, piloto e verificação de versão (TUDO desligado)

Serviço Render: `crescercomdelivery`. **Nenhuma variável abaixo está definida hoje.** O código (PR #67 + PR #69) é inerte sem elas. Telefones e ids de pessoas nunca entram no repositório: a lista de números é preenchida direto no painel do Render por quem tem a autorização do titular.

| Variável | Valor | Efeito | Se ausente |
|---|---|---|---|
| `NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO` | `true` | o boot inicia o agendador (gera o fechamento de ontem, enfileira diário/semanal, despacha). Passa também pela guarda de efeitos externos (`EFEITOS_EXTERNOS_*`, mesmas do worker de comunicação) | não inicia |
| `NOTIFICACOES_RELATORIOS_UNIDADES_PILOTO` | id(s) de unidade, vírgula | restringe o ciclo (geração **e** fila) às unidades listadas; valor inválido = nenhuma | todas as elegíveis |
| `NOTIFICACOES_RELATORIOS_ENVIO_HABILITADO` | `true` | liga o despacho pelo gateway Baileys | só gera e enfileira |
| `NOTIFICACOES_RELATORIOS_ALLOWLIST_E164` | números em E.164, vírgula (**preencher no Render**) | só estes recebem; os demais itens aguardam e expiram | despacho recusado (`ALLOWLIST_OBRIGATORIA`) |
| `NOTIFICACOES_RELATORIOS_MAX_DIA` | `1` na homologação; `3` depois | cota por destinatário/categoria/dia | 3 |
| `NOTIFICACOES_RELATORIOS_EXIGE_ALLOWLIST` | **não definir** | `false` dispensa a lista (só por decisão de disponibilidade geral) | exige |

Reaproveitadas (já existem): `WHATSAPP_GATEWAY_URL`, `WHATSAPP_GATEWAY_SECRET`, `EFEITOS_EXTERNOS_PERMITIDOS`, `EFEITOS_EXTERNOS_SERVICOS_AUTORIZADOS`.

## Unidades elegíveis pela integração iFood (leitura de produção em 31/10)
Critério: módulo `checklist_operacional` na empresa e na unidade + conexão de pedidos viva (finalidade `pedidos_producao`, **ou `legado` quando é a única**) + credencial `order` ativa + coletor com batimento recente + pedidos reais.
| Unidade | Conexão | Eventos 24 h | Pedidos 7 d | Projeção operacional |
|---|---|---|---|---|
| Subway Saci — Matriz | legado + order ativa | ~2,3 mil | ~1,0 mil | 715 pedidos reais já projetados (fechamento já exercitado) |
| Subway North Shopping | pedidos_producao + order ativa | ~1 mil | ~430 | vazia (projeta na 1ª geração) |
| Matriz Subway Feiraguay | legado + order ativa | ~150 | ~330 | vazia |
As outras 5 unidades com o módulo não têm conexão iFood. *(Correção: o doc anterior citava 1 unidade por ler só a finalidade `pedidos_producao`.)*

## Piloto proposto: Subway Saci — Matriz
Maior volume e projeção já populada. Passos (cada um com autorização): termo v2 aprovado → destinatário já cadastrado na empresa recebe convite+OTP com escopo da unidade nas categorias `fechamento_operacional_diario` e `resumo_semanal` → `UNIDADES_PILOTO=<id da Matriz>` + `ALLOWLIST_E164=<número autorizado>` + `MAX_DIA=1` → `AGENDADOR_HABILITADO=true` e `ENVIO_HABILITADO=true` → acompanhar o 1º ciclo (diário às 08h locais; semanal na segunda). Desligar = remover `ENVIO_HABILITADO`.

## Verificar a versão publicada
`GET /health` passa a trazer `versao` (7 primeiros hex do commit do deploy, `RENDER_GIT_COMMIT`) a partir do PR #69.
