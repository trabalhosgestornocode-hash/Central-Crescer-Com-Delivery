# MOVA — Execução 15B: caminho de retorno pelo relé e correção do G-1

Nenhum envio real, nenhuma alteração no Render, nenhum deploy, nenhuma chamada paga.

## Correção do documento 14

O doc 14 dizia que o backend local chamaria o Gateway por HTTPS. **Isso é impossível.** A consulta ao Render (só leitura)
mostra que `gateway-whatsapp` é um **`private_service`**, cujo único endereço é interno (`gateway-whatsapp-egaf:10000`), sem
URL pública. A rota `/internal/mova/messages` só é alcançável de dentro da rede privada do Render.

## G-1 — causa

- `enviarGrupoMova` gera o id da mensagem com `generateMessageIDV2` (aleatório).
- A chave de idempotência só vai para o log (`correlationId`).
- O Gateway não tem banco próprio: tudo o que ele persiste (lease, auth state, cache de retry) vai pelo backend de produção,
  e a deduplicação dos envios empresariais é feita **no backend** (`UNIQUE idempotency_key` + reserva atômica).

Para o MOVA de homologação não há essa camada. Se a resposta HTTP se perde depois do envio, uma nova tentativa gera uma
segunda mensagem.

## Arquitetura de retorno (implementada, não implantada)

```
backend MOVA (local) ──papel mova_rele_consumidor──► publicar_saida(id = id da resposta) ──► mova_rele.saida  (Supabase de TESTE)
gateway-whatsapp (privado) ──HTTPS de SAÍDA, HMAC do canal──► Edge Function mova-rele /internal/mova/saida
                                                              └► saida_gateway(): reservar → [envio Baileys] → confirmar | falhar
backend MOVA ◄── estado_saidas(ids) ── sincroniza ENVIADA / INCERTA / FALHOU / CANCELADA em mova.resposta
```

- **Mesmo princípio da entrada:** o Gateway só faz conexões de saída e nenhum endpoint dele é exposto. O segredo continua sendo
  o do canal MOVA, conferido **no banco**, com janela de 60 s, nonce de uso único e auditoria de recusas.
- **Estados no relé:** `PENDENTE → RESERVADA → ENVIADA`.
  - Falha **antes** do envio volta a `PENDENTE` (até 3 vezes), senão `FALHOU`.
  - Falha **depois** de tentar enviar, ou lease vencido, vira `INCERTA`.
  - Confirmação atrasada de uma `INCERTA` vira `ENVIADA`: é evidência de envio.
  - `CANCELADA` = saída desligada.
- **Interruptor no relé (`mova_rele.controle_saida`):**
  - a suspensão do envio no MOVA chega ao relé no próximo ciclo do enviador;
  - o relé para de entregar ao Gateway e cancela as pendentes;
  - o relé pode ser desligado direto com `mova_rele.definir_saida(false, ...)`, sem depender do Gateway.
- **Gateway:** `movaSaida.js` (PR do Gateway).
  - É inerte salvo canal ativo + `WHATSAPP_MOVA_ENVIO_HABILITADO=1` + contato verificado.
  - Só a instância **líder** do lease age.
  - Lote padrão de 1 e intervalo de 5 s.
  - Só a confirmação é repetida; o envio nunca.

## Garantias e limitações (reais)

| Situação | Resultado |
|---|---|
| Mesmo id publicado de novo | nada novo (PK) |
| Dois Gateways ou requisições simultâneas | um único envio (reserva atômica) |
| Já `ENVIADA` | nunca reenviada |
| Falha comprovadamente antes do envio | nova tentativa segura (até 3) |
| Erro depois de tentar enviar | `INCERTA`, sem reenvio, revisão humana |
| Confirmação HTTP perdida | lease vence, `INCERTA`, sem reenvio |
| Reinício do Gateway | estado no relé; o processo novo não reenvia |
| Persistência | no banco do relé; não depende da memória de nenhuma instância |

**Não há garantia de exatamente uma entrega.** Se o Gateway cair entre o `sendMessage` e a confirmação, não há como saber se o
WhatsApp entregou: a saída fica `INCERTA` e vai para revisão humana. O que se garante é **nunca um segundo envio automático**.

## Testes (sem WhatsApp real)

`backend/test/mova-financeiro/saidaRele.test.js` usa as peças reais (SQL 0001+0002, papéis mínimos, Edge Function, módulo do
Gateway, enviador do MOVA). Resultado: 12/12, cobrindo os 15 cenários pedidos:
1. envio único;
2. simultâneas;
3. repetição após sucesso;
4. falha antes do envio;
5. falha depois de enviar;
6. confirmação perdida;
7. reinício;
8. resposta anterior ao marco;
9. contato não autorizado;
10. grupo;
11. assinatura inválida;
12. suspensão;
13. desligamento durante o lote;
14. ordem;
15. Gateway inerte e fora da liderança.

Sem o módulo do Gateway na árvore, o teste é **pulado com motivo**.

Gateway: 1098/1098 (as 1092 anteriores intactas + 6 novas). MOVA: 170/170.

## Inventário das respostas pendentes (nova prévia, 15B)

40 respostas: 23 para o número fictício (conversa desativada, eventos sintéticos da 12A) e 17 para o contato real autorizado
(testes da Fase C). Nenhuma tentativa de envio.

O código de confirmação é o hash exato dos ids + motivo + corte. Como o conjunto não mudou, o código continua o mesmo; qualquer
mudança no conjunto muda o código e o script recusa. **Nada foi descartado.**

## Implantação (cada passo exige autorização própria) e rollback

1. **Homologação (Supabase de teste):**
   - aplicar `0002_mova_rele_saida.sql` como o papel dono;
   - publicar a nova versão da Edge Function `mova-rele` (com `verify_jwt=false`, como hoje).

   Rollback: a saída nasce **desligada**; para remover, `drop` das funções e tabelas novas da 0002. A entrada (0001) não muda.
2. **Gateway (PR próprio):**
   - merge (autoDeploy desligado: nada é publicado);
   - deploy manual numa janela combinada (cerca de 15 s de reconexão), com a flag **desligada**: efeito nulo.

   Rollback: deploy do commit anterior.
3. **Descarte das 40 respostas** (script com prévia e código).
4. **Ativação para o primeiro teste:**
   - Render: `WHATSAPP_MOVA_ENVIO_HABILITADO=1`, com reinício;
   - backend local: `MOVA_ENVIO_HABILITADO=1` + `MOVA_ENVIO_NAO_ANTES_DE=<agora>` (o relé já está configurado);
   - controle do MOVA com `envio=true`.

   Rollback imediato:
   - `envio=false` no controle do MOVA, que desliga a saída no relé e cancela as pendentes;
   - ou `mova_rele.definir_saida(false)`;
   - depois, a flag do Render de volta a 0.

## Primeiro teste bidirecional (planejado, não executado)

- **Mensagem:** "Olá MOVA, você está funcionando?"
- **Resultado esperado:**
  - o Haiku classifica como conversa (1 chamada);
  - o motor gera `ORIENTACAO CONVERSA_SEM_PEDIDO_FINANCEIRO`, com texto fixo e sem número;
  - 1 resposta é publicada no relé, 1 reserva, 1 envio e 1 confirmação;
  - a resposta chega **só** ao contato autorizado;
  - nenhuma proposta, nenhum grupo envolvido.

- **Evidências a coletar:**
  - evento de entrada;
  - `mova.resposta` em `ENVIADA`, com o id do provedor;
  - `mova_rele.saida` em `ENVIADA`;
  - auditoria `SAIDA_RESERVADA` e `SAIDA_ENVIADA`;
  - consumo de 1 chamada Haiku.

- **Orçamento:** saldo atual de 1 chamada Haiku (US$ 0,008274), suficiente para este teste.

## Execução 15C — implantação no Supabase de HOMOLOGAÇÃO (feita) e saída DESLIGADA

**Ambiente:** projeto `wiqqsxnysbzhcrzrrean`, banco com a marca `MOVA_HOMOLOGACAO:…`, schema `mova_rele` com dono
`homolog_instalador`. Produção não foi tocada. O Gateway e o Render não foram alterados.

**Auditoria antes de aplicar** (corrigida em `2c8d32a`, com testes):
- **A-1:** faltava revogar `EXECUTE` das funções novas de `anon`/`authenticated`/`service_role` (a 0001 já fazia isso).
- **A-2:** `lote` não numérico gerava exceção (503) em vez de 400.

**Aplicação:**
- Migração `0002` aplicada pelo instalador local (`rele-instalar.mjs saida`): papel dono, marca conferida, uma transação, fila de
  entrada conferida antes e depois (31 eventos, intacta) e saída **desligada** conferida antes do commit.
- **Edge Function `mova-rele` v4** publicada (`verify_jwt=false`, como a v3), com fonte idêntica à do repositório.

**Testes pós-implantação** (função e banco reais, assinatura feita localmente no papel do Gateway, destino fictício, sem
Gateway, sem WhatsApp, sem IA): 10/10.
1. Recebimento: evento sintético 202; repetido DUPLICADO; consumido pelo backend local e descartado pelo MOVA sem registro.
2. Saída desligada: reservar devolve vazio.
3. Republicar o mesmo id: 1 linha.
4. Destino de grupo: recusado.
5. Assinatura inválida, cabeçalho ausente e replay: 401.
6. Duas reservas simultâneas: cada saída reservada uma vez.
7. Estados confirmar → ENVIADA e falhar pós-envio → INCERTA.
8. Suspensão: reservar devolve vazio.

Os papéis públicos não têm `USAGE` no schema nem `EXECUTE`/`SELECT` nos objetos novos. As 40 respostas antigas não estão no
relé. Restam 3 saídas sintéticas (destino fictício) como histórico; a que ficou `RESERVADA` vira `INCERTA` na próxima reserva,
e nunca é enviada.

**Rollback operacional** (preserva tabelas, auditoria e dados):
- `select mova_rele.definir_saida(false, '<quem>')` — estado atual; cancela as pendentes;
- `envio=false` no controle do MOVA, que propaga o desligamento ao relé;
- não publicar (backend sem `MOVA_ENVIO_HABILITADO`).

**Rollback de código:**
- republicar a Edge Function v3 a partir de `C:\dev\mova-homologacao\edge-mova-rele-v3\` (cópia da fonte publicada) ou de
  `git show 2c8d32a~4:supabase/functions/mova-rele/`;
- conferir o recebimento com um evento sintético (202).

As tabelas da 0002 **não** são apagadas automaticamente: a v3 simplesmente não as usa.

**Próximo passo mínimo para o Gateway:** merge do PR #155 e deploy manual numa janela combinada, com
`WHATSAPP_MOVA_ENVIO_HABILITADO` ainda **desligado**. O efeito é nulo (log `mova.saida_config ativo:false`). Só depois, com
autorização separada: descarte das 40 respostas e ativação.
