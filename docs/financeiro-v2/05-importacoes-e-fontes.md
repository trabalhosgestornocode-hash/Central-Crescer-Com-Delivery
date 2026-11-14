# Financeiro v2 — 05. Importações, fontes e preparação da conciliação (Execução 02)

Data: 12/11/2026. Branch local `feat/financeiro-v2-importacoes`, derivada de `84b5e22` (Execução 01B).
Escopo: infraestrutura de importação, cofre documental local, adaptador de sessão e bases da conciliação.
Fora do escopo desta execução: DRE, Visão Geral, integrações bancárias remotas, DDA, pagamentos, conciliação automática
definitiva, estoque, CMV, rotas públicas, deploy e qualquer acesso à produção.

> Nenhum valor financeiro real está neste documento nem nos testes. Os totais reais de setembro ficam só no documento
> privado `02-referencia-setembro.md`, que continua **fora do Git**.

## 1. Arquitetura dos importadores

```
arquivo (bytes) ──► cofre privado (original imutável, SHA-256)
        │
        └─► núcleo.receberArquivoParaImportacao  [permissão financeiro_v2.importar]
              ├─ ficha do DOCUMENTO (origem, hash, tipo, versão, responsável)
              ├─ IMPORTACAO: RECEBIDO → EM_VALIDACAO → PRONTO_PARA_IMPORTAR | REJEITADO
              └─ PRÉVIA = motor.analisarArquivo(bytes, adaptador da fonte) + confronto com o que já foi gravado
                    (nada é gravado como registro de fonte nesta etapa)

núcleo.confirmarImportacao(importacaoId, impressaoPrevia, [aceitarPendencias + justificativa])
   ├─ trava exclusiva por fonte+relatório no escopo; guarda de fechamento da competência
   ├─ RELÊ o arquivo do cofre (confere o hash) e REFAZ a prévia; se mudou → recusa
   ├─ grava os REGISTRO_FONTE novos numa única transação (tudo ou nada)
   └─ IMPORTADO | IMPORTADO_COM_PENDENCIAS + relatório da importação
```

Camadas no módulo `backend/src/modules/financeiro-v2/`:

| Arquivo | Papel |
|---|---|
| `importacao/leitor.js` | bytes → texto (UTF-8 estrito, senão Windows-1252) → tabela CSV/TSV/`;`; valores em reais e datas estritos |
| `importacao/motor.js` | motor genérico puro: cabeçalho, linhas, período, estabelecimento, identificação, duplicidades, totais |
| `importacao/fontes/*.js` | um adaptador por relatório (SAIPOS ×4, Stone ×2, iFood, Foody, Unicred) |
| `importacao/correspondencias.js` | regras puras que propõem candidatas de conciliação |
| `contratos/importacao.js` | contratos de entrada estritos |
| `aplicacao/importacoes.js` | operações do núcleo (receber, reavaliar, confirmar, rejeitar, consultar, ler original, comparar, gerar candidatas) |
| `aplicacao/sessao.js` | adaptador sessão do app → contexto do Financeiro v2 |
| `infra/cofreDisco.js` | cofre local em disco + registro de acessos negados |
| `database/financeiro-v2/migracoes/0002_importacoes.sql` | tabelas `fv2_importacao`, `fv2_registro_fonte`; correspondência ampliada |

**Importar ≠ confirmar ≠ conciliar ≠ homologar.** Um `REGISTRO_FONTE` é a linha da fonte, fiel ao original, sem efeito
financeiro: não cria venda, receita, despesa, recebível nem saldo. Os testes provam que, depois de importar todas as
fontes, `RECEITA_BRUTA`, `DESPESAS` e `DEDUCOES` continuam zero.

## 2. Formatos aceitos

- Texto tabular: CSV com `;`, `,` ou tabulação (detectado pela primeira linha), aspas RFC 4180, BOM ignorado.
- Valores: `1.234,56`, `-12,30`, `R$ 10,00` e `1234.56`. Qualquer outro formato é **erro com número da linha**.
- Datas: `dd/mm/aaaa` ou `aaaa-mm-dd`, com hora opcional; data inexistente (31/02) é erro.
- XLSX, PDF e OFX **não** são lidos nesta execução. A conversão para CSV, ou um leitor dedicado, depende de amostras reais.

## 3. Contratos de cada fonte

Cada importação declara **fonte + tipo de relatório**. O arquivo é conferido contra **aquele** contrato e nunca é
"adivinhado" entre formatos. Se faltar coluna obrigatória, o arquivo é REJEITADO com `FORMATO_NAO_RECONHECIDO`.

| Tipo de relatório | Registro | Identificação | Conferências |
|---|---|---|---|
| `SAIPOS_VENDAS` | `PEDIDO` | número do pedido | itens − desconto + acréscimo + entrega = total; soma × rodapé; canal reconhecido |
| `SAIPOS_VENDAS_POR_CANAL` | `TOTAL_CANAL` | impressão digital (canal + período) | soma × rodapé |
| `SAIPOS_FORMAS_PAGAMENTO` | `TOTAL_FORMA` | impressão digital (forma + período) | soma × rodapé |
| `SAIPOS_VENDAS_DIARIAS` | `TOTAL_DIA` | impressão digital (dia + período) | soma × rodapé |
| `STONE_VENDAS` | `TRANSACAO` | identificador da transação | taxa informada (MDR + antecipação) = bruto − líquido |
| `STONE_RECEBIMENTOS` | `RECEBIMENTO` | transação + parcela | soma × rodapé; totais por data de pagamento |
| `IFOOD_APURACAO` | `COMPONENTE_APURACAO` | impressão digital | soma dos componentes = repasse previsto; pago × previsto |
| `FOODY_ENTREGAS` | `ENTREGA` | número do pedido | entregas por entregador = subtotal; soma = total devido |
| `UNICRED_EXTRATO` | `LANCAMENTO_BANCARIO` | impressão digital (com saldo após) | inicial + entradas − saídas = final; encadeamento linha a linha |

Regras de negócio preservadas pelos leitores:

- **SAIPOS:** forma de pagamento é uma dimensão própria e não indica o canal. Canal desconhecido fica nulo, como pendência; nunca vira "Balcão". O total das formas de pagamento **não** é tratado como faturamento bruto. `compararRelatoriosSaipos` só **detecta** a diferença em relação ao faturamento e não cria ajuste. Os valores financeiros do iFood são reconciliados com a apuração do próprio iFood.
- **Stone:** a transação é marcada como `VENDA_PROCESSADA`. O canal fica nulo, ou seja, Stone não significa Balcão. O leitor distingue taxa calculada, taxa informada e antecipação. A transação não cria venda e não prova depósito: a liquidação só aparece no extrato, por conciliação. O relatório de recebimentos foi preparado como contrato separado.
- **iFood:** cada linha da apuração é preservada. Cada componente leva uma categoria **sugerida** do plano de contas:
  - comissão → `COMISSOES_IFOOD`;
  - transação de pagamento → `TAXAS_DE_PROCESSAMENTO`;
  - mensalidade → `MENSALIDADE_IFOOD`;
  - anúncios → `ANUNCIOS_IFOOD`;
  - promoção da loja → `PROMOCOES_SUBSIDIADAS`;
  - promoção subsidiada pelo iFood → informativa;
  - antecipação → `TAXAS_ANTECIPACAO`, marcada `jaIncluidaNaApuracao`, para não ser descontada de novo;
  - ajustes e serviços descontados → "a classificar";
  - repasses → liquidação.

  Componente desconhecido vira pendência `VALOR_A_CLASSIFICAR` e nunca recebe classificação por suposição.
- **Foody:** o relatório é fonte do valor **devido** aos entregadores próprios, não de pagamento. Entregas canceladas e com taxa rejeitada não entram no devido. A importação não cria despesa; por isso não há como duplicar despesas trazidas das planilhas antigas de frete.
- **Unicred:** fechar o saldo prova só a consistência aritmética do extrato. A categoria bancária (tarifa, Pix, boleto, empréstimo, crédito de adquirente, repasse de plataforma) é **sugestão**, com `classificacaoConfirmada: false`. Crédito no extrato não vira venda; débito não vira despesa.

## 4. Campos e validações

Cada registro de fonte guarda:
- fonte e tipo de relatório;
- tipo de registro e identificador externo (quando houver);
- forma de identificação;
- número da linha;
- data e competência;
- valor principal em centavos;
- `dados` normalizados, com todos os componentes em centavos;
- `original`, com as células da linha exatamente como vieram no arquivo;
- documento e importação de origem;
- estado de conferência (`NAO_CONFERIDO`, `CONFERIDO` ou `DIVERGENTE`);
- situação (`ATIVO` ou `SUBSTITUIDO`).

Erros **bloqueantes**: a importação vai para `REJEITADO` e nada é gravado.
- formato não reconhecido;
- arquivo vazio;
- campo obrigatório vazio;
- valor ou data inválidos;
- registro fora do período declarado;
- estabelecimento de outra unidade;
- mesmo identificador com conteúdos diferentes no mesmo arquivo.

**Divergências**: só se importa com `aceitarPendencias` e justificativa, e o resultado é `IMPORTADO_COM_PENDENCIAS`.
- linha que não fecha;
- total declarado diferente da soma;
- saldo que não fecha;
- canal ou componente não reconhecido;
- estabelecimento sem cadastro para conferir;
- conflito com registro já importado.

A divergência fica guardada na prévia e no relatório. Nenhum valor é alterado para "fechar".

Os períodos de importação têm no máximo 92 dias, e o fim não pode estar no futuro.

## 5. Regras de idempotência

- **Arquivo:** o mesmo conteúdo (SHA-256) no mesmo escopo tem um único documento. O mesmo arquivo enviado de novo para o mesmo relatório devolve a **mesma** importação (`repetido: true`), inclusive em envios simultâneos.
- **Registro:** a chave combina fonte, tipo de registro e identificador. É única **por organização e unidade** no banco (`fv2_registro_fonte_chave_uq`).
  - Registro idêntico já importado por outro arquivo é contado como `jaImportados` e não é gravado de novo.
  - Mesma origem com conteúdo diferente é contada como `conflitos` e não é gravada; vira pendência que indica envio como versão corrigida.
- **Confirmação:** confirmar de novo devolve o resultado anterior. Confirmações concorrentes do mesmo relatório são serializadas por trava exclusiva. Quem perde a corrida é recusado porque a prévia mudou, e nunca grava em dobro.
- **Sem identificador estável** (totais SAIPOS, componentes iFood, linhas de extrato): a chave usa uma **impressão digital**, o SHA-256 dos campos de identidade da linha (no extrato, inclusive o saldo após), mais o **número da ocorrência** daquela impressão no arquivo.
  - Duas linhas iguais continuam sendo duas. Nunca se fundem por terem o mesmo valor e a mesma data.
  - **Riscos:**
    1. Uma versão corrigida que reordene linhas idênticas muda as ocorrências. Por isso, correções entram como **substituição explícita** (`substituiImportacaoId`), que desativa os registros anteriores em vez de compará-los linha a linha.
    2. Dois arquivos que se sobrepõem parcialmente, sem identificador, podem numerar ocorrências de forma diferente. A regra é importar extratos por período fechado e sem sobreposição.
    3. A fonte pode mudar o texto do histórico entre exportações. Nesse caso, o registro aparece como novo, e a prévia mostra isso antes da confirmação.
- **Versão corrigida:**
  - O novo documento aponta para o anterior (`substituiId`, versão + 1).
  - Na confirmação, os registros ativos da importação anterior viram `SUBSTITUIDO`. Nada é apagado. A chave desses registros é liberada para a nova versão.
  - A importação anterior fica `SUBSTITUIDO`, e o documento anterior ganha `substituidoPorId`.
  - Uma importação só pode ser substituída uma vez.

## 6. Segurança documental

- **Cofre** (`infra/cofreDisco.js`, porta `contratos/cofre.js`):
  - A pasta raiz precisa ser **absoluta**, ficar **fora de repositório Git** e fora de pastas **sincronizadas com nuvem** (OneDrive, Dropbox, Google Drive, iCloud). Do contrário, o cofre nem é criado. Os testes cobrem os três casos de recusa.
  - Cada organização+unidade tem uma gaveta própria, cujo nome é um hash que não revela identificadores.
  - O arquivo é endereçado pelo SHA-256. A gravação é exclusiva (`wx`), então **nunca sobrescreve**. Um arquivo existente adulterado faz a operação **falhar**, em vez de ser trocado em silêncio.
  - Toda leitura confere o hash.
  - Não existe exclusão nem URL pública. O contrato recusa adaptadores que ofereçam `remover`, `urlPublica` e semelhantes.
  - Identificador malformado (por exemplo, `cofre:../../`) não escapa da pasta.
- **Acesso:** `lerArquivoDoDocumento` exige `financeiro_v2.ver`, escopo autorizado e documento do mesmo escopo. Documento de outra unidade responde "não encontrado".
- **Tentativas negadas:** ficam em `auditoria/acessos-negados.jsonl`, dentro da pasta privada do cofre. O arquivo guarda só quem, quando, qual documento, que evento e que código. **Nunca** guarda conteúdo, valores ou nomes de arquivo. Há teste que confere isso.
- **Logs:** o módulo não usa `console` (teste estático), e nenhum log recebe conteúdo de documento.
- **Retenção proposta:**
  - Não há exclusão automática; nada foi implementado para apagar.
  - Os originais ficam guardados pelo prazo legal de guarda fiscal e contábil (referência: 5 anos após o exercício, a confirmar com a contabilidade).
  - Documentos substituídos são mantidos pelo mesmo prazo, porque fazem parte da trilha.
  - Arquivos do cofre sem ficha, sobra de uma transação desfeita, são aceitos e podem ser identificados por varredura de hash sem ficha. A remoção, se um dia existir, exigirá decisão explícita e auditada.
- **Requisitos para o cofre de produção** (não implementado):
  - armazenamento privado, sem leitura pública;
  - chave de acesso só no servidor;
  - criptografia em repouso;
  - versionamento ou bloqueio contra sobrescrita e exclusão;
  - auditoria de acesso;
  - URL temporária só se decidida explicitamente e com registro;
  - região e retenção definidas;
  - backup;
  - mesma interface `guardar` / `ler` / `existe`;
  - teste de conformidade `conferirCofre`.
- **Git:** nenhum extrato, PDF, planilha ou documento real foi versionado. O `02-referencia-setembro.md` segue fora do Git, e sua localização não foi alterada.

## 7. Estados de importação

`RECEBIDO → EM_VALIDACAO → PRONTO_PARA_IMPORTAR → IMPORTADO | IMPORTADO_COM_PENDENCIAS`. Saídas possíveis:
- `PRONTO_PARA_IMPORTAR → REJEITADO`: rejeição manual, com justificativa;
- `EM_VALIDACAO → REJEITADO`: o arquivo tem erros;
- `PRONTO_PARA_IMPORTAR → SUBSTITUIDO` e `IMPORTADO* → SUBSTITUIDO`: chegou uma versão corrigida.

O banco recusa qualquer outra transição e qualquer reescrita de importação encerrada (`FV012`).

O estado da importação **não** é o estado de conferência dos valores. Os registros entram `NAO_CONFERIDO`.

## 8. Situações de divergência

| Código | Exemplo | Efeito |
|---|---|---|
| `TOTAL_NAO_CONFERE` | rodapé ≠ soma; subtotal do entregador ≠ entregas; componentes iFood ≠ repasse previsto | pendência |
| `LINHA_NAO_FECHA` | pedido cujos componentes não somam o total; taxa Stone informada ≠ calculada; saldo após não encadeia | pendência |
| `SALDO_NAO_FECHA` | inicial + entradas − saídas ≠ final; extrato sem saldo inicial ou final | pendência |
| `VALOR_A_CLASSIFICAR` | canal, componente ou situação não reconhecidos | pendência |
| `ESTABELECIMENTO_NAO_VERIFICADO` | arquivo traz estabelecimento e a unidade não tem cadastro para conferir | pendência |
| `CONFLITO_COM_IMPORTADO` | origem já importada com conteúdo diferente | pendência; registro não gravado |
| SAIPOS faturamento × formas de pagamento | diferença conhecida de setembro (valores no documento privado 02) | consulta `compararRelatoriosSaipos`; sem ajuste |

## 9. Preparação da conciliação

As candidatas são **hipóteses**. Cada uma traz `relacao`, `regra` e `forca`:
- **FORTE**: os dois lados têm um identificador da fonte em comum;
- **FRACA**: só valor e data batem, o que nunca é prova.

Toda candidata automática preserva como evidência os documentos de origem dos dois lados, e o banco exige essa evidência.

| Relação | Regra | Força |
|---|---|---|
| `SAIPOS_X_STONE` | autorização em comum; senão, mesmo valor e até 10 min (só pedidos de cartão, Pix ou vale) | FORTE / FRACA |
| `STONE_X_RECEBIMENTO` | identificador da transação; lado da transação pelo **líquido** | FORTE |
| `RECEBIMENTO_STONE_X_UNICRED` | soma dos recebimentos do dia = crédito, até 1 dia (N:1) | FRACA |
| `IFOOD_X_UNICRED` | repasse pago = crédito, até 3 dias | FRACA |
| `FOODY_X_UNICRED` | total devido ao entregador = débito, até 10 dias após a última entrega | FRACA |
| `MANUAL` | conta a pagar × pagamento, transferência entre contas etc. (`criarCorrespondenciaCandidata`) | — |

Estados de uma correspondência: `CANDIDATA`, `CONFIRMADA`, `REJEITADA`, `DIVERGENTE` e `AGUARDANDO_DOCUMENTO` (exige justificativa dizendo qual documento falta).

Regras de confirmação:
- Só se confirma o que fecha (diferença zero).
- Um registro não é conciliado acima do próprio valor.
- Registro de fonte substituído por versão corrigida não pode ser conciliado.
- **Confirmação ambígua é recusada**: quando outra candidata em aberto da **mesma relação** disputa os mesmos registros, as concorrentes precisam ser rejeitadas, com justificativa, antes da confirmação. Relações diferentes formam uma cadeia (transação → recebimento → crédito) e não competem entre si.
- Registros sem par aparecem em `registrosSemCandidato`. Nada é inventado.

Nenhuma conciliação real foi feita ou declarada nesta execução.

## 10. Testes e suas limitações

Arquivos novos em `backend/test/financeiro-v2/`:
- `importacoes-fontes.test.js`: leitores puros;
- `importacoes-fluxo.test.js`: fluxo no núcleo, em memória e no PostgreSQL;
- `conciliacao-importada.test.js`;
- `sessao-cofre-local.test.js`;
- `postgres-trava-repeticao.test.js`: Fase A e proteções da 0002, só no PostgreSQL;
- `simulacao-setembro.test.js`: mês sintético completo.

Cobertura dos itens obrigatórios:

| Item | Onde |
|---|---|
| Leitura válida de cada fonte | `importacoes-fontes`, 9 relatórios |
| Arquivo inválido; campos ausentes; valores inválidos | `importacoes-fontes`, testes 2–3 |
| Totais inconsistentes | `importacoes-fontes`, testes 4, 10, 11, 12 |
| Arquivos repetidos; registros repetidos no mesmo arquivo | `importacoes-fluxo` 3–4; `importacoes-fontes` 5–6 |
| Versão corrigida | `importacoes-fluxo` 5; `conciliacao-importada` 5 |
| Período incorreto | `importacoes-fontes` 7; `importacoes-fluxo` 3 |
| Unidade não autorizada | `importacoes-fluxo` 10; `sessao-cofre-local` 2; `importacoes-fontes` 8 (estabelecimento) |
| Falha de persistência e rollback; reimportação de arquivo parcialmente processado | `importacoes-fluxo` 6 |
| Importações concorrentes | `importacoes-fluxo` 7 (real só no modo PostgreSQL) |
| Sem duplicidade SAIPOS × Stone | `importacoes-fluxo` 8 |
| Preservação dos documentos; permissões do cofre | `importacoes-fluxo` 5, 9; `sessao-cofre-local` 5–7 |
| Isolamento por organização e unidade | `importacoes-fluxo` 10; `postgres-trava-repeticao` 4 (RLS) |
| Extrato que fecha / que não fecha | `importacoes-fontes` 12; `simulacao-setembro` |
| Repasse de várias transações | `conciliacao-importada` 1 |
| Operação sem fonte suficiente | `conciliacao-importada` 3 |
| Rejeição de confirmação ambígua | `conciliacao-importada` 2 |
| Sessão: autorizado, negado, ausente, inválida | `sessao-cofre-local` 1–4 |
| FOR UPDATE e repetição | `postgres-trava-repeticao` 1–3 (mutantes conferidos) |

**Teste de mutação da Fase A**, feito com cópia de segurança e restaurado byte a byte:
- Sem `FOR UPDATE`: falham os testes 1 (reserva de linha) e 3 (impasse).
- Com uma única tentativa, sem repetição: falham os testes 2 (corrida pela mesma origem) e 3.

A lacuna registrada na 01B foi fechada.

**Limitações:**
1. **Nenhum leitor foi conferido com amostra real.** Os 9 adaptadores estão marcados como `SINTETICA`. Um arquivo real com colunas diferentes é rejeitado como "formato não reconhecido", o que é o comportamento correto, mas significa que nenhum importador pode ser declarado concluído para uso real.
2. XLSX, PDF e OFX não são lidos.
3. Em memória, as transações são serializadas, então a concorrência só é comprovada no modo PostgreSQL.
4. As concessões de acesso existem só como porta e simulação em memória. A tabela real de concessões, e a decisão de quem concede, ficam pendentes.
5. A conferência de estabelecimento depende de um cadastro de códigos por unidade, que ainda não existe. Sem ele, vira pendência.
6. A análise de compatibilidade com arquivos reais **não foi feita** nesta execução.

## 11. Sessão e permissões

O adaptador (`aplicacao/sessao.js`) recebe `{ user, tenant, acesso }`, que é exatamente o que o middleware de autenticação atual já monta no servidor. A organização vem **só** da sessão. A unidade precisa estar entre as **concedidas** e coincidir com a unidade da sessão, quando a sessão estiver presa a uma.

As ações `financeiro_v2.*` vêm **só** de concessões explícitas, inclusive a nova `financeiro_v2.importar`. Papel, superadmin, permissões do sistema atual e módulos **não** concedem nada.

São recusadas sessões:
- ausentes, inválidas ou expiradas;
- de conta inativa;
- em impersonação (padrão).

Nenhuma rota foi criada: o teste estático continua garantindo que o módulo não é importado pelo restante do backend.
