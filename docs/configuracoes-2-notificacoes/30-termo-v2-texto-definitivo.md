# 30 — Termo de consentimento v2: texto definitivo PARA APROVAÇÃO JURÍDICA

> **Não aprovado.** Este arquivo é o texto técnico final, pronto para o jurídico preencher e aprovar. Cada campo que depende de decisão jurídica está marcado `[[JUR-n]]` e listado no quadro abaixo. **Nenhuma aprovação é presumida**: enquanto a versão não-rascunho não for publicada, o consentimento real é recusado pelo sistema (409 `TERMO_NAO_APROVADO`) e o OTP/convites seguem desligados.

## Texto (pt-BR)
**Avisos da {empresa} pelo WhatsApp — termo de consentimento (versão 2)**

**1. Quem envia.** Os avisos são enviados em nome de **{empresa}**, controladora dos dados, pela plataforma Crescer com Delivery, que atua como operadora. [[JUR-1: razão social e CNPJ do controlador e da operadora; confirmar quem é controlador e quem é operador]]

**2. O que você receberá.** Somente as categorias que você marcar nesta página, para as unidades indicadas ({unidades}). Nenhuma categoria vem marcada; escolher é opcional e você pode confirmar o número sem consentir. [[JUR-2: textos finais das categorias exibidas (rótulo e descrição) e se avisos operacionais exigem consentimento ou têm outra base legal]]

**3. Confirmação do número.** Para provar que o número é seu, enviamos um código de 6 dígitos por WhatsApp, válido por 5 minutos. Confirmar o número **não** autoriza o envio de avisos: a autorização é este termo. [[JUR-3: ciência do tratamento do número já na verificação]]

**4. Dados tratados.** Seu telefone (guardado cifrado), as categorias e unidades escolhidas, a data e a hora do aceite e a versão deste termo. Base legal: consentimento (LGPD, art. 7º, I). Os dados ficam guardados por [[JUR-4: prazo de retenção]] e [[JUR-5: eventuais compartilhamentos e transferência internacional — ex.: provedor de infraestrutura e a própria plataforma WhatsApp]].

**5. Como sair, a qualquer momento.** Responda **SAIR**, **PARAR**, **STOP** ou **DESCADASTRAR** a qualquer mensagem que receber, ou use a página de gestão com o seu número. A saída vale **imediatamente**, vale para os avisos de **todas** as empresas que cadastraram este número, fica registrada e você recebe uma mensagem confirmando. [[JUR-6: confirmar as palavras de saída, o prazo máximo para cessar os envios e o texto da mensagem de confirmação]]

**6. Seus direitos.** Você pode pedir acesso, correção ou eliminação dos seus dados, e revogar o consentimento. Fale com o encarregado: [[JUR-7: nome e canal do encarregado (DPO)]].

**7. Se você não aceitar.** Nenhum aviso novo é enviado. A recusa fica registrada (data, hora e versão do termo). [[JUR-8: texto ao titular que recusa]]

## Quadro de pendências jurídicas
| ID | O que decidir | Cláusula | Efeito se mudar |
|---|---|---|---|
| JUR-1 | Controlador/operador, razão social, CNPJ | 1 | texto fixo do termo |
| JUR-2 | Rótulos/descrições das categorias; base legal dos avisos operacionais | 2 | texto; pode dispensar consentimento para algumas categorias |
| JUR-3 | Ciência do tratamento na verificação do número | 3 | texto |
| JUR-4 | Prazo de retenção | 4 | texto **e** rotina de expurgo (a definir) |
| JUR-5 | Compartilhamento e transferência internacional | 4 | texto |
| JUR-6 | Palavras de saída, prazo para cessar, texto da confirmação | 5 | variável `NOTIFICACOES_PALAVRA_CHAVE_SAIR` e texto da confirmação (código) |
| JUR-7 | Encarregado (DPO) | 6 | texto |
| JUR-8 | Texto de recusa | 7 | texto |
| JUR-9 | Base legal dos **envios que já existem** (D-1 dos 41 destinatários legados): o sistema **não** lhes concede categorias novas nem exige OTP retroativo | — | decisão de regularização futura; **não** altera este termo |

## O que já é decisão técnica fixa (não depende do jurídico)
- **Posse ≠ consentimento:** verificar o número nunca consente; categorias nunca vêm marcadas; consentimento é por categoria e por empresa.
- **Histórico e prova do aceite:** `comunicacao_termos` é imutável (versão inteira, `hash = sha256(texto)` verificado por CHECK); cada aceite grava `termo_versao`, `termo_hash`, categoria, unidade, data e origem no livro-razão (só acréscimo). Revogar é **novo registro**; nada é apagado.
- **Isolamento entre empresas:** o consentimento e a revogação são por empresa; a saída por SAIR atinge só os registros **deste número**.
- **LEGACY_ACTIVE preservado:** nenhuma categoria nova é concedida automaticamente; M3 desligada.

## Publicação (somente depois da aprovação; ato de dados com autorização própria)
Substituir `{TEXTO_FINAL_APROVADO}` pelo texto aprovado (as variáveis `{empresa}` e `{unidades}` permanecem):

    insert into comunicacao_termos (versao, texto, hash, rascunho)
    values (2, '{TEXTO_FINAL_APROVADO}', encode(sha256(convert_to('{TEXTO_FINAL_APROVADO}', 'UTF8')), 'hex'), false);

Conferir: `select versao, rascunho, left(hash,12) from comunicacao_termos order by versao;`. Uma vez inserido, **o texto não pode ser alterado** (gatilho de imutabilidade): correções viram a versão 3.
