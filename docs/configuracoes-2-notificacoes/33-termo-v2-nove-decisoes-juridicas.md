# 33 — Termo v2: as nove decisões que dependem do jurídico (1 página)

Texto completo e marcado `[[JUR-n]]` no doc 30 (PR #62). **Nada abaixo está aprovado.** A coluna "sugestão" é só ponto de partida técnico para o jurídico avaliar; **o sistema recusa consentimento real (409) enquanto não houver versão não-rascunho publicada.**

| # | Decisão | Sugestão técnica de partida | Bloqueia publicar o termo? |
|---|---|---|---|
| **JUR-1** | Controlador × operador; razão social e CNPJ | cada empresa-cliente controladora; Crescer com Delivery operadora (contrato de operação) | **sim** |
| **JUR-2** | Categorias exibidas (rótulo/descrição) e **base legal** de cada uma (consentimento × outra base para aviso operacional) | consentimento para todas as categorias do canal novo; se o jurídico entender que algum aviso operacional tem outra base, a categoria sai do consentimento | **sim** |
| **JUR-3** | Ciência de que o número já é tratado na verificação (envio do código) | frase curta na cláusula 3 | não (texto) |
| **JUR-4** | **Prazo de retenção** do telefone (cifrado), do aceite e das revogações | o livro-razão é **só acréscimo** (prova do aceite); definir o prazo de guarda após a revogação e se o telefone cifrado é expurgado depois (exigiria rotina nova) | **sim** |
| **JUR-5** | Compartilhamento e **transferência internacional** (infraestrutura de banco no exterior — região `us-west-2` —, hospedagem e a plataforma WhatsApp) | declarar categorias de operadores e a hipótese de transferência (LGPD art. 33) | **sim** |
| **JUR-6** | Palavras de saída, prazo máximo para cessar, texto da mensagem de confirmação | SAIR, PARAR, STOP, DESCADASTRAR; efeito imediato; confirmação curta (já implementada, desligada) | não (liga `NOTIFICACOES_PALAVRA_CHAVE_SAIR`/`_SAIR_CONFIRMACAO`) |
| **JUR-7** | Encarregado (DPO): nome e canal | — | **sim** |
| **JUR-8** | Texto ao titular que **recusa** | "Nenhum aviso novo será enviado. A recusa fica registrada." | não (texto) |
| **JUR-9** | **Base legal dos envios que já existem** (D-1 dos 41 destinatários legados) e se exigem regularização | o sistema **não** lhes concede categorias novas nem pede OTP retroativo; decisão separada, não altera o termo | não |

**Para publicar:** resolver JUR-1, 2, 4, 5 e 7 (bloqueiam) e fechar os textos 3, 6 e 8; depois, autorizar a inserção da versão 2 (`rascunho = false`; **imutável** depois de inserida — correção vira versão 3). **Nunca** se registra consentimento real com o termo em rascunho.
