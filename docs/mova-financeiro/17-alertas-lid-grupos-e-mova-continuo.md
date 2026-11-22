# MOVA — Execução 17: alertas empresariais por LID, identificação de grupos e MOVA contínuo

Situação: **código preparado e testado; nada ligado em produção**. As duas flags do Gateway nascem desligadas.

## 1. Alertas empresariais: diagnóstico

**Sintoma.** No piloto do MOVA, a resposta era aceita pelo WhatsApp mas o destinatário ficava em "Aguardando mensagem" (celular **e** WhatsApp Web). Todos os pedidos de reenvio chegavam por **LID**, cerca de 1 segundo depois do envio: a primeira entrega não era decifrada. O envio ia ao número (`…@s.whatsapp.net`). Endereçar o **LID do mesmo contato verificado** (PR #160) resolveu.

**O envio empresarial tem o mesmo desenho** (`enviar()` resolve o número canônico e envia a ele). Nos logs das últimas 24 h do Gateway (só metadados):

| Grupo de envios | Envios | Com pedido de reenvio por LID e `message_missing` |
|---|---|---|
| Alertas fora da allowlist de reenvio (`retryResend:false`) | 14 | **14 (100%)** |
| Relatório diário e um alerta da allowlist (`retryResend:true`) | 3 | 0 |

Os pedidos chegam entre 1 e 3 segundos depois do envio; muitos se repetem cerca de 1 h depois, quando o aparelho volta a ficar online. Sem a allowlist, **não há reenvio possível**, então a mensagem fica em "Aguardando" para sempre.

**Por que o código mantinha o número.** Um comentário em `src/destinatario.js` registrava a decisão conservadora de usar o LID só para conferir retries. Ela é anterior à evidência acima.

**Correção preparada (PR #162).** `WHATSAPP_ENVIO_VIA_LID=1`, **desligada por padrão**:
- Com a flag e o LID do mesmo destinatário verificado (devolvido pelo `onWhatsApp` junto com o número confirmado), o envio vai ao LID.
- Sem a flag, sem LID ou com LID malformado, continua o número.
- **Não muda:** conteúdo, destinatário, horário, finalidade, idempotência, verificação do destinatário (antes do envio), cache de reenvio. Alertas históricos não são reenviados.
- O log `send_start` informa `via=PN|LID`.

**Teste de aceitação em produção.** Ligar a flag antes do próximo lote de alertas e conferir que os eventos `whatsapp.retry.received` e `message_missing` desse lote **somem**. **Reversão:** `WHATSAPP_ENVIO_VIA_LID=0`, sem novo código.

**Regressão (Gateway 1117/1117).** Cobertura nova: flag desligada e ligada; sem LID, vazio e malformado; destinatário desconhecido ou com jid incoerente (recusado antes de enviar); cache real de reenvio (conteúdo guardado com número e LID; `getMessage` acha por ambos); `retryResend=false` (nada guardado); falha de envio (nada guardado, erro propaga); confirmação do provedor. A deduplicação por chave de idempotência e o envio a grupos continuam cobertos pelos testes existentes, cujo caminho não mudou.

## 2. Identificação de grupos (somente leitura)

O Gateway já tinha a listagem (nome, id, tamanho), mas é um serviço **privado**: só se alcança de dentro da rede do Render. O PR #162 acrescenta `WHATSAPP_DIAGNOSTICO_GRUPOS=1` (padrão: desligado), que **uma vez por processo, depois de conectar**, emite um evento `gateway.diagnostico_grupo` por grupo da conta, com:
- id, nome, tamanho e modo de endereçamento (`pn` ou `lid`);
- se só administradores enviam, se a conta é administradora, e o número de administradores;
- **só contagens** de participantes com número, com LID e somente-LID, e os **4 últimos dígitos** dos administradores.

**Garantias:** não envia nada, não cadastra nada, não autoriza nada (estar no grupo **não** é autorização financeira) e números completos nunca saem. É exceção deliberada à regra "nunca loga nomes" da listagem normal, pedida pelo proprietário para reconhecer o grupo pelo nome. A relação privada fica fora do Git.

**Uso:** ligar a flag, ler os eventos nos logs do Render, **desligar a flag**. Autorizar participantes é decisão do proprietário, grupo a grupo (trabalho do Agente 2).

## 3. MOVA contínuo: o que existe e o que falta

Objetivo: o MOVA atender todos os dias sem depender do backend local nem de ativações manuais.

| Capacidade | Já existe | Falta |
|---|---|---|
| **Worker persistente** | worker e enviador embutidos no backend (`iniciarMovaEmbutido`), com lease e recuperação após reinício | rodar no backend de produção (hoje só local) |
| **Filas** | `mova.fila` (reserva com lease de 120 s, tentativas com espera crescente) e `mova.resposta` (envio idempotente, lease, teto) | — |
| **Recebimento** | canal direto Gateway → backend, assinado por HMAC próprio (`/internal/mova/eventos/mova-grupo`); relé só na homologação | configurar URL e segredo do canal no Gateway e no backend |
| **Processamento autorizado** | só conversas e unidades cadastradas; controle em tempo real no banco (`mova.controle`) | — |
| **Orçamento de IA** | `mova.orcamento_ia` imposto no banco, só Haiku 5.5, teto por chamada | política mensal e alerta de saldo baixo |
| **Monitoramento** | `GET /mova/estado` (fila, respostas, worker, controle, orçamento) | **vigia externo com alerta** |
| **Auditoria** | `mova.auditoria`, histórico de decisões e consumo de IA | — |
| **Recuperação** | testes de reinício, falha antes do envio, confirmação perdida, duplicidade | — |
| **Interruptor de emergência** | `mova.controle` (efeito imediato), `MOVA_SUSPENSO` (variável), flag do Gateway | roteiro único e botão no Centro Financeiro |
| **Isolamento** | escopo por conversa e unidade; leitura só pela credencial de leitura (0028) com sessão de 5 min e RLS | modo de produção para várias unidades |

### Lacunas a construir (menor conjunto)
1. **Modo `PRODUCAO` do MOVA** (hoje existem `SIMULACAO`, `HOMOLOGACAO` e `PILOTO`, que exigem o banco de homologação marcado). Estado do MOVA no banco de produção, com papel próprio e **credencial distinta da aplicação**; leitura do Financeiro pela credencial de leitura da 0028; sem relé; unidades definidas pela configuração, uma concessão "ver" por unidade; grupos só quando o Agente 2 entregar a autorização por participante.
2. **Esquema `mova` em produção:** migrações 0001 a 0004 (a numeração das próximas vem depois da última na `main`) e o login `mova_app`.
3. **Variáveis no Render:** no backend, `MOVA_*`; no Gateway, `WHATSAPP_MOVA_BACKEND_URL` e `WHATSAPP_MOVA_BACKEND_SECRET` (segredo próprio, nunca o principal) e as flags de envio.
4. **Vigia com alerta**, reaproveitando o pipeline de alertas da Comunicação: item na fila parado há N minutos, respostas com falha, Gateway sem lease, saldo de IA abaixo de 20%.
5. **Política de orçamento:** teto mensal e diário, **sem ampliação automática**; decisão do proprietário.
6. **Roteiro de emergência** em um só lugar (controle no banco, `MOVA_SUSPENSO`, flag do Gateway, revogação da concessão).
7. **Capacidade:** o backend roda numa instância pequena (0,5 CPU, 512 MB). Medir a memória com o MOVA ligado e, se preciso, separar o worker em serviço próprio.

### Sequência até o uso diário (conversa privada, uma unidade)
Cada passo que escreve em produção ou em serviço compartilhado exige a autorização do proprietário.
1. **Código do modo `PRODUCAO`**, com testes (Agente 1). PR e revisão.
2. **Esquema `mova` e login** em produção (migração).
3. **Configuração:** conversa privada autorizada e unidade, no banco de produção do MOVA.
4. **Variáveis** do backend e do Gateway.
5. **Vigia e alertas.**
6. **Ativação supervisionada:** uma pergunta real, conferência, depois liberar o uso diário com o orçamento definido.
7. **Grupos:** só depois do incremento de autorização por participante do Agente 2, revisado e integrado.

### Dependências do Agente 2
O incremento de grupos altera `motor.js` e `receptor.js` (fluxos de grupo) e cria uma migração nova do esquema `mova`. O modo de conversa privada não muda. Cada incremento entra por PR sobre a `main`, passa pela revisão do Agente 1 e é implantado de forma coordenada, sem esperar as demais frentes.
