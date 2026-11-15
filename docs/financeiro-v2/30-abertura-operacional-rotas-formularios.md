# 30 — Abertura operacional: rotas, formulários e contrato da interface

Esta etapa completa o que faltava para a abertura financeira do Açaí no Grau Saci (doc 29, pré-condições P1 e P2).
Tudo é local, na branch `feat/financeiro-v2-abertura-operacional`. A escrita continua desligada em produção
(`FV2_ESCRITA_HABILITADA=0`): enquanto isso, as rotas novas respondem `403 ESCRITA_DESLIGADA`.

## 1. Rotas novas

Todas ficam sob `POST /api/v1/financeiro-v2/acoes/…`. Elas seguem a mesma regra das demais escritas:

- só aceitam JSON e recusam campos fora da lista;
- a unidade vem sempre da sessão;
- passam pelo gateway (identidade individual, concessão, RLS);
- gravam o histórico na mesma transação.

| Caminho | Operação do núcleo | Campos | Proteções |
|---|---|---|---|
| `/configuracoes/conta/criar` | `configurarContaFinanceira` | tipo, nome, instituicao | Não tem campo de saldo. Usa trava por unidade. O mesmo nome (sem diferença de maiúsculas, acentos ou espaços) devolve a conta existente; com outro tipo ou instituição, responde 409. |
| `/abertura/saldo` | `registrarSaldoDeConta` | conta, competencia, valor, origem | Grava na véspera da competência, com `FIM_DO_DIA`. A origem é obrigatória (5 a 160 caracteres) e fica gravada como referência externa: "sem anexo verificado no sistema". É idempotente por conta e dia; um valor diferente para o mesmo dia responde 409. |
| `/abertura/obrigacao-anterior` | `registrarObrigacao` | fornecedor ou fornecedorNovo, descricao, valor, competencia, dataEmissao, vencimento, origem, chave | Usa a categoria patrimonial do sistema. A emissão tem de ser anterior ao 1º dia da competência. Não aceita parcela nem recorrência. O fornecedor é gravado na mesma transação e reaproveitado pelo nome. A chave torna o reenvio idempotente. |
| `/abertura/recebivel-anterior` | `registrarRecebivel` | processador, cliente ou clienteNovo, descricao, valor, competencia, dataOrigem, vencimento, origem, chave | Marca o título com `anteriorAAbertura`. Não aceita retenções nem venda. A data de origem tem de ser anterior ao início. Não gera nenhum lançamento. |
| `/recebiveis/registrar` | `registrarRecebivel` | cliente ou clienteNovo, descricao, valor, competencia, vencimento, chave | Processador é recusado: o repasse nasce da venda e do demonstrativo, e registrá-lo à mão duplicaria. |
| `/caixa/abrir` | `abrirCaixa` | conta, data, contado, observacao | Só para caixa físico ativo. Uma sessão aberta por vez. O valor contado não é faturamento. |
| `/caixa/operacao` | `registrarOperacaoDeCaixa` | sessao, operacao, valor, data, descricao, contraConta, chave | Usa trava por caixa. A mesma chave devolve a operação já gravada; com outro conteúdo, responde 409. Sangria com conta de destino vira transferência interna. |
| `/caixa/fechar` | `fecharCaixa` | sessao, data, contado, justificativa | Compara o teórico com o contado. Diferença exige justificativa e não gera ajuste automático. |
| `/configuracoes/implantar-plano` | `implantarPlanoDeContas` | modelo, modeloConfirmado | O nome do modelo tem de ser redigitado, e o servidor confere: sem ele, responde 400 `FV2_CONFIRMACAO_EXIGIDA`. A operação é idempotente. |
| `/conciliacoes/gerar` | `gerarCandidatasDeConciliacao` | competencia | A tela já chamava esta ação, mas faltava a rota. Ela só sugere candidatas; nenhuma é confirmada sozinha. |

`/obrigacoes/registrar` mantém as correções do commit 2a54140: fornecedor e conta na mesma transação, e chave do
formulário. Agora o fornecedor digitado também reaproveita o cadastro existente com o mesmo nome.

## 2. Abertura patrimonial (opção B) — validação contábil e gerencial

- **Obrigação anterior.** Usa a categoria `TITULOS_ANTERIORES_A_ABERTURA` ("Saldos patrimoniais de abertura — títulos
  anteriores"), que fica em `MOVIMENTACOES_PATRIMONIAIS` com natureza `PATRIMONIAL` e é do sistema (não pode ser
  inativada). Ela representa o passivo inicial: a despesa original pertence a um período que o v2 não apura.
  - Não entra em nenhuma linha da DRE. Aparece em `dre.foraDoResultado.patrimoniais`.
  - O pagamento posterior é liquidação do título: não cria despesa.
- **Recebível anterior.** Recebível nunca gera receita (a receita nasce da venda), por isso não precisa de categoria. É
  marcado `anteriorAAbertura` com `dataOrigem`. Sem retenções, porque as taxas pertencem ao período anterior e não são
  presumidas. O recebimento posterior também é liquidação.
- **Conservado:** vencimento, identificação do documento, conciliação com o extrato, pagamentos e recebimentos
  posteriores, e o histórico com a pessoa individual.
- **Correção na apuração.** Antes, uma competência que tivesse só lançamentos patrimoniais passava a mostrar faturamento
  e resultado R$ 0,00 como se fossem confirmados. Agora ela continua "sem registros": só lançamentos que podem entrar no
  resultado tornam a DRE conhecida.
- **Por que não uma categoria de despesa ou receita "de abertura".** Ela colocaria na DRE do mês de início valores de
  outro período, criando despesa e faturamento falsos. Também não se usa "a classificar", que é para natureza ainda não
  comprovada; aqui a natureza é conhecida: é posição inicial.
- **Risco de duplicidade.** Não importe as vendas de antes da competência de início. Se forem importadas, os recebíveis
  dessas vendas se somariam aos recebíveis anteriores. A tela avisa disso, mas o sistema ainda não bloqueia (§ 5).

## 3. Formulários novos (interface)

- **Configurações → Abertura financeira** (`telasAbertura.js`, arquivo novo):
  - roteiro de 7 passos;
  - documentos a reunir;
  - explicação da opção B;
  - formulários de implantar o plano (com o modelo redigitado), cadastrar conta, saldo de abertura, contas a pagar
    anteriores e valores a receber anteriores.
- **Caixa e Bancos:** abrir caixa, registrar operação e fechar caixa, mostrados conforme houver sessão aberta.
- **Contas a Receber:** registrar um valor a receber de cliente.
- **Regras de todos os formulários:**
  - nenhum valor vem preenchido;
  - a competência proposta (11/2026) vem no campo e pode ser editada;
  - quem não tem a permissão vê só o roteiro.

## 4. Contrato para o agente visual (identidade "Crescer Com Delivery Financeiro")

O trabalho visual está em `C:\dev\fv2-visual` (branch `feat/financeiro-v2-visual`), ainda sem commit. Para não sobrepor
esse trabalho, esta etapa não alterou `fv2.css`, `index.html`, `telas.js`, `plataforma.js` nem `ativacao.*`. As
mudanças em arquivos que o visual também tocou são poucas e localizadas:

- `telasAdministracao.js`:
  - um `import`;
  - a entrada `["abertura", "Abertura financeira"]` em `SECOES_CONFIG`;
  - `abertura` no mapa das seções.
- `app.js`: duas linhas:
  - `permissoes` no contexto de Configurações;
  - o contexto passado para `contasAReceber`.

O contrato que o visual deve preservar ao redesenhar:

- Cada ação é um `<form class="acao" data-acao="/api/fv2/acoes/<caminho>">` com a caixa `name="confirmar"`. Os nomes
  dos campos são exatamente os da tabela do § 1. O teste `financeiroV2Abertura.test.js` confere cada campo contra a
  lista do servidor.
- O campo oculto `chave` deve ser gerado a cada desenho (com `crypto.randomUUID()`) e não pode ser reaproveitado entre
  formulários.
- As classes usadas são as que já existem: `card`, `acao`, `caixa-marcar`, `botao botao--primario`, `nota`, `aviso`,
  `selo selo--ok/alerta/neutro`, `lista-simples` e `mini`. Há uma classe nova sem estilo próprio, `roteiro-abertura`.
- Os textos de explicação são de regra, não de estilo:
  - "não é faturamento";
  - "fora da DRE";
  - "sem anexo verificado";
  - "o mesmo nome reaproveita o cadastro".

**Integração.** Quando o visual for commitado, basta fazer rebase ou merge desta branch: os pontos de contato listados
acima são linhas isoladas. Para não substituir sem querer a versão visual mais recente, publique o visual primeiro, ou
os dois juntos.

## 5. Limites conhecidos

- Não existe uma "data de abertura" registrada no sistema: a competência de início é informada em cada formulário. O
  bloqueio de importar vendas anteriores ao início ainda não existe; a importação é decisão do operador.
- O cofre de documentos continua desligado: os documentos ficam só como referência em texto.
- Recebíveis do período com taxas conhecidas continuam entrando pelos demonstrativos e importações, não pelo formulário
  manual.
