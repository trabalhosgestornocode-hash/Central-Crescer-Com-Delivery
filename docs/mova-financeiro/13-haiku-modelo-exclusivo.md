# MOVA — Claude Haiku 5.5 como modelo exclusivo: decisão, implementação e prontidão

**Decisão do proprietário (21/11/2026).** O MOVA usa exclusivamente o `claude-haiku-5-5`, sem fallback automático. A IA só
interpreta a mensagem: intenção, valores, datas, categoria, unidade e o que falta. Cálculos, validações, conciliação,
permissões e regras financeiras ficam no backend. Operações financeiras viram propostas para revisão humana.

## Implementado (commit `4cce944`; nenhuma chamada paga)

- `MODELO_PADRAO = claude-haiku-5-5` e lista fechada `MODELOS_PERMITIDOS = [claude-haiku-5-5]`. O modelo é conferido em três
  pontos:
  - na **montagem** do extrator (outro modelo lança erro);
  - na **configuração** (`MOVA_IA_MODELO` diferente ⇒ `MODELO_IA_NAO_PERMITIDO` ⇒ o MOVA não liga);
  - na **resposta**: se outro modelo responder, a saída é descartada (`IA_MODELO_INESPERADO`). O custo continua registrado.
- Sem `betas`/`fallbacks` em nenhuma requisição. O teto estrito (`f397612`) também os remove.
- Raciocínio desligado (`thinking: disabled`, aceito pelo Haiku 5.5 com esforço até `high`). Saída padrão: 600 tokens. O JSON
  do contrato ocupa ~240 tokens.
- Custo por modelo que respondeu (Haiku: US$ 0,10 / 0,50 por milhão). Corrigido o sufixo de data do identificador do modelo.
- Recursos usados pelo contrato e confirmados na documentação para o Haiku 5.5: saída estruturada `json_schema`, `effort`,
  imagens e PDF.

## Capacidades atuais (com testes simulados)

| Área | Situação |
|---|---|
| Interpretação de texto, comprovante, boleto e nota (imagem/PDF) | pronta no contrato; **qualidade do Haiku ainda não medida com chamadas reais** |
| Valor em centavos, datas relativas, dúvida ⇒ pergunta | regra no prompt + validação estrita da saída (chaves fechadas, enums, tipos) |
| Unidade | determinística no backend (a IA só sugere); ambígua ⇒ pergunta; de fora do grupo ⇒ bloqueio |
| Propostas | só propostas; aplicar exige login + permissão no Centro Financeiro; duplicidade por evento e por documento (sha256) |
| Consultas | 12 ferramentas de leitura fechadas, com a identidade de serviço só com "ver"; sem dados ⇒ "não há dados", sem estimar |
| Segurança | dado restrito e pedido fora do escopo barrados **antes** da IA; injeção marcada; recusa da IA ⇒ bloqueio; mascaramento nas respostas |
| Orçamento | reserva antes, limite de chamadas e de custo no banco, teto por chamada (entrada conferida antes, saída limitada) |

## Limitações e melhorias necessárias no motor

1. **Respostas não são "naturais".** São modelos de texto fixos (`aplicacao/respostas.js`). Para respostas naturais com dados
   reais, a proposta é a IA **redigir** a partir de um objeto já calculado pelo backend (números prontos, sem acesso a
   ferramentas), com validação de que todo número da resposta está no objeto. É uma segunda chamada por mensagem (~US$ 0,0005).
2. **Sem cálculo hipotético (Teste C).** Precisa de uma intenção `SIMULAR` com operandos estruturados (receita, custos) e
   aritmética no backend, com a resposta deixando claro "antes das demais despesas, não é lucro líquido".
3. **Sem memória de conversa.** Só a mensagem citada (respostaA) entra como contexto. Perguntas de continuação ("e no mês
   passado?") não funcionam.
4. **Contrato longo para o Haiku.** São 24 chaves obrigatórias para toda mensagem. Uma saída em duas camadas (intenção primeiro,
   campos financeiros só quando houver pedido financeiro) reduziria tokens e erros de preenchimento.
5. **Qualidade não medida.** Faltam um conjunto de avaliação (mensagens fictícias com o resultado esperado) e métricas: acerto
   de intenção, valor exato em centavos, categoria, unidade, recusa correta e taxa de "pedir esclarecimento".
6. **Áudio.** Não há provedor de transcrição.
7. **Respostas antigas pendentes.** As 24 da fila de saída devem ser descartadas antes da Fase D.

## Próxima rodada real (depende de autorização de orçamento)

- **Perfil local pronto:** `MOVA_IA_MODELO=claude-haiku-5-5`, teto de entrada 3.200 e saída 600 tokens, esforço `low`.
  Pior caso por chamada: 3.200 × 0,10 + 600 × 0,50 = **US$ 0,00062**.
- **Primeiro passo:** confirmar, pelo endpoint gratuito de contagem, que a requisição com `thinking: disabled` é aceita.
- **Sugestão:** US$ 0,05 e 30 chamadas, o suficiente para o conjunto de avaliação (~20 mensagens fictícias) e para repetir os
  testes A–D pelo WhatsApp.
- **Antes de ligar:** ajustar `mova.orcamento_ia` com o consumo anterior como linha de base (ele já soma US$ 0,298, dos quais
  US$ 0,09 reais com Opus), registrar o ajuste na auditoria e manter o envio desligado.

## Execução 14 — resultados (Haiku 5.5 real; US$ 0,02 e 25 chamadas autorizados)

**Avaliação pela API (17 casos do conjunto, contexto fictício com 2 unidades): 16/17 aprovados, US$ 0,008245.**

| Critério | Acertos |
|---|---|
| Intenção | 13/13 |
| Valor exato (centavos) | 12/12 |
| Unidade | 15/15 |
| Categoria | 6/6 |
| Data | 5/5 |
| Propostas corretas campo a campo | 7/7 |
| JSON válido | 17/17 |
| Sem truncamento | 17/17 (saída máx. 348 tokens) |

Falhas da IA, corrigidas no backend sem nova chamada (`5ef5daa`):
- **C22:** "faça o pagamento… pelo banco" foi lido como `REGISTRAR_CONTA`. Agora há uma guarda determinística antes da IA.
- **C14:** a IA presumiu "hoje" sem que a data tivesse sido dita. Agora há regra explícita no prompt, coberta pelo caso C23.

**Rodada pelo WhatsApp real (8 mensagens, unidade [MOVA-HML] Sanduíches Centro): 4/8 conforme o gabarito.**

| # | Teste | Resultado | Situação |
|---|---|---|---|
| 1 | Despesa paga R$ 150,00 | `FALHA_LEITURA IA_TETO_ENTRADA_EXCEDIDA` | ✗ teto |
| 2 | Conta R$ 289,90 | idem | ✗ teto |
| 3 | Faturamento | `CONSULTA FATURAMENTO:DADOS_INSUFICIENTES`, Sanduíches Centro | ✓ |
| 4 | Embalagens R$ 420,00 | idem 1 | ✗ teto |
| 5 | Unidade não identificada | `PEDIR_INFORMACAO UNIDADE_NAO_IDENTIFICADA`; IA: pagamento, 9.500, 21/11, MATERIAL_DE_LIMPEZA | ✓ |
| 6 | Incompleta | `PEDIR_INFORMACAO VALOR_AUSENTE`, Sanduíches Centro | ✓ |
| 7 | Outra empresa | `BLOQUEADO FORA_DO_ESCOPO`, **sem chamada** | ✓ |
| 8 | Duplicidade | idem 1 (não exercitou a deduplicação) | ✗ teto |

**Causa das 4 falhas: calibração do teto de entrada (3.400 tokens).** O teto foi medido no contexto da avaliação (2 unidades
de nome curto). O contexto real lista 3 unidades `[MOVA-HML] …`, e as chamadas aceitas já tinham 3.397–3.399 tokens; as
mensagens um pouco mais longas passaram do limite. A recusa acontece **antes** da reserva: as 4 não foram cobradas e nada foi
criado (falha segura). Correção: teto de 4.000 tokens no perfil de homologação (pior caso US$ 0,0007 por chamada). Os testes 1,
2, 4 e 8 **não foram reenviados** (sem autorização para repetir).

**Consumo da rodada Haiku:** 20 chamadas, US$ 0,009738 (17 da avaliação + 3 do WhatsApp). Saldo: 5 chamadas e US$ 0,010262.
Histórico preservado: 8 simuladas (US$ 0,208) e 5 reais com Opus (US$ 0,089988).

**Segurança.** Zero respostas enviadas (36 pendentes, presas pelo envio desligado), zero propostas aplicadas, nenhum grupo, só
Haiku. Ao final, processamento e IA desligados no banco e no backend local; recebimento privado ligado.

**Para concluir a Fase C:** reenviar 1, 2, 4 e 8 com o teto corrigido (4 chamadas, cabem no saldo). Isso depende de autorização
para reenvio.
