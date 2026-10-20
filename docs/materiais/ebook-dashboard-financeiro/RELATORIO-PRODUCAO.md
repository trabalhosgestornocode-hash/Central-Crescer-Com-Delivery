# E-book "Domine seu Financeiro": relatório de produção

Produzido em 20/10/2026. Material institucional, separado do código operacional.

## 1. Arquivos

| Arquivo | O que é |
|---|---|
| `Crescer-com-Delivery-Guia-Dashboard-Financeiro.pdf` | E-book final: A4, 10 páginas com a capa, cerca de 3,1 MB |
| `Crescer-com-Delivery-Guia-Dashboard-Financeiro-capa.png` | Capa em PNG, 1588 × 2246 px |
| `fonte/ebook.html` | Fonte diagramada: HTML e CSS de impressão, uma `<section class="pagina">` por página |
| `fonte/assets/logo-crescer-central.jpeg` | Logo oficial, cópia sem alteração de `frontend/assets/logo-crescer-central.jpeg` |
| `capturas/*.jpg` | Capturas reais das telas, feitas com dados sintéticos, em JPEG com escala 2x |
| `gerador/capturar.mjs` | Refaz as capturas a partir dos servidores de QA locais |
| `gerador/gerar-pdf.mjs` | Gera o PDF e a capa, e confere a diagramação antes |

### Como reproduzir

1. Suba os servidores de QA, que só escutam em loopback e usam ambiente fictício:

   ```
   env -u DATABASE_URL SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=ficticia SUPABASE_ANON_KEY=ficticia \
     node backend/testes-seguros/qa-visual/servidor-qa-integrado.mjs 4197
   env -u DATABASE_URL SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=ficticia SUPABASE_ANON_KEY=ficticia \
     node backend/testes-seguros/qa-visual/servidor-qa.mjs 4198
   ```

   O servidor integrado não é idempotente: as capturas gravam duas referências na memória dele. Reinicie-o antes de cada rodada de capturas.

2. Gere as capturas:

   ```
   QA_MODULOS=<pasta com playwright-core> FIN_BASE=http://127.0.0.1:4197 ADM_BASE=http://127.0.0.1:4198 node gerador/capturar.mjs
   ```

3. Gere o PDF e a capa:

   ```
   QA_MODULOS=<pasta com playwright-core> node gerador/gerar-pdf.mjs
   ```

   O gerador termina com erro se alguma página transbordar, algum elemento sair da margem ou alguma imagem não carregar.

## 2. Modelo visual reutilizado

O e-book reutiliza a identidade dos PDFs do Painel Administrativo, definida em `frontend/src/painelAdmPdf.js` (`cssRelatorioPdf`):
- **Página:** `@page` A4 com margem zero, cada página com altura fixa, cabeçalho e rodapé com linha fina e "Página X de Y".
- **Tipografia:** Segoe UI.
- **Cores:** vinho `#7d0f1c`, vermelho `#F42433`, cinzas `#666b73` e `#8a8f97`, e as cores de estado ok, atenção e crítico.
- **Capa:** mesmo degradê vinho, mesmo bloco de logo com marca em caixa alta, faixa vermelha e destaque com borda vermelha.
- **Componentes:** cartões com borda lateral de 2,2 pt, tabelas com cabeçalho vinho e linhas alternadas, selos ("badges") nos mesmos tons.
- **Logo:** o arquivo oficial, sem recriação.

## 3. Telas capturadas

Todas as capturas vêm do frontend real em execução local. Os dados são sintéticos: empresa "Delivery Demonstração", unidades A e B, pessoas fictícias com e-mails `@exemplo.invalid`. Os rótulos internos "QA" do ambiente de teste foram trocados só no texto exibido. Nenhuma captura toca produção.

| Página | Capturas |
|---|---|
| 2 | Escolha do setor (`00`) e tela inteira com o menu FINANCEIRO em destaque (`01`) |
| 3 | Visão Geral: cartões (`02`) e gráfico de entradas e saídas (`03`) |
| 4 | Fluxo de Caixa (`04`) e contas com tipo, canal e abertura, vindas das Configurações (`17`) |
| 5 | DRE Gerencial sem as linhas de detalhe (`08`) e Análise de Categorias (`10`) |
| 6 | Importação, etapa 1 (`12`) |
| 7 | Conciliação, ponte do mês (`13`), com duas referências sintéticas do canal STONE informadas pela própria tela no repositório em memória |
| 8 | Relatórios (`14`) e Pré-fechamento (`16`) |
| 9 | Painel SuperAdmin → Acesso Financeiro (`18`), em backend fictício e sem nenhuma gravação real |

As capturas `05`, `06`, `07`, `09`, `11` e `15` também foram geradas. Ficaram fora da diagramação por espaço ou clareza.

## 4. Validações feitas

- **PDF:** A4 (595 × 842 pt), 10 páginas, texto selecionável (cerca de 3.150 palavras extraíveis). Todas as fontes de texto são Segoe UI embutida em subconjunto (TrueType/Type0), sem fonte Type3. O ✓ da tabela de níveis virou um SVG vetorial. Só as capturas de tela são imagens; nenhuma página é imagem inteira.
- **Diagramação:** o próprio gerador confere cada página (sem transbordo, sem elemento fora da margem, todas as imagens carregadas). Todas as páginas foram renderizadas e revisadas visualmente para margens, legibilidade, sobreposições e espaço vazio. A revisão gerou estas correções:
  - página 3 reorganizada;
  - página 4 com outra captura de contas;
  - página 7 com a ponte ampliada;
  - cabeçalho da matriz de níveis alargado;
  - páginas 3, 5 e 6 completadas com conteúdo útil.
- **Tamanho:** cerca de 3,1 MB, adequado para WhatsApp.
- **Conteúdo comparado com o código:** os textos foram conferidos com:
  - os módulos de `frontend/src/financeiro/`;
  - a matriz de níveis em `backend/src/shared/gestaoFinanceira.permissoes.js`;
  - as rotas em `backend/src/modules/gestao-financeira/dominio/rotas.js`, conferidas para transferências (LANCAR), prévia (LANCAR), pares (CONCILIAR), confirmação (CONFIGURAR) e exportação (VER);
  - `frontend/src/adminAcessoFinanceiroModelo.js`;
  - o documento `docs/gestao-financeira/26-acesso-financeiro-simples.md`.

  Nenhum botão ou comportamento foi inventado. O guia não descreve nenhum fluxo com TOTP obrigatório.
- **Conta do exemplo:** os números do exemplo de conciliação (30.000,00 − 28.710,00 − 1.050,00 = 240,00) e do exemplo da DRE (−13.780 + 5.600 + 7.400 = −780) batem com as telas capturadas.
- **Dados sensíveis:** nenhum dado real do Açaí no Grau Saci ou de outro cliente, nenhum nome ou e-mail real, nenhuma credencial.

## 5. Limitações

- O tempo de leitura fica entre 10 e 13 minutos, conforme o ritmo de quem lê. A diagramação em tópicos e caixas favorece a leitura rápida.
- As capturas mostram a unidade sintética em outubro/2026, com pendências de propósito, para ensinar os selos "Parcial" e os bloqueios. Os números não representam um negócio real.
- A Importação aparece só na etapa 1. As etapas 2 a 4 estão descritas em texto, porque capturá-las exigiria montar uma planilha de livro-caixa sintética.
- A fonte é a Segoe UI do Windows, a mesma dos PDFs administrativos, embutida no PDF. Para regenerar em outro sistema operacional, a fonte de reserva do CSS altera a métrica do texto e a diagramação precisa ser revista.

## 6. Divergências observadas entre telas e documentação (sem alteração de código)

1. **Menção ao MFA:** as telas **Períodos** (cartão "Fechamento com pendências") e **Configurações Financeiras** (cartão do fechamento e lista de indisponíveis) ainda dizem que a exceção de fechamento com pendências e a reabertura estão indisponíveis "até a validação do MFA". Depois do doc 26, o MFA saiu só das concessões de acesso; essas duas funções continuam de fato indisponíveis. O e-book descreve as duas apenas como "bloqueado" e "indisponível nesta versão", sem citar MFA. As capturas usadas não mostram esse texto.
2. **Rótulo de Configurações:** o menu e o título da tela dizem "Configurações Financeiras". O pedido original chamava a área de "Configurações". O e-book usa o rótulo da tela.

Nada foi alterado no Financeiro, no backend, no banco, em permissões ou em produção, e nenhum deploy foi feito.
