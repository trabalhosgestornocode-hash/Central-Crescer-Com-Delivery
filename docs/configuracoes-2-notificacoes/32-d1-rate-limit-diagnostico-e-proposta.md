# 32 — D-1: diagnóstico completo do RATE_LIMIT, recomendação final e correção segura (Frente B)

Somente leitura em produção; nenhuma cota, configuração, destinatário ou mensagem foi alterado; nenhuma mensagem vencida foi reenviada. Branch `fix/d1-reagendamento-expira-em` (PR #63). Sem dados pessoais neste documento.

## 1. O que acontece (causa completa, três camadas)
1. **O teto.** `comunicacao_reservar_envio` conta, por **contato de WhatsApp** (telefone), as mensagens do dia — de qualquer empresa e unidade. Limite configurado: `max_por_contato_por_dia = 3` (`limite_diario_org` sem valor; teto por minuto = 5). Ao passar devolve `RATE_LIMIT_DIA`.
2. **Quem estoura.** O D-1 gera **uma mensagem por registro de destinatário**. Há 41 registros ativos em 28 telefones; 5 telefones têm mais de um registro (um com **7**, três com 3, um com 2). Só o telefone com **7 registros** passa de 3 mensagens/dia ⇒ **4 barradas por dia**. Dos `RATE_LIMIT` desde 19/10 (46), **todos (46) ficaram nos 7 registros desse telefone**; nos outros 4 telefones repetidos, **zero**.
3. **O reagendamento impossível.** `RATE_LIMIT_DIA` reagenda para o início do próximo dia local, que cai na próxima janela (sábado → **segunda**; o domingo não tem janela). A mensagem vence em `expira_em` (horário original + 24 h) ⇒ ficava **`SCHEDULED` para um dia em que já estaria vencida** e acabava `CANCELLED/EXPIRADA`. O **reforço** já tinha a guarda; o **D-1 normal não tinha**. As 4 de 31/10 (reagendadas para 02/11, vencidas em 01/11) **não seriam entregues**; as 70 canceladas com `erro = RATE_LIMIT` no histórico são consistentes com esse caminho (não conferi uma a uma).

## 2. Os vínculos duplicados são indevidos? **Não** (verificação em produção, só leitura)
Nos 5 telefones repetidos, o **mesmo nome** aparece em cada registro, todos `principal`, **cada registro numa empresa diferente** (cada loja é uma empresa própria), criados juntos em 06/10. É **um mesmo responsável cadastrado em várias lojas** (franqueado com 3, 3, 3, 2 e 7 lojas). Cada loja tem direito ao próprio relatório; "corrigir os duplicados" apagaria avisos legítimos. **Opção 3 descartada.**
Distribuição do prejuízo no telefone de 7 lojas desde 19/10: entregues 2–7 por loja e barradas 4–10 por loja; **a loja pior servida recebeu 2 e perdeu 10**. A perda é desigual e depende da ordem de envio, não de regra de negócio.

## 3. O que foi corrigido (seguro; PR #63)
`decidirDestinoDoAdiamento` (pura): se o próximo instante calculado é **≥ `expira_em`**, a mensagem **encerra no ato** como `CANCELLED/EXPIRADA` (auditoria: `expirouNoAdiamento`, `proximoInstanteCalculado`, `expiraEm`, motivo original) em vez de ficar agendada. **Mesmo desfecho final** (o worker e o banco já cancelam toda mensagem vencida); reforço/tardio mantém a regra. Sem migration; cotas, cooldown, janelas, destinatários e mensagens já existentes **intactos**; nada é reenviado nem reaberto (as 4 de 31/10 continuam como estão e serão canceladas na segunda pelo caminho antigo). **Não recupera** as mensagens barradas: só elimina a falsa expectativa.

## 4. Alternativas avaliadas
| Opção | O que muda | Prova | Efeito para o responsável das 7 lojas | Veredito |
|---|---|---|---|---|
| **1. Consolidar por telefone** | uma mensagem com um bloco por loja (cada bloco com o nome da sua empresa/unidade; só blocos **autorizados**; telefones diferentes nunca se misturam) | protótipo puro **fora do #63**, na branch `proto/d1-consolidacao-por-telefone` (8 testes: isolamento, autorização, ordem/chave determinísticas, sem cortar bloco, 1 bloco = mensagem original) | **1 mensagem/dia** (2–3 se passar do tamanho) com as 7 lojas — **recebe tudo**, e o volume diário cai de 41 para 28 mensagens | **RECOMENDADA** (definitiva) |
| **2. Limite específico para contatos multiempresa** | teto por telefone = nº de registros do telefone (hoje, 7) em vez do global 3 | PG descartável (`rate_limit_d1.sh`, 11/11): teto 4 ⇒ 4 passam/3 barradas; teto 7 ⇒ 7/0; outro telefone nunca afetado | recebe **7 mensagens separadas/dia** | **não recomendada**: o banco só tem teto **global** (precisaria de tabela de exceções + código) e multiplica mensagens ao mesmo número (percepção de spam, risco à conta WhatsApp). Servir só como paliativo, e subir o teto global exige autorização própria |
| **3. Corrigir vínculos duplicados** | — | seção 2 | — | **descartada**: os vínculos são legítimos |
| **4. Reagendar além do vencimento (estender `expira_em`)** | entregar na segunda um relatório de sábado | — | — | **rejeitada**: vira "cobrança velha" |
| **5. Só corrigir o reagendamento** | feito (§3) | 11 testes puros novos (+25 já existentes) | continua recebendo 3 de 7 | mínimo seguro, **não** resolve a perda |

## 5. Recomendação final
**Consolidar por telefone (1)**, mantendo o isolamento e a autorização por empresa/unidade: é a única opção em que o responsável das 7 lojas recebe **todos** os avisos sem aumentar o teto global nem enviar 7 mensagens. Entregar em duas etapas: (a) mergear o #63 (já seguro); (b) um PR próprio que liga a consolidação no agendamento (muda formato e quantidade de mensagens: **decisão material sua**; exige validar o texto com as empresas e definir como revogação/saída parcial se aplica a um bloco). Enquanto (b) não existir, a perda de ~4 avisos/dia nesse telefone continua. **Nenhum teto global deve ser alterado sem sua autorização.**

## 6. Testes e regressão
11 testes puros novos de adiamento/vencimento (caso real de 31/10, fronteira `>=`, 50 reavaliações idempotentes, empresas diferentes no mesmo telefone); PG descartável 11/11 (teto atual, alternativas, outro telefone, dia, vencimento no banco, minuto, idempotência, configuração intacta); regressão completa do backend comparada à `main` no PR.
