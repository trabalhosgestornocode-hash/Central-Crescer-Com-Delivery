# Fichas técnicas do Jah Açaí Centro — o que mudou no código

O repositório é público: aqui não há receitas, custos, preços, nomes de produto nem ids de empresa. O relatório
completo da auditoria (com os dados do cliente) fica fora do repositório, em pasta privada.

## Contexto
A planilha do Jah usa o mesmo modelo "Ficha Técnica 3.2" da Caramelle (abas P1–P300, B1–B80, Ingredientes,
Embalagem, MOD), então o parser e o planejador existentes servem sem mudança de layout. A empresa usa o MESMO módulo
Produtos/CMV, Insumos e o MESMO detalhe de produto das Subways e da Caramelle — não existe aba "Fichas Técnicas".

Números da auditoria (planilha original): 42 fichas preenchidas (41 nomes distintos), 2 preparações, 50 ingredientes,
11 embalagens, nenhuma mão de obra, desperdício sempre 0%.

Como as contagens se relacionam (44 registros = 42 fichas + 2 preparações):

| | Completos | Incompletos | Total |
|---|---|---|---|
| Fichas (abas P) | 35 | 7 | 42 |
| Preparações (abas B) | 1 | 1 | 2 |
| **Registros** | **36** | **8** | **44** |

Causas das 8 incompletas: 4 fichas com embalagem listada sem quantidade (linhas descartadas); 1 preparação com nome de
ingrediente digitado errado; 1 ficha com ingrediente que não existe no cadastro; 2 fichas com insumo de custo zero (uma
delas também usa a preparação incompleta). Os 36 completos reproduzem o custo da planilha sem divergência.

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
   A carga também **não pode** trazer ficha homologada: `validarPayload` recusa `homologacao` diferente de `pendente`.
   **Efeito na Caramelle** (medido em produção, só leitura): ~35 das 282 fichas, hoje homologáveis, têm pendência da
   planilha aberta (própria ou de preparação) e passam a pedir a conferência antes de homologar. Nenhuma está homologada.
4. **Interface**: categorias de carga fora de Doces/Salgados/Bebidas aparecem no filtro e no detalhe (ex.: "Açaí").
5. **Ops** (`database/ops/remover_catalogo_modelo_indevido_{PREVIEW,APLICAR,REVERTER,RESTAURAR_ARQUIVO}.sql`): remove o catálogo-modelo
   das Subways copiado por engano para uma empresa que não é Subway. O APLICAR só prossegue se TUDO bater com o PREVIEW:
   identidade da empresa (id, nome e modelo de origem), contagens por tabela e **impressão digital** (MD5 dos ids) de
   cada tabela; 15 travas de uso real (vendas, PDV, combos, histórico, mão de obra, estoque, lotes, compras,
   divergências, Martin Brower, tabela oficial…). Tudo em uma transação com a linha da empresa travada; cópia integral
   em `backup_ops`; também zera `organizacoes.modelo_origem_id` (senão a aba "Modelo Inicial" poderia reclonar o
   catálogo assim que a empresa ficasse vazia). REVERTER devolve linhas e `modelo_origem_id`. Placeholders
   `<ORG_ID>`/`<ESPERADO_*>`/`<LOTE>`/`<PASTA>`; só com autorização. `RESTAURAR_ARQUIVO` é a contingência que restaura a
   partir do backup exportado em sessão somente-leitura (um `to_jsonb` por linha, com MD5 conferido no banco) — usa
   `\encoding UTF8` porque o psql do Windows pode assumir WIN1252.
   Rodar no SQL Editor (UTF-8) ou com `PGCLIENTENCODING=UTF8`: com codificação errada o nome da empresa não confere e o
   APLICAR recusa (falha segura, testada). Causa e proposta de correção: `proposta-modelo-inicial.md`.

Sem migration. Nada foi alterado em produção.

## Testes
- `node --test backend/test/catalogo-importacao-arquivo-unico.test.js` (fixture sintética com as situações da auditoria + CLI)
- `node --test backend/test/pendencias-carga.test.js` e os novos casos em `catalogo-isolamento-homologacao.test.js` /
  `catalogo-rotas-permissoes.test.js` (rodar com as variáveis fictícias de Supabase e `--experimental-vm-modules`)
- `node --test frontend/test/fichasModelo.test.js` e `frontend/test/fichasCaramelle.browser.test.js` (Playwright)
- Postgres descartável (`CAT_PG_DESCARTAVEL=1`): `backend/testes-seguros/catalogo-pg/run.sh`,
  `carga_real.sh <payload.json> <relatorio.json>` (carga real simulada 2× numa empresa fictícia; os JSON ficam fora do
  repositório), `modelo_indevido.sh` (scripts de ops) e `restauracao_backup.sh <pasta_backup> <org> [payload]` (ensaio
  completo de remoção, reversão e restauração pelo arquivo com o backup real).
- `backend/test/catalogo-homologacao-carga-real.test.js` com dados reais exportados só-leitura (fora do repositório; sem
  eles os casos são pulados): `CATALOGO_PAYLOAD`/`CATALOGO_RELATORIO` (carga do Jah: lote com todos os ids homologa só as
  completas; todo produto abre sem preço e sem condições comerciais) e `CATALOGO_TABELAS_DIR`/`CATALOGO_TABELAS_ORG`
  (tabelas de uma empresa, ex.: Caramelle: oráculo independente — nenhuma ficha com pendência da planilha é homologada,
  individual ou em lote).

## Dashboard iFood
O vínculo produto ↔ item do iFood continua sendo o código do PDV (ou nome idêntico e único) no detalhe do produto.
O painel "CMV teórico" do Dashboard iFood foi removido em 11/11 (PR #106) e **não** foi recriado aqui.
