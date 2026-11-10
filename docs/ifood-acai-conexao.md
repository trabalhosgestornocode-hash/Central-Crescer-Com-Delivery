# Açaí no Grau — iFood, SAIPOS e Anota Aí: o que existe, o que falta e quem precisa agir

**Data:** 10/11/2026 · Levantamento por leitura do código e do banco de produção (somente SELECT). Nada foi conectado, autorizado, coletado ou alterado.

## 1. Situação da unidade (produção)

| Item | Situação |
|---|---|
| Organização própria (separada da Subway) | Sim |
| Módulos habilitados na unidade e na organização | `ifood`, `ifood_dashboard`, `parser_food_delivery`, `checklist_operacional`, `gestao_financeira` |
| Conexão iFood (`ifood_conexoes`) | **Nenhuma** |
| Loja iFood vinculada (`ifood_merchant_vinculos`, `ifood_conexao_lojas`) | **Nenhuma** |
| Pedidos e eventos iFood recebidos | **0** |
| Pedidos Foody | Sim, pela conexão compartilhada aprovada da Subway Saci (destino ATIVO `acai_no_grau`) |

A loja iFood do Açaí **não é** uma loja da conexão iFood da Subway Saci. A conexão iFood da Subway cobre só as lojas da própria Subway. Não existe autorização para ler o Açaí com o token da Subway, e isso **não deve ser feito**.

## 2. Fluxo oficial já implementado no Crescer (OAuth distribuído do iFood)

1. Um **Administrador da organização Açaí no Grau Saci** (ou o gestor da unidade, com a permissão `integracoes.gerenciar`) entra na Central **no contexto da unidade Açaí no Grau Saci**: Integrações → iFood → card **Pedidos** → **Conectar pedidos iFood** (`POST /integracoes/ifood/oauth/start`, `appType = order`).
2. A Central mostra o código do assistente oficial do iFood. O responsável abre o **Portal do Parceiro iFood logado na loja do Açaí** e autoriza o aplicativo com o código.
3. Ao concluir (`POST /oauth/complete`), a Central identifica a loja **pelo próprio token**: a claim `merchant_scope` precisa trazer `order` **e** `events`. Só entra loja livre, que não esteja em outra conexão viva. A Central verifica a loja no iFood sem gravar nem confirmar eventos e só então ativa.
4. Estados na tela: *Aguardando autorização* → *Validando loja* → *Conectado — aguardando o primeiro pedido* → *Conectado — recebendo pedidos* (este último só depois do primeiro pedido comprovado).

A associação **organização → unidade → loja** é feita pelo fluxo acima: o tenant vem sempre da sessão (`req.tenant`), e a loja vem do token. Não há cadastro manual de ID que precise ser preparado. Preencher o vínculo por SQL ou com outro token seria contornar a autorização da loja, e **não deve ser feito**.

## 3. O que precisa de intervenção humana (nesta ordem)

| # | Quem | Ação |
|---|---|---|
| 1 | Responsável pela configuração do Render | Conferir se a unidade pode usar o autoatendimento: `IFOOD_ORDER_SELF_SERVICE_ENABLED=true` e, se `IFOOD_ORDER_SELF_SERVICE_UNITS` estiver preenchida, incluir o uuid da unidade Açaí. A alternativa é incluir a unidade em `IFOOD_ORDER_PILOT_UNITS`. Mudar variável no Render é ação de produção e precisa de autorização |
| 2 | Administrador da organização Açaí | Executar o fluxo da seção 2 dentro da Central |
| 3 | Dono da loja Açaí no iFood | Autorizar o aplicativo no Portal do Parceiro, logado **na loja do Açaí** |
| 4 | Administrador | Conferir na tela o estado *Conectado — recebendo pedidos* depois do primeiro pedido |

## 4. Para onde os dados iFood do Açaí podem ir, depois de autorizados

| Módulo | Recebe? | Observação |
|---|---|---|
| Pedidos/Events (`ifood_pedidos`, `ifood_eventos`) → Checklist operacional, Dashboard iFood | **Sim**, com a autorização Order/Events da loja | O poller passa a incluir a unidade no ciclo seguinte |
| Financial (vendas, repasses, conciliação) | **Ainda não** | O app Financial está em homologação com o iFood (ticket aberto em 07/10, aguardando). Sem ele, os valores financeiros do iFood seguem pela importação de arquivo |
| Gestão Financeira / DRE do Açaí | Não automaticamente | A DRE homologada não muda. O canal iFood da DRE continua vindo dos relatórios importados. Ligar dado automático na DRE exige aprovação de metodologia |

## 5. SAIPOS e Anota Aí

| Fonte | O que existe no projeto | Integração automática? |
|---|---|---|
| **SAIPOS** | Importação de arquivo: relatório **diário** de vendas (CSV/XLSX: venda bruta, espécie, sangria) e o relatório de vendas **por canal** (Financeiro 2.0) | **Não.** Não há cliente de API, credencial, endpoint nem documentação oficial de API no repositório |
| **Anota Aí** | Aparece só como **canal** dentro da exportação da SAIPOS (origem `integration-api-int-sale` → "Anota Aí") | **Não.** Não há conector próprio nem credencial. Os pedidos do Anota Aí que passam pela Foody chegam como pedidos Foody, mas a Foody não informa o canal (ver a lacuna "origem" na matriz Foody) |

Importar arquivo **não é** integração automática. Para automatizar alguma das duas fontes, é preciso:
1. a documentação oficial da API do fornecedor e a confirmação de que o plano contratado do Açaí dá acesso a ela;
2. uma credencial emitida pelo fornecedor para a loja do Açaí, cadastrada pelo dono da conta;
3. a mesma validação com dado real feita com a Foody (paridade campo a campo com o relatório exportado) antes de qualquer consumidor usar o dado.

Até lá, o caminho legítimo é continuar com a importação dos relatórios na Central (Gestão Financeira → Vendas diárias / Vendas por canal), sem mexer nos lançamentos homologados.
