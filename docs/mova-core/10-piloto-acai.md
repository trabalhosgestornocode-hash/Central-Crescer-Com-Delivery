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
2. **Sombra (1 dia):** `MOVA_CORE_CONVERSA=SOMBRA` e `MOVA_CORE_CONVERSA_UNIDADES=<unidadeId do Açaí Saci>`.
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
