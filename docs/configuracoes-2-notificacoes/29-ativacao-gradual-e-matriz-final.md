# 29 — Ativação gradual dos convites e do OTP pelo Baileys + matriz final de decisões

Estado em 31/10/2026. **Nada aqui está ativado.** Convites desligados (`NOTIFICACOES_CONVITES_HABILITADOS=false`), OTP desligado (sem variáveis `NOTIFICACOES_OTP_*`), termo v2 em rascunho (consentimento real recusado, 409), M3 e corte do fuso desligados.

## 1. Resultado da homologação do OTP: PASS
Envio e verificação reais aprovados em 31/10 (evidência no doc 28, sem dado sensível): 1 reserva `ENVIADO` (resultado gravado em 1 s) e 1 desafio real consumido em 1 tentativa; cadastro, categorias, consentimentos e D-1 inalterados; transporte desligado depois.

## 2. Como limitar a uma unidade e a números autorizados
| Trava | Onde | Força |
|---|---|---|
| **Lista de números autorizados** (`NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164`) | backend, antes de qualquer reserva/envio | **dura**: número fora da lista nunca recebe código |
| **Tetos do OTP** (`NOTIFICACOES_OTP_MAX_HORA`, `_MAX_DIA`, `_MAX_SIMULTANEOS`) | banco (migration 138), vale entre instâncias | **dura**: no máximo N códigos/hora e/dia |
| **Escopo do gestor** (D-3: gestor de unidade só convida para a **própria** unidade; admin = empresa) | backend | **dura** por perfil: usar um gestor da unidade piloto |
| **Chave global de convites** (`NOTIFICACOES_CONVITES_HABILITADOS`) | backend | dura, mas **global** (não por unidade) |
| Restringir convites a **uma unidade específica** | — | **não existe como variável**. Com a lista de números, nenhum código sai para fora do piloto; a restrição por unidade fica por **perfil** (só o gestor piloto convida). Opcional, ~20 linhas + testes: `NOTIFICACOES_CONVITES_UNIDADES` (lista de ids). **Decisão sua.** |

## 3. Fases (cada passo com autorização própria; reversão = remover as variáveis)
| Fase | O que liga | Pré-requisito | Critério de sucesso | Reversão |
|---|---|---|---|---|
| **0 — hoje** | nada | — | tudo desligado, D-1 estável | — |
| **1 — piloto fechado** (1 unidade, 2–3 números autorizados) | `NOTIFICACOES_OTP_TRANSPORTE=baileys`, `_BAILEYS_AUTORIZADO=true`, `_ALLOWLIST_E164=<números>`, tetos baixos (ex.: 5/h, 10/dia), `NOTIFICACOES_CONVITES_HABILITADOS=true` | **termo v2 aprovado e publicado** (sem ele o consentimento dá 409); números e unidade piloto definidos por você | convite → código → verificação → termo → categorias → 1 notificação autorizada recebida; 0 `INCERTO`/`FALHOU` inesperados; D-1 idêntico | remover as 6 variáveis |
| **2 — ampliação controlada** | ampliar a lista/unidades | Fase 1 PASS por alguns dias | idem, sem impacto no D-1 | reduzir a lista |
| **3 — disponível aos clientes** | remover a lista; manter tetos | Fase 2 PASS; decisões do §4 | idem | recolocar a lista / desligar o transporte |
Em todas: monitorar `comunicacao_otp_envios` (ENVIADO/INCERTO/FALHOU/LIMITE/ADIADO), hash dos 41 destinatários e a fila do D-1; o OTP **adia** sozinho quando o D-1 está enviando.

## 4. Matriz final: decisões materiais que faltam
| # | Decisão | Quem | Bloqueia | Estado |
|---|---|---|---|---|
| 1 | **Aprovar o termo v2** (matriz de cláusulas no arquivo do termo) | jurídico | consentimento real e qualquer fase com clientes | pendente |
| 2 | **Autorizar a publicação** do termo definitivo (inserir `versao = 2`, `rascunho = false`; ato de dados) | você | Fase 1 | pendente (após #1) |
| 3 | **Definir o piloto**: unidade, perfil do gestor e números autorizados | você | Fase 1 | pendente |
| 4 | **Autorizar a Fase 1** (variáveis no Render, num único salvamento) | você | Fase 1 | pendente (após #1–#3) |
| 5 | Restrição por unidade em código (`NOTIFICACOES_CONVITES_UNIDADES`) — sim/não | você | nada (opcional) | pendente |
| 6 | Palavra **SAIR**: ligar `NOTIFICACOES_PALAVRA_CHAVE_SAIR` e confirmar o texto de saída (o termo promete) | você + jurídico | cláusula 5 do termo | pendente |
| 7 | **Regra RATE_LIMIT do D-1** (doc 28 §1): 7 registros no mesmo telefone batem o teto de 3/dia e as barradas são reagendadas **além do `expira_em`** (viram `EXPIRADA`); decidir teto, consolidação por telefone e reagendamento | responsável pelo D-1 | **não** bloqueia a Central | pendente |
| 8 | Merge do PR #61 (só documentação) e do PR de código futuro, se houver | você | nada | pendente |
| 9 | Resíduo do teste real (1 desafio + 1 reserva, sem dado pessoal): manter como evidência ou apagar (escrita em produção) | você | nada | recomendo manter |
| 10 | E-mail de convite de **usuário** (Resend): só para criar contas novas; fora do caminho do titular | você | nada da Central | opcional |
| — | M3, novas categorias, corte do fuso | — | — | **permanecem desligados**, fora desta entrega |

Dependências externas **removidas**: Meta/Cloud API, número dedicado, token oficial, modelo de autenticação e tarifa. Restam apenas as decisões acima.
