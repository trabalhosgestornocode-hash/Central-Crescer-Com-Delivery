# 32 — D-1: diagnóstico completo do RATE_LIMIT e proposta (Frente B)

Somente leitura em produção; nenhuma cota, configuração ou mensagem foi alterada; nenhuma mensagem vencida foi reenviada. Branch `fix/d1-reagendamento-expira-em`.

## 1. O que acontece (causa completa, três camadas)
1. **O teto.** `comunicacao_reservar_envio` conta, por **contato de WhatsApp** (telefone), as mensagens do dia (qualquer empresa, qualquer unidade). Limite configurado: `max_por_contato_por_dia = 3` (`limite_diario_org` não tem valor; teto por minuto = 5). Ao passar, devolve `RATE_LIMIT_DIA`.
2. **Quem estoura.** O D-1 gera **uma mensagem por registro de destinatário**. Há 41 registros ativos em 28 telefones: 5 telefones têm mais de um registro (um com **7**, três com 3, um com 2), todos em mais de uma empresa. Só o telefone com 7 registros passa de 3 mensagens/dia ⇒ **exatamente 4 mensagens barradas por dia** (padrão observado: 4–9/dia desde 21/10; **46 de 46** `RATE_LIMIT` desde 19/10 foram nesse perfil).
3. **O reagendamento impossível.** `RATE_LIMIT_DIA` reagenda para o início do próximo dia local, que cai na próxima janela de envio (sábado → **segunda**, o domingo não tem janela). Mas a mensagem vence em `expira_em` (= horário original + 24 h) ⇒ ficava **`SCHEDULED` para um dia em que já estaria vencida** e acabava cancelada como `EXPIRADA`/`RATE_LIMIT` sem sair. O **reforço** já tinha a guarda (expira em vez de reagendar); o **D-1 normal não tinha**.
Resultado real: as 4 de 31/10 (reagendadas para 02/11 11:44–11:59, vencidas em 01/11) **não seriam entregues**; as 70 mensagens canceladas com `erro = RATE_LIMIT` no histórico são consistentes com esse mesmo caminho (não conferi uma a uma).

## 2. Impacto nos destinatários atuais
| Quem | Hoje | Observação |
|---|---|---|
| 4 telefones com 1–3 registros | recebem tudo (≤ 3/dia) | sem impacto |
| **1 telefone com 7 registros** | recebe 3 de 7 avisos por dia; os outros 4 registros (empresas/unidades) **nunca chegam** | perda de ~4 avisos/dia (≈ 8–10 % do volume diário de ~50) |
| Dia típico | ~50 mensagens D-1; 4–9 barradas | mais um pico em 27/10 (9) |

## 3. O que foi corrigido (seguro: não muda a política de envio)
`decidirDestinoDoAdiamento` (pura): se o próximo instante calculado é **≥ `expira_em`**, a mensagem **encerra no ato** como `CANCELLED/EXPIRADA` (motivo original na auditoria: `expirouNoAdiamento`, `proximoInstanteCalculado`, `expiraEm`) em vez de ficar "agendada". É o **mesmo desfecho final** (o worker e o banco já cancelam toda mensagem vencida), sem a ilusão de entrega futura; reforço/tardio mantém a regra. Sem migration; cotas, cooldown, janelas e destinatários intactos. **Não reenvia nem reabre nada.**

## 4. Alternativas (as que mudam comportamento exigem decisão)
| Alternativa | O que muda | Prova | Efeito no telefone dos 7 registros | Risco/observação |
|---|---|---|---|---|
| **A. Manter mensagens individuais e rever o teto** | subir `max_por_contato_por_dia` (global; não há teto por telefone) | PG descartável (`rate_limit_d1.sh`, 11/11): teto 3 ⇒ 3 passam/4 barradas; **teto 4** ⇒ 4/3; **teto 7** ⇒ 7/0; outro telefone nunca é afetado; teto é **diário**; vencida é cancelada pelo banco; teto por minuto adia ~2 min | recebe até 7 mensagens separadas por dia | mais mensagens ao mesmo número (percepção de spam/risco para a conta WhatsApp); afeta só esse telefone na prática (os demais têm ≤ 3) |
| **B. Consolidar por telefone** | uma mensagem com blocos por empresa/unidade (protótipo puro **não ligado**, `comunicacao.consolidacao.js`, 8 testes) | só junta o **mesmo contato de WhatsApp**; só blocos **autorizados**; cada bloco com o nome da sua empresa/unidade; ordem e chave determinísticas (idempotente); nunca corta bloco; 1 bloco ⇒ mensagem original intacta | recebe **1 mensagem** (ou 2–3 se passar do limite de tamanho) com os 7 avisos | exige mudar o agendador/envio (formato e quantidade de mensagens), validar com cada empresa, e decidir o que fazer com revogação parcial; **recomendada** |
| **C. Só corrigir o reagendamento** (feito) | estado correto (`EXPIRADA` já) | 11 testes puros novos (+25 de adiamento já existentes) | continua recebendo 3 de 7 | não recupera as 4 perdidas; só elimina a falsa expectativa |
| **D. Reagendar além do vencimento (estender `expira_em`)** | entregar na segunda um relatório de sábado | — | — | **não recomendada**: vira "cobrança velha" (o próprio código evita isso) |
| Higiene de cadastro | revisar por que **o mesmo telefone** está em 7 registros de destinatário | — | — | pode resolver sem mudar política; decisão do responsável do D-1 |

## 5. Recomendação
**C agora** (já feito) + decisão entre **B (consolidar)** e **A com teto 4–7** + **higiene do cadastro** do telefone repetido. A e B são mudanças de comportamento: dependem de sua decisão.

## 6. Testes e regressão
11 testes puros novos de adiamento/vencimento (caso real de 31/10, fronteira `>=`, idempotência 50 reavaliações, empresas diferentes no mesmo telefone), 8 de consolidação, PG 11/11; regressão completa do backend comparada à `main` no PR.
