# MOVA — Execuções 12D e 13: primeiro recebimento real e preparação da Fase C

## 12D — mensagem real confirmada pelo relé, mas descartada no receptor

**Sintoma.** A primeira mensagem real do contato de homologação chegou ao relé (`mova_rele.evento`, estado `PROCESSADO`,
1 tentativa), mas não apareceu em `mova.fila`, `mova.decisao` nem `mova.evento`.

**Causa.** O WhatsApp identificou o celular brasileiro **sem o nono dígito** (`55`+DDD+8 dígitos). A conversa autorizada estava
cadastrada **com** ele (`55`+DDD+`9`+8). A comparação era por igualdade exata. Por isso o receptor tratou a mensagem como
conversa privada não autorizada e respondeu `IGNORADO / NAO_E_GRUPO`, sem nenhum registro (decisão 04B). O consumidor do relé
trata `IGNORADO` como descarte deliberado e confirmou.

**Correção.**
- `dominio/configuracao.js`: nova `conversaAutorizada(cfg, jid)`. Faz a comparação exata e, **só no modo HOMOLOGACAO e só
  para conversa privada de celular brasileiro**, aceita a forma com ou sem o nono dígito, desde que case com exatamente uma
  entrada cadastrada. Telefone fixo, caso ambíguo e grupo continuam exigindo igualdade exata.
- `gateway/receptor.js`: a conversa reconhecida segue com o **JID cadastrado**, que é a chave usada em fila, unidades e
  participantes. A não autorizada continua sem registro no banco, agora com um código no log (sem número).
- `gateway/consumidorRele.js`: todo `IGNORADO` confirmado registra o motivo no log. O contrato com o relé e a Edge Function
  não mudou.

**Regressão.** `backend/test/mova-financeiro/execucao12d.test.js` cobre: autorizado com e sem o nono dígito, não autorizado,
PN/LID, própria conta, duplicidade nas duas formas, falha de persistência (devolve, sem ACK), recuperação após consumidor
pausado, ACK, isolamento fora da homologação, processamento desligado.

**Recuperação (banco de teste, com autorização).** O backend local foi reiniciado com a correção. Só o evento original foi
reaberto no relé, com auditoria `REABERTO_EXECUCAO_12D`. O consumidor corrigido entregou o evento: 1 linha em `mova.fila`,
`PENDENTE`. Nada foi reenviado pelo WhatsApp.

## 13 — Fase C (IA real com WhatsApp real): estado da preparação

- **Fila.** O laço de processamento só reserva itens `PENDENTE` vencidos. Os itens `CONCLUIDO`/`FALHOU` antigos não são
  retomados. Hoje há 1 `PENDENTE` (a mensagem da Fase B).
- **Respostas antigas.** Ficam `PENDENTE` e **não saem** enquanto `envio = false` (controle no banco e variável de ambiente).
  Devem ser descartadas antes da Fase D.
- **Efeitos financeiros.** O MOVA só cria propostas. Aplicar exige revisão humana autenticada no Centro Financeiro.
- **Unidades de homologação.** Usam nomes fictícios `[MOVA-HML]`. Uma mensagem que cite uma unidade real não reconhece a
  unidade e cai em "pedir informação".
- **Bloqueador.** Não há credencial Anthropic de homologação. A única chave disponível é a de produção, e usá-la exige
  autorização específica do proprietário.

Testes desta branch: MOVA 120/120, Financeiro v2 732/732 (3 pulados), Gateway 1092/1092 (sem alterações).

## 13B/13C — primeira rodada real da Fase C (IA real, WhatsApp real, sem respostas)

Orçamento autorizado: US$ 0,10 e 5 chamadas reais. Consumido: **5 chamadas, US$ 0,089988** (registro por chamada em
`mova.consumo_ia`, separado das 8 chamadas simuladas anteriores). Teto estrito por chamada: entrada ≤ 3.200 tokens (conferida
antes, pelo endpoint gratuito de contagem; bateu exatamente com a cobrança), saída ≤ 380, esforço `low`, sem troca de modelo.

| Mensagem | Entrada/saída | Resultado | Causa | Correção |
|---|---|---|---|---|
| Saudação | 3.081 / 294 | IA: `OUTRA`; motor perguntou a unidade | o motor não tinha caminho para conversa sem pedido financeiro | `1c2dc5e`: ORIENTACAO `CONVERSA_SEM_PEDIDO_FINANCEIRO` |
| A despesa | 3.114 / **380** | truncada | o JSON obrigatório tem 24 chaves (~240 tokens) e o Opus 5.5 sempre raciocina (não pode ser desligado), mesmo em `low` | `c5a1835`: campos livres curtos; modelo configurável; raciocínio desligado no Haiku 5.5 |
| B faturamento | 3.086 / 347 | CONSULTA, dados insuficientes, sem estimar | — (correto) | — |
| C cálculo | 3.118 / **380** | truncada | idem A; além disso, **o MOVA não tem capacidade de cálculo hipotético** (a IA só classifica; as respostas são determinísticas) | documentado; sem truncar, vira orientação |
| D permissões | 3.093 / 0 | `IA_RECUSOU` registrado como "falha de leitura" | o texto pedia dados de outra empresa e nenhuma guarda determinística cobria isso | `8d3e320`: `FORA_DO_ESCOPO` antes da IA (sem chamada paga); recusa da IA vira BLOQUEADO `IA_RECUSOU` |

**Controle de acesso.** Ele nunca dependeu da IA: a unidade só é resolvida dentro do grupo ou conversa (unidade de fora ⇒
`FORA_DO_GRUPO`/BLOQUEADO), e as consultas usam a identidade de serviço só com "ver". A guarda `FORA_DO_ESCOPO` apenas recusa
mais cedo o que o próprio texto declara estar fora do escopo.

**Cálculo hipotético (Teste C).** Exige uma decisão de arquitetura: uma intenção nova com operandos estruturados e cálculo
determinístico no motor, nunca texto livre da IA. Não foi implementado.

**Estimativa para a 2ª rodada (por mensagem de texto, entrada ~3.100 tokens):**

| Modelo | Raciocínio | Saída necessária | Custo estimado por mensagem |
|---|---|---|---|
| Opus 5.5 (US$ 4/20) | sempre ligado | ~240 de JSON + raciocínio ⇒ teto de saída ≥ 800 | até ~US$ 0,028 |
| Haiku 5.5 (US$ 0,10/0,50) | desligado | ~240 ⇒ teto de saída de 500 basta | ~US$ 0,0006 |

Trocar o modelo de extração é decisão do proprietário (qualidade × custo). A configuração está pronta (`MOVA_IA_MODELO`).
