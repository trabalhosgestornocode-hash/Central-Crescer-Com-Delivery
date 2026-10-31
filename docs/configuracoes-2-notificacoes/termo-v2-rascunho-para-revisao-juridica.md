# Termo de consentimento v2 — RASCUNHO PARA REVISÃO JURÍDICA (não aprovado)

> Este texto **não** vale como consentimento enquanto não for aprovado e publicado. O sistema recusa consentimento real com termo em rascunho ou ausente (409 `TERMO_NAO_APROVADO`).

## Texto proposto (pt-BR)
**Notificações da Crescer com Delivery por WhatsApp — termo v2**
1. **Quem envia.** A Crescer com Delivery ([razão social e CNPJ — preencher]) envia mensagens, por WhatsApp, ao número que você confirmou com um código.
2. **O que enviamos.** Apenas as categorias que você marcar (por exemplo, avisos operacionais da sua unidade e alertas do dashboard). Nenhuma categoria vem marcada; escolher é opcional.
3. **Confirmação do número.** Enviamos um código de 6 dígitos, válido por 5 minutos, a partir do WhatsApp da Crescer com Delivery. Confirmar o número **não** autoriza mensagens: a autorização é este termo.
4. **Dados tratados.** Telefone (guardado cifrado), categorias escolhidas, unidade, data/hora e a versão deste termo. Base legal: consentimento (LGPD, art. 7º, I). [Prazo de retenção e eventuais compartilhamentos — definir com o jurídico.]
5. **Como sair.** Responda **SAIR** a qualquer mensagem ou desative em Configurações → Notificações. A revogação vale imediatamente e fica registrada.
6. **Contato do encarregado (DPO).** [preencher].

## Matriz de cláusulas — o que exige aprovação do jurídico
| # | Cláusula | O que já é decisão técnica (fixa no sistema) | **Exige aprovação / preenchimento do jurídico** |
|---|---|---|---|
| 1 | Quem envia | A empresa (campo `{empresa}`) vem do cadastro | **Razão social e CNPJ** do controlador; se a Crescer com Delivery ou a empresa do cliente é a controladora |
| 2 | O que enviamos | Categorias vêm do cadastro e **nenhuma vem marcada**; escolher é opcional; consentimento é **por categoria** e **por empresa** | Texto das categorias exibidas ao titular; se avisos operacionais exigem consentimento ou outra base legal |
| 3 | Confirmação do número | Código de 6 dígitos, validade 5 min, uso único, 5 tentativas; **verificar ≠ consentir** | Redação de que o código vem do WhatsApp da empresa; ciência de que há tratamento do número já na verificação |
| 4 | Dados e base legal | Telefone cifrado; guardamos categorias, unidade, data/hora e **versão + hash do termo** | **Base legal** (art. 7º, I); **prazo de retenção**; eventual compartilhamento (operadora/WhatsApp); transferência internacional |
| 5 | Como sair | Revogação **imediata**, registrada como novo evento; palavra **SAIR** (`NOTIFICACOES_PALAVRA_CHAVE_SAIR`, hoje desligada) | Se a palavra SAIR é adequada; prazo máximo para cessar envios; texto de confirmação da saída |
| 6 | DPO | — | **Nome e canal do encarregado** |
| 7 | Destinatários que já recebem o D-1 | **Nada muda**: sem categorias novas, sem OTP retroativo, sem consentimento automático | Base legal desses envios já existentes e se exigem regularização futura |
| 8 | Recusa | Recusar não cria nada e fica registrado | Texto ao titular que recusa |

## Pendências do jurídico
Razão social/CNPJ; retenção e compartilhamento; base legal para destinatários que já recebem o D-1 (o sistema **não** lhes concede categorias novas nem exige OTP retroativo); DPO; texto de recusa; confirmar se a palavra de saída (SAIR) é adequada.

## Preservação do histórico e prova do aceite (já implementado, migration 134)
`comunicacao_termos`: versão inteira, `hash = sha256(texto)` verificado por CHECK, `rascunho` booleano, **imutável** (gatilho bloqueia update/delete). Cada consentimento no livro-razão guarda `termo_versao`, `termo_hash`, categoria, data e origem; a revogação é um **novo** registro (histórico preservado). A versão 1 permanece como rascunho de simulação.

## Publicação (somente após aprovação; é um ato de dados com revisão — nenhuma migration insere o texto)
Modelo, **não executar sem aprovação** (substituir `{TEXTO_FINAL_APROVADO}`):

    insert into comunicacao_termos (versao, texto, hash, rascunho)
    values (2, '{TEXTO_FINAL_APROVADO}', encode(sha256(convert_to('{TEXTO_FINAL_APROVADO}', 'UTF8')), 'hex'), false);

Conferir depois: `select versao, rascunho, left(hash,12) from comunicacao_termos order by versao;`. A página do titular passa a exibir o termo v2 e o consentimento real fica possível.
