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
