# Financeiro v2 — 10. Interface: Visão Geral, DRE Gerencial e Composição (Execução 05)

Data: 12/11/2026. Branch local `feat/financeiro-v2-interface`, derivada de `4933149`.

> Público: só dados sintéticos. Nada foi publicado, e nenhuma rota do aplicativo foi alterada.

## 1. Diagnóstico (Fase A)

- **Frontend do projeto:** JavaScript puro em `frontend/src`, testes com `node --test` e DOM e fetch falsos.
- **Identidade visual:** vermelho da marca `#F42433`, Inter, números em Archivo Black, cards brancos sobre `#f1f2f4`, tema escuro.
- **Autenticação atual:** `req.user`, `req.tenant` e `req.acesso`, montados pelo middleware. O adaptador de sessão do Financeiro v2 consome esse formato (doc 06).
- **As telas financeiras antigas não foram usadas como fonte nem alteradas.**
- **Bloqueio para a integração real:** montar rotas do Financeiro v2 no backend exigiria:
  1. tirar o módulo do isolamento, que o teste estático hoje proíbe por segurança;
  2. provisionar concessões no banco real;
  3. publicar rotas.

  Nada disso é permitido nesta execução. Por isso a interface roda num **ambiente demonstrativo local isolado**.

## 2. Estrutura

| Arquivo | Papel |
|---|---|
| `frontend/financeiro-v2/index.html` | Página isolada com navegação das 7 áreas (5 marcadas "em construção", sem função fictícia), filtros (competência, unidade, sessão de demonstração), conteúdo e painel de composição |
| `frontend/financeiro-v2/telas.js` | Telas como **funções puras** (dados do motor → HTML escapado): Visão Geral, DRE, barra de R$ 100, árvore, composição e estados |
| `frontend/financeiro-v2/app.js` | Rotas por hash (`#/visao-geral`, `#/dre`), filtros, expansões, painel e carregamento sem flash |
| `frontend/financeiro-v2/consulta.js` | Consultas com isolamento: só a última resposta é aplicada; as anteriores são abortadas ou descartadas |
| `frontend/financeiro-v2/formatar.js` | Moeda pt-BR **só com texto** (sem ponto flutuante), percentuais, datas, rótulos de situação e de canal |
| `frontend/financeiro-v2/fv2.css` | Layout responsivo, claro e escuro, foco visível, `prefers-reduced-motion` |
| `backend/scripts/fv2/demoInterface.mjs` | Cenário sintético + tratador das consultas (sessão → adaptador → motor → resposta sanitizada) |
| `backend/scripts/fv2-demo-interface.mjs` | Servidor local, só em 127.0.0.1:5179 |

As telas antigas e as rotas existentes não foram tocadas.

## 3. Contratos de consulta (somente leitura)

São três consultas, todas por **GET**. Cada uma exige uma sessão válida, deriva a organização da sessão, valida a unidade pelas concessões `financeiro_v2.ver` e chama **apenas** as consultas aprovadas do motor:

| Consulta | Usa no motor |
|---|---|
| `/api/fv2/visao-geral?competencia&unidade` | `apurarVisaoGeral` |
| `/api/fv2/dre?competencia&unidade` | `apurarCompetencia` |
| `/api/fv2/composicao?competencia&unidade&codigo` | `composicaoDoIndicador` (código de uma lista fechada) |

**Erros:**

| Status | Situação |
|---|---|
| 401 | sessão ausente ou inválida |
| 403 | sem concessão, unidade ou organização fora do escopo |
| 400 | entrada inválida |
| 500 | falha genérica, sem detalhes internos |

**Sanitização das respostas:**
- identificadores internos (UUID) viram referências opacas, com sal aleatório por execução;
- documentos aparecem como "registrado, não acessível nesta versão": **sem link e sem caminho de arquivo**.

**Segurança do servidor local:**
- sem cache (`no-store`), com `nosniff` e `no-referrer`;
- CSP restritiva, que bloqueia script e estilo inline. Os pesos da barra são aplicados pelo DOM;
- só caminhos dentro de `frontend/financeiro-v2`;
- não recebe credenciais nem caminhos do cliente.

## 4. Visão Geral (ordem obrigatória)

1. **Faturamento Bruto Próprio:** o maior card, com borda da marca. Mostra:
   - valor e selo de confiabilidade, com explicação (ícone "i");
   - canais Balcão, iFood e Anota AI, outros canais quando existirem, e **"Sem canal identificado"** (borda tracejada e aviso de que nunca vai para Balcão);
   - percentual sobre o bruto, pendências e "Ver composição completa".
2. **Faturamento Líquido Gerencial:**
   - total e tabela por canal (bruto, deduções, despesas atribuídas por classificação, líquido);
   - aviso: "não é o valor depositado";
   - linha de **reconciliação com a DRE**: canais + não atribuídos = resultado, com "✓ reconciliado" ou "decomposição incompleta: a DRE prevalece".
3. **Secundários:**
   - Resultado Gerencial (sem ajuste de estoque), custos e despesas operacionais, vindos do motor;
   - Saldo bancário, Caixa físico, Contas a pagar e a receber, Fluxo de caixa: **"Indisponível nesta versão"**, porque o contrato ainda não existe e nada é estimado;
   - Alertas de conferência: as pendências dos indicadores.

## 5. DRE Gerencial

- **Cabeçalho:** competência, unidade e se a competência está homologada.
- **Resumo:** bruto, receita líquida comercial e resultado gerencial, com selos.
- **Barra "Para onde vai cada R$ 100":**
  - mostra componentes, não subtotais;
  - percentuais do backend, por maior resto;
  - cada grupo mostra também a **diferença de arredondamento**;
  - prejuízo aparece como parte negativa, com aviso, e componentes acima de 100% são sinalizados;
  - sem faturamento calculável, mostra um estado informativo.
- **Demonstrativo vertical** com as 9 linhas: valor, % do bruto, selo e pendências da linha.
- **Expansões:** cada linha com filhos abre a árvore categoria → subcategoria → lançamento.
  - **Nenhuma expansão vazia** (testado).
  - Os folhas mostram data, canal, classificação provisória, composição da venda, documentos e, para motoboys, valor reconhecido, pago, saldo, vencimento, pedidos, taxas rejeitadas e canceladas.
  - Receita agregada explica que não há detalhe por pedido.
- **Rodapé:** "Sem ajuste de estoque — não é lucro contábil auditado", metodologia e impressão da apuração.
- **O frontend não soma nem ajusta nada:** subtotais e percentuais vêm prontos do backend (teste estático).

## 6. Composição completa

- **Formato:** painel lateral (`role="dialog"`, `aria-modal`), na Visão Geral e na DRE.
- **Conteúdo:** nome, valor e selo, fórmula, competência, unidade, metodologia, data, pendências e a árvore expansível.
- **Teclado:** abre com o foco no botão de fechar; **Esc** fecha e devolve o foco ao botão que o abriu, preservando o contexto.
- **Documentos:** apresentados sem link falso.

## 7. Estados

| Estado | Apresentação |
|---|---|
| Confirmado / Aguardando conferência / Preliminar / Parcial / Pendente de classificação / Sem evidência suficiente | Selo com cor e explicação |
| Valor desconhecido | Texto "Valor desconhecido" em itálico, **nunca R$ 0,00** |
| Zero confirmado | R$ 0,00 + "zero confirmado" (só com situação Confirmado) |
| Carregando | `role="status"`, `aria-busy` e esqueleto. A tela anterior é limpa **antes** da consulta (sem flash) |
| Erro / acesso negado / sessão ausente | `role="alert"`, com mensagem compreensível |
| Competência não homologada | Indicado no cabeçalho da DRE e pelos selos |

## 8. Correções de consistência no motor (Fase F)

- **8.1 Reconciliação com a DRE.** O líquido "sem canal" absorvia despesas gerais sem canal (por exemplo, insumos). Corrigido:
  - **NAO_IDENTIFICADO** recebe só a receita agregada e as deduções ligadas a ela;
  - custos, despesas gerais, resultado financeiro, demais efeitos e deduções avulsas viram **não atribuídos**, agrupados por linha da DRE;
  - `reconciliacaoComDre` mostra canais + não atribuídos = resultado da DRE, e a DRE é a referência;
  - testado com venda sem canal, custos sem canal, dedução avulsa, despesa financeira, ajuste gerencial, componente com canal e patrimonial.
- **8.2 Cada R$ 100.** Os grupos são componentes, sem subtotais. Cada grupo traz o exato (em milionésimos de ponto), o exibido (centésimos, por maior resto, soma 100,00%), a **diferença de arredondamento** e a marca "acima de 100%". Nenhum valor financeiro é alterado.

## 9. Responsividade e acessibilidade (verificado no navegador)

- **Celular (até 760 px):**
  - a navegação vira uma faixa horizontal com rolagem;
  - os filtros ficam em grade e os canais em 2 colunas;
  - a tabela rola por dentro;
  - medido a 375 px: a largura da página é igual à da tela, sem rolagem lateral.
- **Acessibilidade:**
  - link para pular ao conteúdo e foco visível;
  - expansões são `<button aria-expanded aria-controls>`, utilizáveis por toque e teclado, com alvos de 44 px;
  - "i" em `<details>`.
- **Formatação:** moeda e datas em pt-BR; valores longos não quebram o layout.

## 10. Testes e inspeção

- **Automatizados:** `frontend/test/financeiroV2Interface.test.js` tem 9 testes que cobrem os 28 itens. A numeração está no nome de cada teste. Usam o motor real e o cenário sintético.
- **Inspeção visual real** no navegador integrado (servidor local, dados sintéticos):
  - Visão Geral no desktop e no celular;
  - DRE expandida até os motoboys;
  - painel de composição pelo teclado;
  - estados desconhecido, zero confirmado, acesso negado e sem sessão.
- **Problemas encontrados e corrigidos na inspeção:**
  1. o painel aparecia aberto, porque o CSS anulava `[hidden]`;
  2. a página transbordava no celular (navegação e seletores sem `min-width: 0`).

## 11. Limitações

- **Ambiente:** a interface é **demonstrativa e local**. A integração com a sessão e as rotas reais depende das condições do § 1.
- **Indicadores indisponíveis:** saldo bancário, caixa físico, contas a pagar e a receber e fluxo de caixa aparecem como indisponíveis, porque não há contrato de consulta.
- **Documentos:** só registrados, não acessíveis, porque não há cofre de produção.
- **Descrições:** a descrição dos lançamentos é a do backend (por exemplo, "Venda BALCAO"). Um texto amigável fica para a próxima rodada.
- **Áreas restantes** (Vendas e Recebimentos, Contas, Caixa, Importações, Configurações): **em construção** (Execução 06 em diante).
