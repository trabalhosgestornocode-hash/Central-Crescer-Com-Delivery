# 38 — Pendências jurídicas objetivas (JUR-1, 2, 4, 5, 6 e 7) para revisão

Documento curto para o jurídico/encarregado. Texto integral do termo: doc 30 e `termo-v2-rascunho-para-revisao-juridica.md`; as nove decisões completas: doc 33. **Nada aqui está aprovado.** O sistema recusa consentimento real (409 `TERMO_NAO_APROVADO`) enquanto a versão vigente for rascunho. JUR-3, 8 e 9 ficam no doc 33 (texto ou fora do termo).

| Item | Decisão pedida ao jurídico | Sugestão técnica (ponto de partida, não é parecer) | Bloqueia publicar o termo? | O que o sistema já faz |
|---|---|---|---|---|
| **JUR-1** Controlador × operador | Quem é controlador de cada telefone/aviso; razão social e CNPJ a constar | Cada empresa-cliente controladora; Crescer com Delivery operadora, com contrato de operação | **Sim** | Isola dados por empresa; cada registro tem autorização própria |
| **JUR-2** Categorias e base legal | Rótulo/descrição de cada categoria exibida e a base legal (consentimento ou outra, para aviso operacional) | Consentimento para todas as categorias do canal novo; se alguma tiver outra base, sai do fluxo de consentimento | **Sim** | Consentimento por categoria, revogável por categoria |
| **JUR-4** Retenção | Prazo de guarda do telefone (cifrado), do aceite e das revogações; se há expurgo | Livro-razão é só acréscimo (prova do aceite); definir prazo pós-revogação e se o telefone é expurgado (exigiria rotina nova) | **Sim** | Nada é apagado hoje; revogação grava novo registro |
| **JUR-5** Compartilhamento e transferência internacional | Categorias de operadores e hipótese de transferência (LGPD art. 33) para banco em `us-west-2`, hospedagem e plataforma WhatsApp | Declarar as categorias de operadores e a hipótese legal | **Sim** | — |
| **JUR-6** Palavras de saída | Palavras que valem, prazo máximo para cessar, texto da confirmação | SAIR, PARAR, STOP, DESCADASTRAR; efeito imediato; confirmação curta | Não bloqueia o termo; **bloqueia ligar o SAIR** | Implementado e **desligado**; só mensagem ≤ 48 h, idempotente |
| **JUR-7** Encarregado (DPO) | Nome e canal de contato a constar | — | **Sim** | — |

**Para publicar a versão 2:** responder JUR-1, 2, 4, 5 e 7 e fechar os textos dos itens 3, 6 e 8; depois autorizar a inserção (`rascunho = false`, imutável; correção vira versão 3). **Para ligar o SAIR:** responder JUR-6 (e termo publicado).

**Formato de resposta sugerido:** por item, "aprovado como está" / "alterar para: …" / "outra base legal: …".
