# MOVA CORE — publicação controlada no Açaí no Grau Saci

O núcleo novo entra **dentro do MOVA que já está no ar**. É o mesmo receptor, a mesma fila, o mesmo envio e a mesma lista de
pessoas autorizadas. A diferença é quem escreve a resposta das mensagens de texto na conversa **privada**.

## O que muda e o que não muda

| | Motor atual | Com `MOVA_CORE_CONVERSA=RESPOSTA` |
|---|---|---|
| Texto na conversa privada de quem está na lista, unidade do piloto | comandos + respostas fixas | **MOVA CORE**: conversa natural, ferramentas de consulta, conhecimento do sistema |
| Grupos | motor atual | motor atual (sem mudança) |
| Documentos, comprovantes, áudio | motor atual | motor atual (sem mudança) |
| Respostas a perguntas pendentes do MOVA | motor atual | motor atual (sem mudança) |
| Entregadores (conversa própria) | motor atual | motor atual (sem mudança) |
| Dado restrito / pedido de pagamento | bloqueio determinístico | bloqueio determinístico (vem antes do núcleo) |
| Escrita financeira | conforme as chaves atuais | **nenhuma pelo núcleo** (montado sem operações) |
| Falha do núcleo (IA fora, orçamento, erro) | — | volta para o motor atual na mesma mensagem |

## Pré-requisitos

- **Nenhuma migração.** A memória da conversa e o conhecimento ficam no processo; a identidade é a da lista autorizada.
  Um reinício apaga só a memória curta da conversa.
- A IA do MOVA precisa estar ligada (`MOVA_IA_HABILITADA=1`, como já está em produção). O núcleo usa o **mesmo orçamento
  persistente e o mesmo controle `ia`**. Desligar a IA no controle desliga o núcleo na hora, e o motor atual assume.
- Custo medido: cerca de US$ 0,0008 por mensagem (Haiku). 14 mensagens custaram US$ 0,011.

## Passos

1. **Merge do PR e deploy**, com tudo desligado. O comportamento é idêntico ao atual, porque `MOVA_CORE_CONVERSA` fica ausente.
2. **Sombra (1 dia):** `MOVA_CORE_CONVERSA=SOMBRA` e `MOVA_CORE_CONVERSA_UNIDADES=4d3b75bd-79b5-4335-ae5b-a183580c3555`.
   - O núcleo roda e registra `MOVA_CORE_SOMBRA` nos logs, só com motivo, ferramentas, custo e latência, sem texto.
   - Quem responde continua sendo o motor atual.
   - Usar dados reais na sombra exige a sua autorização.
3. **Resposta:** `MOVA_CORE_CONVERSA=RESPOSTA` com a mesma unidade. Conversar pelo privado com o MOVA.
4. **Checklist no WhatsApp:**
   - [ ] "oi" → apresentação natural
   - [ ] contas a pagar, vencidas, por fornecedor → valores iguais aos da Central
   - [ ] faturamento de ontem, resultado do mês, caixa e bancos, sangrias, a receber, entregadores
   - [ ] "como funciona …?" → "pela documentação do sistema"
   - [ ] "registra uma despesa…" → explica que pela conversa ainda não lança; nada entra no Financeiro
   - [ ] pessoa com perfil OPERACIONAL → sem valores
   - [ ] no grupo → continua o motor atual
   - [ ] documento no privado → continua o fluxo de documentos atual

## Reversão

`MOVA_CORE_CONVERSA=DESLIGADO`, ou remover a variável, e reiniciar o serviço. Vale na hora seguinte e não toca em nenhum
dado. Mais rápido ainda: desligar a IA no controle do MOVA. As duas IAs param e o motor atual responde sem IA.

## Variáveis

| Variável | Valores | Padrão |
|---|---|---|
| `MOVA_CORE_CONVERSA` | `DESLIGADO` \| `SOMBRA` \| `RESPOSTA` | ausente = DESLIGADO |
| `MOVA_CORE_CONVERSA_UNIDADES` | ids das unidades do piloto, separados por vírgula (obrigatório fora de DESLIGADO) | — |
| `MOVA_CORE_MODELO` | só `claude-haiku-*` | o padrão do núcleo |

## Correções da 1ª homologação em produção (24–25/11)

| Problema real | Correção |
|---|---|
| "Todas as 69 contas" saíam parciais; a mesma consulta era repetida 3–4 vezes (resultado cortado em 12 mil caracteres) | `contas_a_pagar` devolve totais, totais por vencimento e **todos** os fornecedores, sempre completos. Os itens só vão quando são poucos. A nova `lista_completa_de_contas` monta a lista **no servidor**: vencimento, fornecedor, descrição, valor, pago/saldo e situação. Vai em mensagens de até 25 contas (no máximo 6 por pergunta) e cada página tem 120 contas. "continuar" traz a página seguinte. A última parte traz o total conferido e diz "Lista completa (N contas)" ou quais contas faltam. |
| `FINANCEIRO_INDISPONIVEL` e tempo esgotado em perguntas com várias consultas | O papel de leitura tem **2 conexões no total**, e no deploy duas instâncias disputavam essas conexões. Agora: no máximo 2 leituras ao mesmo tempo por mensagem, a mesma leitura é feita uma vez por mensagem, e o tempo-limite conta a partir da vaga. Há uma nova tentativa curta em falha transitória. A causa técnica (SQLSTATE) vai para a auditoria. A conexão ociosa do leitor fecha em 5 s. Pool e tempos **não** foram aumentados. |
| Total devido aos entregadores mostrava só a semana atual | `devido_aos_entregadores` soma as contas já geradas e ainda não pagas (pagamento parcial descontado, com vencimento) e o valor **provisório** das semanas ainda não fechadas, sem duplicar. Aceita todos os entregadores ou um só. Um nome ambíguo leva a uma pergunta. |
| Histórico do entregador sem datas ("outra semana") e exigindo a chave | `historico_do_entregador` resolve nome e apelido. Mostra cada semana com início e fim, entregas, valor, pago, saldo, situação da nota e do pagamento, data do pagamento e origem do dado, e separa a semana em apuração. |
| Situação de vencimento decidida pelo modelo | O servidor calcula com a data de hoje em Fortaleza: VENCIDA (dias de atraso), VENCE_HOJE, A_VENCER, LIQUIDADA e CANCELADA. Conta paga em parte continua vencida pelo saldo. |
| Troca de instância no deploy | Cada instância marca as suas conexões com a hora em que subiu. A mais nova assume a fila e a antiga termina o que já pegou e para de pegar. Cada mensagem continua sendo processada uma única vez (lease). Não há infraestrutura nova nem migração. |
| `AGRUPAMENTO_NAO_SUPORTADO` | O esquema da análise lista as combinações válidas de cada métrica. |

## Orçamento renovável — o que depende da sua autorização

Tudo já está no código, **desligado**. Os limites financeiros não mudaram: US$ 10/mês, US$ 1/dia e US$ 0,10/solicitação, também presos no código.

1. **Migração** `database/mova-financeiro/producao/aplicar-orcamento-renovavel.sql`. Aplica **só** a 0018 (política, alertas e colunas de controle) e a 0022 (tipo de uso, parte guardada para documentos e chamadas de conversa por dia), numa transação, como `postgres`.
   - Exige 0001–0017 com o mesmo sha256 (conferido em produção em 25/11).
   - Não liga nada. A política nasce com `ativo = false`.
   - Reversão: `recuperacao/reverter-0022.sql` e depois `reverter-0018.sql`.
2. **Ligar a política** (SQL de uma linha): `update mova.orcamento_ia_politica set ativo = true, atualizado_por = '<você>', atualizado_em = now();`
3. **Variável** `MOVA_ORCAMENTO_RENOVAVEL=1` no backend, seguida de reinício. Sem a variável, continua o acumulado de 500 chamadas.

Padrões da 0022:

- US$ 2 do mês e US$ 0,20 do dia ficam **guardados para leitura de documentos**: a conversa nunca usa essa parte.
- 300 chamadas de conversa por dia, renovadas à meia-noite de Fortaleza.
- Alertas em 50/80/100%, uma vez por período.

Rollback: remover a variável e reiniciar. O acumulado volta na hora.
