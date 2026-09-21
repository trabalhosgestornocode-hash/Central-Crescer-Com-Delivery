# Investigação da fila offline do WhatsApp Gateway — C.9 → G.4.1

Registro de fechamento da linha de investigação sobre por que a sincronização
offline do Baileys (`gateway-whatsapp/`) nunca converge para o marcador de fim
de fila (`CB:ib,,offline`) nesta conta. Cobre da causa original (C.9) até a
decisão operacional final (G.4.1). Todas as ações descritas foram feitas em
produção, num número de teste, com caps e guardas explícitos — nunca em modo
exploratório sem rede de segurança.

## 1. Cronologia resumida

| Checkpoint | O que foi feito |
|---|---|
| C.9 | Descoberta do sintoma: o socket nunca esvazia o offline queue; buffer do Baileys nunca é liberado (fim de offline não chega). |
| C.9.7 (OBSERVE) | Watchdog só-diagnóstico (`offlineObserve.js`) publicado — nunca flusha, nunca envia, só mede. Primeiro overlap direto: 38% dos nós se repetem entre gerações de socket. |
| G.0–G.1 | `offlineRecovery.js` (motor de recovery) escrito e testado, publicado **sempre OFF** por padrão (feature flag `WHATSAPP_OFFLINE_RECOVERY_ENABLED`). |
| G.2.1 | Caps de recovery tornados configuráveis por env (fail-closed), publicados com recovery OFF. |
| G.2.2 | Canário real de **1 batch adicional** no companion já autenticado — servidor aceitou o `offline_batch` extra sem reconectar/QR. |
| G.3.0 | Hardening pré-drain (auditoria, sem mudar a engine): corrigido `RECOVERY_PATH_USED` (estava sempre `false`, não refletia o motor real) e o bug de `.catch()` em `_forcarFailSafe()`. Auditoria confirmou (ver §3) que o servidor confirma (ACK/receipt) nós offline **independente do flush local**. |
| G.3.1 | Corrigido o único risco remanescente na engine: `maxRecoveryDurationMs` podia cortar um batch em voo, perdendo nós silenciosamente. Adicionada janela de graça limitada, sempre preemptável por marker/socket_closed. |
| G.3.2/G.3.3 | Auditoria de auth headroom; alinhamento de capacidade do auth-state entre backend e Gateway (fail-closed nos dois lados) e transição controlada 1 MiB → 2 MiB, mantendo o guard em 85%. |
| G.4.0 | **Dreno controlado único** com objetivo explícito de alcançar o marcador. Não alcançou — terminou por `no_progress`. Resultado e correções de classificação em §4. |
| G.4.1 | Fechamento da linha de investigação: recovery volta a OFF por padrão em produção; dívidas técnicas registradas; nenhuma nova tentativa automática. |

## 2. Comportamento observado do Baileys (evidência real, não documentação oficial)

- O servidor WhatsApp entrega a fila offline em frames `offline_batch`
  sucessivos, cada um até ~100 nós, terminando (quando o servidor decide) com
  um marcador (`CB:ib,,offline`).
- **CONFIRMADO** (auditoria G.3.0, via o protótipo `offlineFailsafe.proto.js`
  já existente): o Baileys envia `sendMessageAck`/`sendReceipt` para cada nó
  offline decifrado **num bloco `finally`, independente de `ev.flush()`**.
  Ou seja: do ponto de vista do servidor, um nó offline recebido pela
  aplicação já foi "consumido" assim que é decifrado — mesmo que a aplicação
  nunca o processe localmente (sem flush, sem `messages.upsert`).
- Isso significa que fechar o socket (ou reiniciar o processo) com nós ainda
  no buffer interno do Baileys **perde esses nós localmente para sempre**,
  sem que o servidor os reenvie como "offline" numa próxima conexão — ver
  ressalva de classificação em §4.2.
- O servidor **aceita batches adicionais** além do que a conexão "normal"
  (sem recovery) já buscava — confirmado tanto no canário de 1 batch (G.2.2)
  quanto nos 8 batches consecutivos do dreno (G.4.0). Não há, do lado do
  protocolo, um teto rígido conhecido de batches por sessão.

## 3. Auditoria de risco pré-drain (G.3.0)

- `RECOVERY_PATH_USED` era hardcoded `false` em `offlineObserve.js` — nunca
  refletia se o motor de recovery real estava ativo. Corrigido com um leitor
  injetado (`lerRecoveryUsado`), sem mudar a lógica de decisão da engine.
- `_forcarFailSafe()` e outros 3 pontos de fechamento de socket em
  `baileysSession.js` tinham `await socket.end?.(undefined).catch(() => {})`,
  que lança `TypeError` quando `end()` não retorna uma Promise — corrigido com
  um helper único (`fecharSocketBestEffort`) usado nos 4 pontos.
- `maxRecoveryNodes` foi auditado e **não** tem o mesmo risco de corte em
  voo que `maxRecoveryDurationMs` tinha antes do fix do G.3.1.

## 4. Resultado do dreno controlado (G.4.0) — e correções de classificação (G.4.1)

Sessão única, caps dimensionados a partir do `preview.count` real
(~10 mil), terminou por `no_progress` em 45,47s:

```
8 batches, 801 nós recebidos, 413 únicos, 388 duplicados
L1: 94 únicos  L2: 87  L3: 67  L4: 84  L5: 66  L6: 15  L7: 0  L8: 0
```

### 4.1 Classificação corrigida da sequência de unicidade

A sequência `94 / 87 / 67 / 84 / 66 / 15 / 0 / 0` **não é monotônica**
(L4=84 > L3=67). A classificação correta é: **tendência geral de redução de
unicidade, terminando em dois batches consecutivos sem progresso** — não
"queda monotônica" como descrito no relatório original do G.4.0.

### 4.2 Classificação corrigida da perda dos 413 nós únicos

- Perda **local** (não persistidos, não flushados, buffer descartado no
  restart que desativou o recovery): **CONFIRMADO**.
- Perda **permanente do lado do servidor** (i.e., que o WhatsApp nunca mais
  os considerará "pendentes" para esta conta): **NÃO DETERMINÁVEL**. O ACK
  automático do Baileys (§2) é evidência de que o servidor os marcou como
  entregues, mas isso não é prova de que o servidor nunca os reenviaria por
  outro caminho (ex.: numa re-sincronização completa, um novo pareamento,
  etc.). **ACK não deve ser tratado como prova de remoção definitiva do lado
  do servidor** — só como confirmação de entrega àquela conexão específica.

### 4.3 Fatos confirmados do dreno

- CONFIRMADO: servidor aceita `offline_batch` adicional além do fluxo normal.
- CONFIRMADO: múltiplos `offline_batch` consecutivos (8) também são aceitos.
- CONFIRMADO: houve progresso real e substancial (413 nós únicos).
- CONFIRMADO: o progresso terminou em repetição total (L7 e L8 = 100% duplicado).
- CONFIRMADO: o marcador não chegou.
- CONFIRMADO: nenhum flush nativo ocorreu (sem marcador, o motor nunca aciona flush).
- CONFIRMADO: a fase LIVE nunca foi alcançada durante o dreno.
- CONFIRMADO: o recovery terminou corretamente por `no_progress`, dentro de
  todos os limites configurados (nenhum teto de segurança foi tocado).

### 4.4 Leitura pós-dreno do `preview.count` (natural, sem novo recovery)

Comparação feita com o **próximo `offline_preview` natural**, sem ativar
recovery de novo:

| | Antes (epoch 25, pré-dreno) | Depois (epoch 26, primeiro boot natural pós-dreno) | Delta |
|---|---|---|---|
| count | 10.091 | 9.767 | −324 |
| message | 4.049 | 3.929 | −120 |
| receipt | 4.975 | 4.783 | −192 |
| notification | 1.044 | 1.032 | −12 |
| status | 22 | 22 | 0 |

EVIDÊNCIA COMPATÍVEL com alguma redução real de backlog do lado do servidor
após o dreno — mas não é prova definitiva, porque a composição/semântica
exata do `preview.count` não é totalmente compreendida (§5).

## 5. `preview.count` não é um contador confiável de "quanto falta"

`preview.count` mistura `message` + `receipt` + `notification` + `status` (e
`call`/`appdata`, tipicamente zero nesta conta) e **varia com atividade
contínua** — foi visto subindo (10.069 → 10.091) entre duas leituras normais
sem recovery, e caindo (10.091 → 9.767) após um dreno. **Não deve ser lido
como "N mensagens pendentes de sincronizar"**, nem usado para prever quantos
batches faltam até o marker. Documentar isso evita a armadilha de tratar
qualquer leitura futura desse campo como progresso ou regressão reais.

## 6. Causa raiz — classificação final

- **Por que o WhatsApp nunca envia o marcador nesta conta**: NÃO
  DETERMINÁVEL. Não há acesso ao lado servidor do protocolo para confirmar.
- **Hipótese de conjunto residual reentregue** (o servidor reenvia
  repetidamente um subconjunto pequeno e finito de nós "novos", sem nunca
  fechar a fila com o marcador): EVIDÊNCIA COMPATÍVEL / HIPÓTESE FORTE — não
  deve ser tratada como fato confirmado do lado do servidor sem evidência
  adicional (ex.: uma nova sessão pareada do zero mostrando o mesmo padrão).

## 7. Auth-state — capacidade e dívida técnica

- Capacidade atual: **2 MiB** nos dois serviços (backend e Gateway),
  parsing fail-closed nos dois lados, mesmo teto estático de 4 MiB como
  checagem cruzada. Guard de headroom: **85%**, inalterado.
- Dívida técnica registrada (problema **separado** do recovery offline):
  as categorias `pre-key` e `sender-key` do auth-state continuam crescendo
  ao longo do tempo (ver histórico em `whatsapp-c9-auth-state-crescimento`
  na memória do projeto). Isso não foi limpo nem investigado a fundo neste
  checkpoint — fica como próxima linha de investigação, independente da fila
  offline.

## 8. Backpressure — dívida técnica não validada

A fila de entrada (`filaConcorrenciaLimitada.js`) tem **profundidade
ilimitada** e concorrência limitada (4) — nunca descarta itens, apenas
atrasa. No G.4.0 ela nunca foi realmente testada sob carga de flush, porque
**nenhum flush ocorreu** (sem marcador). Ou seja: **o cenário de milhares de
`messages.upsert` simultâneos (um flush real de uma fila grande) continua
NÃO validado**. Não afirmar que a fila suporta esse volume só porque o dreno
rodou sem erros — o dreno nunca chegou a exercitar esse caminho.

## 9. Política operacional final desta fase

- `WHATSAPP_OFFLINE_RECOVERY_ENABLED=false` por padrão e em produção.
- O código do motor de recovery **permanece publicado**, atrás do feature
  flag, para diagnóstico/desenvolvimento futuro — não removido.
- Os caps usados no G.4.0 (`maxRecoveryBatches=100`, `maxRecoveryNodes=12000`,
  `maxRecoveryDurationMs=900000`, `maxConsecutiveNoProgressBatches=2`) foram
  **experimentais**, dimensionados para uma única sessão de investigação.
  **Não constituem configuração recomendada de produção.**

## 10. Ações proibidas / seguras daqui em diante

**Proibido sem nova decisão explícita:**
- Ativar `WHATSAPP_OFFLINE_RECOVERY_ENABLED` em produção.
- Repetir o dreno com os mesmos parâmetros esperando um resultado diferente.
- Aumentar os caps de recovery além dos usados no G.4.0.
- Implementar flush manual/forçado.
- Subir o guard de auth headroom acima de 85% ou a capacidade acima de 2 MiB
  sem nova análise.
- Limpar/resetar prekeys, sessions, sender-keys ou o auth-state.
- QR, logout, reset ou re-pareamento manual do companion.

**Seguro, a qualquer momento:**
- Ler logs/telemetria (OBSERVE, `auth_state.metricas`, `offline_preview`)
  sem ativar recovery.
- Consultar este documento e o histórico de checkpoints para decidir se vale
  abrir uma nova linha de investigação.

## 11. Próximos passos (fora de escopo deste checkpoint)

Qualquer tentativa futura de resolver definitivamente este caso deve ser
tratada como um **novo projeto/linha de investigação**, provavelmente
exigindo uma destas abordagens (nenhuma implementada aqui):

- Mudança no tratamento do buffer offline (persistir antes do ACK, não depois).
- Persistência segura anterior ao ACK do Baileys.
- Mudança, fork ou upgrade controlado da versão do Baileys.
- Investigação upstream do protocolo (por que o servidor não emite o marker).
- Uma estratégia que não dependa do marcador nativo para dar por concluída a
  sincronização offline.
