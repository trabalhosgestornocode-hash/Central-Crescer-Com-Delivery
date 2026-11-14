# Financeiro v2 — 06. Validação de formatos reais (Execução 02B)

Data: 12/11/2026. Branch local `feat/financeiro-v2-formatos-reais`, derivada de `04c6277` (Execução 02).

> Este documento é público, porque o repositório é público. Ele **não** traz nenhum valor, nome, identificador ou trecho de documento real. Os totais de referência de setembro ficam só nos documentos privados (`02-referencia-setembro.md`, fora do Git) e no relatório privado de compatibilidade, guardado na pasta privada de amostras.

## 1. Resultado em uma frase

A infraestrutura de formatos reais (XLSX, PDF digital, OFX) está pronta e testada com arquivos sintéticos de estrutura técnica real. **Nenhuma exportação real das fontes estava disponível no ambiente local.** Por isso, nenhum leitor foi homologado, e a Execução 02B **não** está integralmente concluída: Stone e Unicred dependem das amostras.

## 2. Fontes avaliadas e onde se procurou

A busca ficou restrita às pastas destinadas a documentos financeiros do projeto, olhando apenas nomes de arquivo. Não houve varredura do computador nem leitura de diretórios de credenciais ou de configuração.

| Documento esperado | Encontrado? | Observação |
|---|---|---|
| Stone: planilha de vendas de 01/09 a 30/09/2026 | **Não** | — |
| Unicred: extrato de setembro (PDF ou OFX) | **Não** | — |
| SAIPOS: faturamento por dia, vendas por canal, formas de pagamento | **Não** (como exportação original) | O único arquivo "saipos" encontrado é uma planilha de importação do sistema antigo (outra estrutura de colunas). Nenhum leitor a reconheceu, o que é o comportamento correto. Ela não foi usada para homologar nada e não foi gravada no banco nem no cofre. |
| iFood: demonstrativo financeiro | **Não** | — |
| Foody: relatório de entregadores | **Não** | — |

Os anexos de conversas em outras ferramentas **não** estão disponíveis neste ambiente e não foram presumidos.

**Pasta privada preparada para receber as amostras**
- Local: `%LOCALAPPDATA%\fv2-amostras-privadas\`, fora do Git e fora do OneDrive.
- Subpastas: `stone\`, `unicred\`, `saipos\`, `ifood\`, `foody\` e `relatorios\`.
- O `LEIA-ME.txt` da pasta descreve os formatos esperados.
- O relatório privado de compatibilidade desta execução está em `relatorios\`.

## 3. Formatos implementados

A detecção é feita pelo **conteúdo** do arquivo, nunca pela extensão.

Cada adaptador declara os formatos que aceita:
- **SAIPOS, Stone, iFood e Foody:** CSV e XLSX.
- **Unicred:** CSV, XLSX, PDF e OFX.

Formato fora da lista é recusado com `FORMATO_NAO_SUPORTADO`. O `.xls` binário antigo não é suportado.

Os leitores são próprios, escritos só com `node:zlib`. As bibliotecas que já existem no backend ficaram de fora:
- o `pdf-parse` embute o pdf.js 1.10, de 2017, com falhas conhecidas diante de PDFs hostis;
- o pacote `xlsx` está numa versão não auditável.

Os arquivos vêm de fora do sistema, então a superfície de ataque foi mantida mínima.

### XLSX (`importacao/formatos/xlsx.js`)
- ZIP lido pelo diretório central, com métodos store e deflate.
- Proteções:
  - limite de entradas, de tamanho por entrada e total, contra bomba de compressão;
  - nenhum nome de entrada vira caminho de disco;
  - XML só com entidades predefinidas e numéricas.
- Abas na ordem da pasta de trabalho. O cabeçalho é procurado em **todas** as abas; vale a primeira que tiver todas as colunas obrigatórias, e a aba usada fica registrada na prévia.
- Tipos de célula: texto, número, data, booleano, erro, `formula_sem_valor` e vazio.
- **Datas do Excel:** o número de série é convertido pela época da pasta (1900 ou 1904), quando o estilo da célula é de data (formatos padrão e personalizados).
- **Fórmulas:** usa-se o resultado armazenado. Fórmula **sem** resultado vira a marca `#FORMULA_SEM_VALOR`, que gera erro de valor na linha e uma pendência `ANOMALIA_DE_PLANILHA`. Ela nunca é recalculada nem tratada como zero.
- Célula de erro (`#DIV/0!` etc.) é sinalizada da mesma forma.
- **Números:** o texto decimal tem no máximo 15 dígitos significativos, então o ruído de ponto flutuante (0,1 + 0,2) não vira terceira casa decimal.
- **Valor ambíguo:** valor com ponto e três casas, sem vírgula (por exemplo, "20.005"), é **recusado**. Não se adivinha se é milhar ou decimal.

### PDF digital (`importacao/formatos/pdf.js`)
- Lê objetos diretos e object streams (`/ObjStm`), streams com `/FlateDecode`, a árvore de páginas e as fontes (simples, WinAnsi, e `/ToUnicode` de 1 ou 2 bytes).
- Interpreta só os operadores de texto. **Nada do arquivo é executado**: não há JavaScript, fontes compiladas nem renderização.
- Linhas por página: fragmentos agrupados pela altura e ordenados pela posição horizontal.
- **Diagnóstico:** páginas declaradas × páginas lidas, páginas sem texto, páginas com imagem e streams corrompidos.
- **PDF digitalizado** (imagem sem texto): `PDF_DIGITALIZADO`. Não há OCR; o arquivo é rejeitado e **preservado** no cofre.
- **PDF incompleto** (contagem de páginas diferente ou stream corrompido): `PDF_INCOMPLETO`.
- PDF criptografado é recusado, com o pedido de exportar sem senha.

### OFX (`importacao/formatos/ofx.js`)
- Versão 1.x (SGML) e 2.x (XML).
- Campos lidos: período (`DTSTART`/`DTEND`), transações (`FITID`, `DTPOSTED`, `TRNAMT`, `NAME`/`MEMO`, `CHECKNUM`/`REFNUM`) e saldo (`LEDGERBAL`).
- `FITID` vira identificador externo, então a identificação é `ID_EXTERNO`.
- O saldo do OFX só vale como **saldo final** se `DTASOF` for a data de fim do período. Caso contrário, é **saldo atual** e fica registrado à parte.
- OFX normalmente não traz saldo inicial. Nesse caso, a consistência do extrato fica **não comprovável**, e isso aparece como pendência.
- Não se presume que o OFX da Unicred tenha os mesmos campos de outros bancos: o que faltar fica nulo e aparece na conferência.

### Extrato em PDF → movimentações (`fontes/unicred.js`, `tabelaDoPdf`)
O layout esperado precisa ser **confirmado com a amostra real**: data no início da linha, descrição, valor e saldo opcional no fim. Regras de leitura:
- Valores com sufixo `C`/`D` ou sinal.
- Data sem ano usa o ano do período.
- Descrição quebrada em várias linhas é juntada à movimentação.
- Linha de valores sem data herda a data anterior.
- Cada movimentação leva a página de origem.
- As linhas de saldo são lidas assim:
  - "saldo anterior" é o saldo inicial;
  - "saldo final" é o saldo final;
  - "saldo atual" e "saldo disponível" são a posição na data de emissão: ficam registrados, mas **nunca** substituem o saldo final do período.
- Linha não interpretada e rodapé "Página X de Y" incoerente viram pendência `LEITURA_INCOMPLETA`.
- Movimentação faltando no meio é denunciada pelo encadeamento de saldos (`LINHA_NAO_FECHA`) e pelo fechamento (`SALDO_NAO_FECHA`).

## 4. Validações por fonte

As validações da Execução 02 continuam valendo (doc 05, seções 3 e 4). Em todos os formatos:
- período declarado;
- estabelecimento;
- totais de controle;
- duplicidade de identificadores no arquivo e contra o banco;
- versão corrigida por substituição explícita;
- prévia sem efeito financeiro.

Os critérios de conferência documental de setembro (quantidades e totais de Stone e Unicred) servem só como **comparação na conferência privada**. Eles **não** estão no código nem nos testes versionados.

## 5. Contratos de autorização (sessão e liberações)

**Liberações persistentes.** Migração `0003_concessoes.sql`, operações em `aplicacao/acessos.js`.
- Há uma liberação por usuário e por unidade, com as ações `financeiro_v2.*`, a situação (ativa ou revogada), quem concedeu e a justificativa. Tudo tem histórico.
- O banco garante:
  - ações só do catálogo `financeiro_v2.*`;
  - ninguém concede a si mesmo;
  - liberação ativa tem ao menos uma ação, e revogada não tem nenhuma;
  - nada se apaga;
  - isolamento por escopo (RLS).
- `concederAcesso` e `revogarAcesso` exigem `financeiro_v2.conceder` **na unidade do contexto**. O comando não aceita unidade.
- Regras contra escalada:
  - ninguém concede ou revoga a si mesmo;
  - ninguém concede uma ação que não possui;
  - toda mudança exige justificativa.
- O **administrador inicial** de cada unidade é provisionado fora da aplicação, como o cadastro de escopos.

**Sessão.**
- `criarConcessoesDoRepositorio` alimenta o adaptador de sessão a partir do banco, escopo a escopo, pelo RLS de cada um.
- Papel antigo, superadmin e as permissões do sistema atual **não** concedem nada.
- Leitura (`ver`) não importa.
- Liberação numa unidade não vale em outra, nem em outra organização.
- **Contrato com o middleware atual:** um teste confere, só pelo código-fonte (sem consultar produção), que `req.user.id`, `req.tenant.organizacaoId/unidadeId` e `req.acesso.sessionId/expiraEm/impersonando/impersonadoPor` continuam montados no servidor. Se o formato mudar, o teste obriga a revisar o adaptador.
- Nenhuma rota foi criada.

## 6. Testes realizados

**Arquivos novos:**
- `formatos-arquivo.test.js` cobre:
  - XLSX válido, inválido, com várias abas, datas 1900/1904, fórmulas com e sem resultado, cabeçalho diferente, valor anômalo e identificador repetido;
  - PDF válido, multilinha, com ToUnicode e object stream, incompleto, digitalizado, com saldo divergente e com movimentação faltante;
  - OFX 1.x e 2.x, válido e inválido, e saldo atual × final;
  - detecção de formato e rejeição de formato incompatível;
  - fluxo no núcleo com repetição, versão corrigida e ausência de efeito financeiro.
- `acessos-sessao.test.js` cobre:
  - conceder e revogar;
  - só leitura não importa;
  - escalada recusada;
  - isolamento;
  - concorrência;
  - contrato com o middleware.

Os arquivos sintéticos são gerados em `helpers/formatos.js`: ZIP/XLSX com estilos de data, PDF com streams compactados, ToUnicode e ObjStm, e OFX nas duas versões.

**Resultados:** as suítes rodam em memória e no PostgreSQL local isolado. Os números estão no relatório final da execução.

## 7. Situação de homologação de cada leitor

| Leitor | Formatos | Situação |
|---|---|---|
| `STONE_VENDAS` | CSV, XLSX | **Bloqueado por ausência de arquivo.** Estrutura técnica pronta e testada com sintético; colunas reais não confirmadas. |
| `STONE_RECEBIMENTOS` | CSV, XLSX | **Somente sintético** (relatório futuro) |
| `UNICRED_EXTRATO` | CSV, XLSX, PDF, OFX | **Bloqueado por ausência de arquivo.** PDF e OFX prontos e testados com sintético; layout real não confirmado. |
| `SAIPOS_VENDAS` | CSV, XLSX | **Bloqueado por ausência de arquivo** |
| `SAIPOS_VENDAS_DIARIAS` | CSV, XLSX | **Bloqueado por ausência de arquivo.** O arquivo local encontrado não é exportação SAIPOS. |
| `SAIPOS_VENDAS_POR_CANAL` | CSV, XLSX | **Bloqueado por ausência de arquivo** |
| `SAIPOS_FORMAS_PAGAMENTO` | CSV, XLSX | **Bloqueado por ausência de arquivo** |
| `IFOOD_APURACAO` | CSV, XLSX | **Somente sintético.** Sem exportação oficial disponível. |
| `FOODY_ENTREGAS` | CSV, XLSX | **Somente sintético.** Sem exportação disponível. |

Nenhum leitor está "homologado com amostra real" ou "compatível parcialmente".

## 8. Limitações

- O extrator de PDF cobre PDFs digitais comuns: texto em operadores `Tj`/`TJ` e fontes com codificação simples ou `ToUnicode`. Ficam fora: fontes sem mapa Unicode com codificação personalizada, texto em formulários (XFA) e PDFs com xref corrompido que dependam de recuperação. Esses casos aparecem como linhas não interpretadas ou como erro, nunca como valores inventados.
- O layout de linha do extrato em PDF é uma hipótese até a amostra real chegar.
- O XLSX não avalia fórmulas: só usa o resultado armazenado pelo Excel.
- `.xls` binário e CSV com codificações além de UTF-8 e Windows-1252 não são suportados.
- Em memória, as transações são serializadas, então a concorrência só é comprovada no modo PostgreSQL.

## 9. Pendências documentais

Para homologar, são necessários os arquivos **originais**, exportados das fontes e sem edição, colocados em `%LOCALAPPDATA%\fv2-amostras-privadas\`:
1. Stone: XLSX de vendas de 01/09 a 30/09/2026 e, se existir, o relatório de recebimentos.
2. Unicred: extrato de setembro em PDF **digital** e, se possível, o OFX do mesmo período.
3. SAIPOS: faturamento por dia, vendas por canal e formas de pagamento de setembro.
4. iFood: demonstrativo ou apuração financeira oficial do período.
5. Foody: relatório de entregas por entregador do período.

Com os arquivos, a próxima rodada faz:
- a conferência **privada**: estrutura, quantidade de registros e totais de controle comparados com os critérios documentais;
- o ajuste dos rótulos de coluna e do layout do PDF à amostra;
- um teste com amostra sintética da **mesma** estrutura;
- e só então a reclassificação de cada leitor na matriz.

---

## 10. Retomada da 02B com amostras reais (12/11/2026)

O usuário forneceu as exportações reais de setembro de **Stone, Unicred e SAIPOS**, que foram extraídas para a pasta privada. A análise foi feita localmente, sem enviar nada para fora. A prévia ponta a ponta usou repositório em memória e cofre privado, e **nada foi confirmado**: a receita bruta continuou zero. Os números de conferência e a investigação dia a dia estão **só no relatório privado** (`%LOCALAPPDATA%\fv2-amostras-privadas\relatorios\`). Este documento descreve estrutura e resultado, sem valores.

### 10.1 Layouts reais observados e como foram tratados

**Stone — vendas (XLSX)**
- Uma aba, cabeçalho na 1ª linha, 18 colunas. **Todas as células são texto.**
- Valores com **6 casas decimais** e descontos **negativos**. A taxa do cartão vem em "DESCONTO UNIFICADO" e a do Pix em "DESCONTO DE MDR".
- Como o leitor trata isso:
  - novo leitor de valores em **milionésimos de real** (`leitor.micros`);
  - desconto total = |MDR| + |antecipação| + |unificado|, conferido contra bruto − líquido **em cada linha**;
  - líquido e descontos sem arredondamento por linha; o centavo só no total de conferência (meio para cima);
  - bruto com fração de centavo é erro;
  - o **número do cartão (mesmo mascarado) não é guardado** (`colunasOmitidas`);
  - situação separada em aprovadas, rejeitadas, pendentes e não reconhecidas.

**Unicred — extrato (PDF digital)**
- Cada movimentação vem em três partes: o início da descrição ("TIPO ( Doc.: N / …") antes da linha "data [-] R$ valor R$ saldo", e o fim da descrição depois dela, até fechar o parêntese. Algumas movimentações vêm numa linha só.
- O "-" antes do valor indica débito.
- Saldos:
  - "Saldo em dd/mm/aaaa" com data anterior ao período é o saldo inicial;
  - "Saldo no final do período" é o saldo final;
  - "Saldo atual" (na emissão) fica registrado à parte e nunca substitui o final.
- O período declarado no extrato é conferido com o da importação (`PERIODO_DO_DOCUMENTO`).
- Rodapé e cabeçalho de página são ignorados.

**SAIPOS — faturamento por dia (PDF digital)**
- Tabela em que cada dia ocupa **duas linhas de texto**, e os valores só se resolvem pela **posição horizontal**.
- O extrator de PDF passou a devolver a posição de cada fragmento (`posicoes`). As âncoras das colunas vêm das palavras do próprio cabeçalho.
- Conferências:
  - valor acumulado encadeado dia a dia;
  - linha TOTAL do relatório (faturamento, descontos e quantidade de vendas) comparada com a soma dos dias;
  - cobertura dos dias contra o período.
- A data solta do cabeçalho não vira dia.

**SAIPOS — formas de pagamento (XLSX)**
- Colunas: forma, valor total, quantidade, % e **uma coluna por dia**.
- Conferências: total da forma contra a soma dos dias; dias fora do período são erro; cobertura menor que o período vira pendência.
- **Formas anômalas** viram pendência `VALOR_A_CLASSIFICAR` e nunca são aceitas como venda válida em silêncio:
  - forma não reconhecida, como "pagamento não cadastrado" ou máquina de outra marca;
  - forma com natureza de desconto ("voucher … desconto").

**Categorias bancárias sugeridas** (corrigidas com o extrato real): a palavra "Doc." não indica mais transferência; "iFood" numa saída é pagamento à plataforma, não repasse; crédito de adquirente só conta em entrada. Foram incluídas tarifa de conta, seguro e arrecadação. Tudo continua sendo **sugestão**, sem classificação na DRE: crédito não vira faturamento, e liquidação de empréstimo não vira despesa integral.

### 10.2 Compatibilidade por formato

Um leitor só é "amostra real" **no formato conferido** (`formatosHomologados`). A prévia e a importação registram a compatibilidade do formato efetivamente lido. Por exemplo, o CSV da Stone e o OFX da Unicred continuam sintéticos.

### 10.3 Matriz final da Execução 02B

| Leitor | Situação | Base |
|---|---|---|
| `STONE_VENDAS` (xlsx) | **Homologado com amostra real** | quantidade, bruto, líquido e descontos reproduzidos; todas as linhas fecham |
| `UNICRED_EXTRATO` (pdf) | **Homologado com amostra real** | movimentações, saldo inicial, entradas, saídas e saldo final reproduzidos; todos os saldos intermediários encadeiam |
| `SAIPOS_FATURAMENTO_POR_DIA` (pdf) | **Homologado com amostra real** | total = acumulado = linha TOTAL; descontos e quantidade = TOTAL |
| `SAIPOS_FORMAS_PAGAMENTO` (xlsx) | **Homologado com amostra real** | total = soma dos dias; relatório de um dia coerente com o mensal |
| `UNICRED_EXTRATO` (csv, xlsx, ofx) | Somente sintético | sem amostra nesses formatos |
| `STONE_VENDAS` (csv) | Somente sintético | — |
| `SAIPOS_VENDAS` (por pedido) | **Bloqueado por documento ausente** | necessário para explicar a diferença faturamento × formas |
| `SAIPOS_VENDAS_POR_CANAL` | **Bloqueado por documento ausente** | — |
| `SAIPOS_VENDAS_DIARIAS` (csv/xlsx) | Somente sintético | substituído na prática pelo faturamento por dia em PDF |
| `STONE_RECEBIMENTOS` | **Bloqueado por documento ausente** | — |
| `IFOOD_APURACAO` | **Bloqueado por documento ausente** (contrato sintético) | — |
| `FOODY_ENTREGAS` | **Bloqueado por documento ausente** (contrato sintético) | — |

### 10.4 Divergência SAIPOS (pendência aberta)

O faturamento por dia e o total por formas de pagamento **não coincidem**. A diferença se concentra em parte dos dias, e quase sempre com o faturamento maior.

**Descartados como causa única:** descontos, acréscimos e formas anômalas.

**Hipótese não confirmada:** pedidos sem pagamento registrado, ou com pagamento lançado em outra data.

**Para fechar:** o relatório SAIPOS de vendas **por pedido** do mesmo mês.

Nenhum ajuste foi criado. A comparação continua disponível em `compararRelatoriosSaipos`, que só detecta a diferença.

### 10.5 Testes

O arquivo `formatos-reais.test.js` reproduz, com dados 100% sintéticos, as quatro estruturas reais (Stone XLSX, Unicred PDF, SAIPOS PDF por posição e SAIPOS XLSX por dia), seus casos de erro e o fluxo pelo núcleo. O gerador de PDF dos testes passou a aceitar linhas posicionadas.
