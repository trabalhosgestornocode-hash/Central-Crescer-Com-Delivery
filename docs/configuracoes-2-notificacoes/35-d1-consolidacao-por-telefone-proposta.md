# 35 — D-1: consolidação de avisos por telefone (PR próprio, DESLIGADA e não conectada ao envio)

Branch isolada `proto/d1-consolidacao-por-telefone` (a partir da `main`). **Nada é ativado em produção**: o módulo é puro, nenhum código de produção o importa (teste), e cotas, política e envio atuais seguem exatamente como estão até uma futura autorização de mudança. Contexto e recomendação: doc 32 (PR #63).

## 1. Problema que resolve
Um mesmo responsável está cadastrado em **7 empresas** (o banco só admite o mesmo telefone uma vez por empresa). O D-1 envia uma mensagem por registro, o teto de 3/dia por telefone barra 4 e elas vencem sem sair (~4 avisos/dia perdidos). A consolidação junta os avisos **daquele telefone** numa mensagem, sem tocar no teto.

## 2. Invariantes pedidas e como cada uma é provada
| Invariante | Como a proposta garante | Prova |
|---|---|---|
| **Autorização independente por empresa e unidade** | cada bloco é avaliado só pelas regras do seu registro: ativo, não revogado, categoria habilitada, opt-out do contato, empresa habilitada, empresa não pausada, unidade no escopo; **qualquer campo ausente = não autoriza**; bloco recusado não derruba os demais | testes puros (regras, fail-closed, conteúdo excluído não aparece em lugar nenhum) + PG descartável 16/16: as mesmas regras sobre o esquema real, por empresa |
| **Conteúdo completo de cada relatório** | o texto entra byte a byte (sem trim, resumo ou corte); se não cabe, vira outra mensagem; um relatório que não cabe nem sozinho com título sai como a mensagem **original** inteira; acima do limite do provedor (4096) é excluído com motivo, nunca cortado | testes (espaços, quebras, emojis, CRLF; limite 700; bloco gigante) |
| **Rastreabilidade por empresa** | cada bloco tem título `*empresa — unidade*`; a saída traz, por bloco, id, empresa e unidade; a chave de idempotência vem dos ids | testes (7 blocos atribuídos; mesma empresa com 2 unidades separadas) |
| **Revogação por destinatário** | revogar um registro tira só o bloco dele; "sair de tudo" (opt-out do contato) tira todos os blocos **daquele telefone**; o banco não deixa reativar o que o titular revogou | testes + PG: revogação real de uma empresa (RPC da Central) cancela só a mensagem dela, não grava nada nas outras 6, não mexe no opt-out; reativação barrada pelo gatilho |
| **Limites de tamanho** | padrão 3500 (< 4096 do provedor); nunca excede 4096, mesmo se pedirem mais | testes (todas ≤ limite); relatórios reais têm 260 caracteres em média (máx. 357): **os 7 cabem numa mensagem** (~2,3 mil caracteres) |
| **Idempotência** | ordem determinística (empresa, unidade, id); chave = hash dos ids ordenados: mesmo conjunto = mesma chave; outro conjunto (um bloco revogado) = outra mensagem; reprocessar não duplica | testes (ordem de entrada invertida, reprocessamento, chave muda com o conjunto) |
| **Isolamento entre organizações** | só agrupa o MESMO contato de WhatsApp; um bloco só aparece na mensagem do telefone que ele autoriza; empresa pausada/desabilitada só perde o próprio bloco | testes + PG (pausa da empresa O3, desabilitar a O5, opt-out de um telefone sem afetar o outro) |
| **Cotas e envio atuais intactos** | o módulo não importa banco, provider, fila, política nem cotas; nada chama o módulo | testes de pureza e de "ninguém usa"; PG só leitura (transação `read only`; nada enviado/criado pela seleção) |

## 3. Efeito nos destinatários atuais (se um dia for ligada)
- 41 registros / 28 telefones hoje ⇒ **28 mensagens/dia** (−13). Os 4 telefones com 1–3 registros passam a receber 1 mensagem em vez de 2–3 (**formato muda também para eles**); o responsável das 7 lojas passa de "3 de 7 por dia" para **os 7 avisos numa só mensagem**.
- Quem tem 1 registro: **mensagem original, idêntica à de hoje**.

## 4. O que falta para ligar (PR próprio; decisões materiais)
1. **Onde consolidar:** no momento do envio (agrupar mensagens `SCHEDULED` do mesmo telefone já vencidas) é o desenho mais simples; consolidar no agendamento mudaria o gerador.
2. **Estado das mensagens componentes:** todas passam a `SENT` com o mesmo `provider_message_id`; entrega/leitura são acompanhadas pela mensagem do grupo.
3. **Teto por telefone:** a mensagem consolidada contaria como **uma** (muda o significado de "3 por dia"; decisão de política).
4. **Revogação em voo** e **falha parcial** (provider recusa a consolidada): voltar os componentes a individuais, sem perder nenhum.
5. **Texto:** validar o formato (título, separação) com as empresas; e se mensagens individuais continuarão para quem prefere.
6. Testes de integração com o banco de teste do projeto e dry-run no D-1 antes de qualquer envio real.

## 5. Orquestrador (autorizado a evoluir; continua desligado)
`comunicacao.consolidacao.orquestrador.js` define a ordem segura, tudo por **injeção** (nenhum import de banco/provider/fila/política/cotas) e **não é chamado** por nenhum código de produção:
1. relê o **estado de cada bloco na hora do envio** (revogação, opt-out, pausa, desabilitação, escopo posteriores valem; falha ao ler = bloco fora e devolvido ao fluxo individual);
2. consolida só o que ainda está autorizado; **um envio por mensagem**, chave `cons:<hash dos ids>` (bloco único mantém a chave e o texto originais);
3. **todos os componentes terminam juntos**: enviado ⇒ `SENT` com o mesmo provider id (falha ao finalizar um registra e **nunca reenvia**); falha **provada pré-envio** ⇒ nada finalizado e os ids **voltam** ao fluxo individual (nenhum aviso se perde); **dúvida** (timeout/5xx) ⇒ todos `DELIVERY_UNKNOWN` e **nunca reenvio**;
4. um grupo (telefone) falhar não impede os outros. Flag `COMUNICACAO_CONSOLIDACAO_POR_TELEFONE` (**desligada**; só `true` liga).
15 testes: 7 destinatários no mesmo telefone, telefones diferentes, bloco único, revogação/opt-out/pausa/escopo entre agendar e enviar, falha de leitura do estado, falha pré-envio, incerta, falha ao finalizar, divisão por tamanho, idempotência, ordem de entrada, entrada vazia e ausência de uso em produção.

## 6. Arquivos
`backend/src/modules/comunicacao/comunicacao.consolidacao.js` (puro), `comunicacao.consolidacao.orquestrador.js` + `comunicacao-consolidacao-orquestrador.test.js` (15), `backend/test/comunicacao-consolidacao.test.js` (18 testes), `backend/testes-seguros/pg/consolidacao_d1.sh` (16 verificações).
