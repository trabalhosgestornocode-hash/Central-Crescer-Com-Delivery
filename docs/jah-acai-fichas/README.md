# Fichas técnicas do Jah Açaí Centro — o que mudou no código

O repositório é público: aqui não há receitas, custos, preços, nomes de produto nem ids de empresa. O relatório
completo da auditoria (com os dados do cliente) fica fora do repositório, em pasta privada.

## Contexto
A planilha do Jah usa o mesmo modelo "Ficha Técnica 3.2" da Caramelle (abas P1–P300, B1–B80, Ingredientes,
Embalagem, MOD), então o parser e o planejador existentes servem sem mudança de layout. A empresa usa o MESMO módulo
Produtos/CMV, Insumos e o MESMO detalhe de produto das Subways e da Caramelle — não existe aba "Fichas Técnicas".

Números da auditoria (planilha original): 42 fichas preenchidas (41 nomes distintos), 2 preparações, 50 ingredientes,
11 embalagens, nenhuma mão de obra, desperdício sempre 0%. Simulação da carga: 44 registros → 36 completos e 8
incompletos; as 36 comparáveis reproduzem o custo da planilha sem divergência.

## Mudanças
1. **Importador — arquivo único** (`backend/scripts/catalogo-importar-planilhas.mjs`):
   `--planilha <xlsx> --categoria <RÓTULO> --fonte <id>`. `--fonte` é obrigatória nesse modo (a carga nunca herda a fonte
   padrão da Caramelle). Simulação por padrão; escrita continua exigindo `--aplicar --confirmo-escrita --org` +
   `CATALOGO_IMPORT_CONFIRMA_HOST`.
2. **Planejador** (`catalogo.planejar.js`) — novos avisos (não bloqueiam): `rendimento_sem_unidade` (ficha final que rende
   ≠ 1 sem dizer a unidade), `preco_venda_planilha_ausente`, `mesma_receita_de_preparacao`. Nome que só difere por
   pontuação de um cadastro (ex.: colchete digitado a mais) ganha **sugestão** no texto da pendência — nunca é aplicada.
3. **Homologação — pendências da planilha passam a bloquear** (`produtos/pendenciasCarga.js`, `produtos.service.js`).
   Quando a carga descarta uma linha (sem quantidade, nome sem correspondência, erro de fórmula), a ficha restante tem
   custo em todos os itens e o status dinâmico dizia "completa": o custo SUBESTIMADO podia ser homologado, inclusive pelo
   botão em lote. Agora essas pendências (próprias ou de uma preparação usada, em qualquer nível) deixam a ficha
   incompleta na lista e no detalhe (custo "indisponível", selo "Pendência da planilha", formação marcada como parcial)
   e a homologação individual/em lote responde 409. Para liberar, um administrador corrige a ficha e usa
   **"Marcar pendências da planilha como conferidas"** (`POST /produtos/:id/pendencias-carga/conferir`,
   `configuracoes.gerenciar`) — grava quem/quando na origem e no histórico; não homologa sozinho.
   Vale também para a Caramelle (nenhuma ficha dela estava homologada; efeito só preventivo).
4. **Interface**: categorias de carga fora de Doces/Salgados/Bebidas aparecem no filtro e no detalhe (ex.: "Açaí").
5. **Ops** (`database/ops/remover_catalogo_modelo_indevido_{PREVIEW,APLICAR,REVERTER}.sql`): remove o catálogo-modelo
   das Subways copiado por engano para uma empresa que não é Subway, com travas (venda, PDV, histórico, estoque, compras,
   tabela oficial), conferência das contagens do PREVIEW, cópia integral em `backup_ops` e reversão exata. Placeholders
   `<ORG_ID>`/`<ESPERADO_*>`/`<LOTE>`; só com autorização.

Sem migration. Nada foi alterado em produção.

## Testes
- `node --test backend/test/catalogo-importacao-arquivo-unico.test.js` (fixture sintética com as situações da auditoria + CLI)
- `node --test backend/test/pendencias-carga.test.js` e os novos casos em `catalogo-isolamento-homologacao.test.js` /
  `catalogo-rotas-permissoes.test.js` (rodar com as variáveis fictícias de Supabase e `--experimental-vm-modules`)
- `node --test frontend/test/fichasModelo.test.js` e `frontend/test/fichasCaramelle.browser.test.js` (Playwright)
- Postgres descartável (`CAT_PG_DESCARTAVEL=1`): `backend/testes-seguros/catalogo-pg/run.sh`,
  `carga_real.sh <payload.json> <relatorio.json>` (carga real simulada 2× numa empresa fictícia; os JSON ficam fora do
  repositório) e `modelo_indevido.sh` (scripts de ops).

## Dashboard iFood
O vínculo produto ↔ item do iFood continua sendo o código do PDV (ou nome idêntico e único) no detalhe do produto.
O painel "CMV teórico" do Dashboard iFood foi removido em 11/11 (PR #106) e **não** foi recriado aqui.
