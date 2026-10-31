# 28 — Primeiro lote real do D-1 pós-implantação (31/10) e teste real do OTP pelo Baileys

Registro de 31/10/2026, somente leitura em produção (exceto o teste do OTP expressamente autorizado). Sem número completo, código, token ou segredo.

## 1. Lote D-1 de sábado 11:35–11:59 BRT — PASS (sem regressão atribuível), com ressalva
| Mensagem (ref. 30/10) | Resultado |
|---|---|
| 11:35 / 11:38 / 11:43 / 11:55 | `DELIVERED` (enviadas às 11:36:10, 11:38:40, 11:44:51 e 11:55:59; 1 tentativa cada) |
| 11:44 / 11:53 / 11:54 / 11:59 | **barradas por `RATE_LIMIT`** e reagendadas para segunda 02/11 (`SCHEDULED`, 0 tentativas) — **mas vencem antes** (ver abaixo) |

Nenhuma `FAILED`, `DELIVERY_UNKNOWN` ou `CANCELLED` nova; nada em `PROCESSING/SENDING`.

**Destino das 4 reagendadas (verificado em 31/10 12:2x):** cada uma tem `expira_em` em **01/11**, ou seja, **24 h antes** do novo `disponivel_em` (02/11 11:44–11:59). Ao serem reavaliadas na segunda elas já estarão vencidas, e o histórico mostra que o D-1 encerra mensagens vencidas como `CANCELLED` com `erro = EXPIRADA` e 0 tentativas (90 casos no total, o mais recente em 30/10 20:27). **Conclusão: não serão entregues.** (Correção: uma versão anterior deste registro dizia "adiadas para segunda", o que sugeria entrega futura.) O acompanhamento de segunda (11:47) confirma o desfecho.

> **Atualização (31/10 13:36) — correção:** as 4 mensagens **não ficaram agendadas até segunda**: já estavam `CANCELLED` com `erro = RATE_LIMIT` desde **12:48–12:59** do mesmo dia, encerradas por um mecanismo que já existia (anterior ao PR #63). O desfecho (não entregues) é o descrito acima; o que mudou com o #63 é que passam a encerrar **na hora**, como `EXPIRADA`, em vez de ~1 h depois. As "70 canceladas com RATE_LIMIT" do histórico têm esse mesmo caminho.

**Causa-raiz do `RATE_LIMIT` (investigação somente leitura, nenhuma cota alterada):**
- A função `comunicacao_reservar_envio` aplica três tetos: por **contato de WhatsApp** por dia (configurado em **3**, `limites.max_por_contato_por_dia`), por empresa por dia (`limite_diario_org`, **sem valor**) e por minuto (5 proativas). `RATE_LIMIT_DIA` reagenda para o início do próximo dia local, que cai na próxima janela de envio (segunda, pois o domingo não tem janela).
- Hoje, **um único contato de WhatsApp está cadastrado em 7 destinatários de empresa** (o mesmo telefone em 7 registros). Ele recebeu 3 mensagens (11:36, 11:38, 11:44) e atingiu o teto; as outras 4 foram barradas. Nenhum outro contato passou de 2 mensagens no dia.
- O padrão **não é novo**: 1ª ocorrência em 07/10, 66 antes das migrations 132–136, 4 por dia em vários dias (20–31/10). Em sábado 24/10, no mesmo horário, 4 `DELIVERED` + 7 `CANCELLED` (3 por `RATE_LIMIT`); dia 24/10: 32 `DELIVERED`, 7 `SENT`, 3 `READ`, 11 `CANCELLED`. **Não é causado por este PR.**
- **Decisão material (responsável pelo D-1, fora deste escopo):** (a) o teto de 3/dia por telefone está correto para quem recebe 7 avisos separados? (b) consolidar os 7 registros do mesmo telefone ou enviar uma mensagem única por pessoa; (c) reagendar para a mesma janela do dia seguinte com `expira_em` coerente, em vez de empurrar para depois do vencimento. Nada foi alterado.

## 2. Integridade
- Funções do D-1 inalteradas: agendar `7b7c0a59…`, resolvedor `accc3bc6…`, cota (`comunicacao_reservar_envio`) `0b6386a2…`.
- 41 destinatários legados estáveis durante todo o dia (hash por contato `ef4696ce17`, hash por categoria `69bad89c`, 41 linhas). A fórmula do hash antigo `5c5835a8…:41` usada em acompanhamentos anteriores não foi reproduzida; a conferência foi por contagem e por estabilidade do conteúdo (idêntico às 11:18, 11:25, 11:32 e 12:16).
- M3 ausente: seleção por escopo desligada, snapshot e escopos com 0 linhas. Fuso/corte e gateway Baileys não foram tocados.
- Tabelas novas: convites 0, consentimentos 0, convites de usuário 0, eventos do webhook 0. `comunicacao_desafios_titular` = 1 e `comunicacao_otp_envios` = 1 (evidência do teste do §3).

## 3. Teste real controlado do OTP (autorizado; titular confirmou em chat)
Número de um destinatário **já cadastrado e validado** (contato operacional ativo, categoria `pendencia_d1`) de uma empresa com as unidades Subway Saci — Matriz e Subway North Shopping, ambas ativas (vínculo no nível da empresa, M3 desligado). O próprio titular confirmou em chat que o número é dele. Nome, empresa e telefone foram omitidos de propósito (repositório público). Configuração temporária: transporte `baileys`, autorização, lista com **um** número, teto de 1 envio/hora e 1/dia (cinco variáveis, depois removidas).
- Pré-voo: identidade do WhatsApp `CONFIRMADA` (produção), modo NORMAL, entregas do D-1 minutos antes (conexão ativa), nenhum D-1 em envio ou vencendo, reservas/desafios/convites/consentimentos = 0.
- Resultado: **1 reserva `ENVIADO`** (12:15:21 → resultado 12:15:22); **1 desafio de gestão real** (não simulado), criado 12:15:21 e **consumido 12:15:35 em 1 tentativa** (limite 5). Nenhum consentimento, convite ou alteração de cadastro/categorias/escopos; nenhuma mensagem de outro tipo na fila; D-1 sem impacto.
- Reversão: as cinco variáveis foram removidas e o serviço reimplantado; convites e termo seguem desligados/em rascunho. **PASS.**

## 4. Pendências
Aprovação jurídica do termo v2 (consentimento real continua recusado, 409); decisão do responsável pelo D-1 sobre o teto `RATE_LIMIT` e o reagendamento além do vencimento (§1); ativação gradual do OTP e dos convites (doc 29), cada passo com autorização própria.
