# MOVA CORE — F2 (memória, identidade, ferramentas) e desenho da F4

Estado: **código e testes na branch `feat/mova-core-f2`; nada publicado; nenhuma migration aplicada; escritas desligadas.**

## 1. Memória em camadas (`memoria.js`)

| Camada | O que guarda | Validade | Nunca guarda |
|---|---|---|---|
| Fio da conversa | turnos (pergunta + resposta), assuntos, entidades, decisões, fatos do turno | 24 h sem conversa | — |
| Assuntos | temas (pela ferramenta usada), entidades, perguntas, resumo **sem valores** | enquanto o fio vive | valores em R$ |
| Entidades | nome completo, tipo (fornecedor, entregador, canal…), unidade, assunto | enquanto o fio vive | identificador interno |
| Fatos com valor | os fatos estruturados das ferramentas | **10 min** (depois o verificador exige nova consulta) | — |
| Decisões | esclarecimentos que a pessoa já deu ("o Matheus Rocha") | enquanto o fio vive | — |
| Pendências | as pendências abertas desta pessoa (comprovantes etc.) | relidas a cada pergunta | valores |
| Arquivo | resumo de fios vencidos (temas e entidades) | — | valores, turnos |
| Base aprovada | conhecimento revisado (porta `conhecimento.buscar`) | — | — |

Chave da memória: `organização | conversa | participante`. Privado e grupo **nunca** compartilham memória, e organizações também não (MEM-03).
A recuperação é seletiva. O histórico enviado ao modelo é só o do assunto da pergunta (MEM-01), e o bloco de contexto diz:

- assunto atual;
- assunto retomado ("voltando ao Matheus");
- alvo provável de "ele/isso";
- **ambiguidade** quando há duas entidades com o mesmo primeiro nome (MEM-02: dois Matheus → perguntar qual);
- outros assuntos;
- decisões já tomadas;
- pendências;
- arquivo, só com palavra explícita de retomada.

O bloco é marcado como "NÃO é fonte de valores".
As referências opacas (`ref_N`) são persistidas com o fio e morrem com ele. Uma referência de outra unidade continua recusada (MEM-07).

## 2. Identidade e permissões (`identidade.js`)

- **Como o vínculo nasce:**
  - por **código autenticado**: a pessoa logada na plataforma gera um código de 6 dígitos e envia `vincular 123456` no **privado** com o MOVA;
  - ou por **aprovação de administrador** com `usuarios.gerenciar` da mesma organização.

  Nada de nome, telefone digitado no texto ou "reconhecimento".
- **Chave canônica** da pessoa no WhatsApp: a da entrada da lista de participantes (`pessoaId` ou hash dos JIDs). O LID e o número da mesma pessoa caem na mesma chave.
- **Recusas:**
  - código no grupo;
  - código errado, expirado ou reutilizado;
  - 5 tentativas por hora;
  - número fora da lista;
  - código de outra organização;
  - perfil de exibição (TV);
  - sessão de impersonação;
  - administrador sem permissão, de outra organização ou impersonando.
- **O servidor é a autoridade.** Papel, permissões e módulos são relidos da plataforma a cada requisição (`resolver`, sem cache). Perfil desativado ou vínculo revogado vale na mensagem seguinte (ID-05) e no meio de uma conversa (AC-02).
- `vincular NNNNNN` é uma rota própria do roteador: o código **nunca vai ao modelo** e nunca é registrado na auditoria (ID-01).
- Esquema persistente: `docs/mova-core/rascunhos/mova-core-identidade-memoria.sql`, um **rascunho não aplicado** (fora do pacote de produção; número só na hora de aplicar). Tem um vínculo ativo por pessoa e por perfil, o código guardado como hash com sal, revogação como registro e acesso restrito ao papel de operação.

## 3. Ferramentas adicionadas

**Agente Crescer (`PERMISSOES_DO_AGENTE_CRESCER`)**

São 12 ferramentas de leitura, cada uma com o módulo e a permissão da plataforma:

- dashboard executivo, dia, evolução diária, diagnóstico (`ifood_dashboard`, `dashboard_executivo.ver`);
- produtos/CMV (`products_cmv`, `cmv.ver`);
- insumos (`ingredients`, `insumos.ver`);
- cancelamentos e resumo do parser (`parser_food_delivery`, `parser_food_delivery.ver`);
- checklists (`checklist_operacional`, `checklist.visualizar`).

`sugerir_navegacao` fica fora do WhatsApp.

Só são oferecidas as que o acesso **da pessoa vinculada** alcança. A checagem se repete em cada execução, com o acesso relido.

**`analisar` (análise genérica parametrizada)**

O modelo escolhe:

- a métrica (despesas, pagamentos, em aberto, vendas brutas/líquidas, quantidade de vendas, entregas, custo de entregadores);
- o agrupamento (fornecedor, categoria, canal, entregador, unidade);
- de 1 a 6 competências, a ordem (maior, menor, maior crescimento, maior queda), o filtro e o limite.

O **código** busca pelas mesmas leituras oficiais, agrupa, ordena e calcula a diferença e a variação. Não existe SQL nem acesso livre: o esquema é estrito (AN-02) e há um teto de 30 leituras por análise. Cada unidade extra tem a concessão `financeiro_v2.ver` **relida agora**; sem ela, a unidade fica de fora e é informada.

**Evidência estruturada em todo fato**

Cada fato traz:

- `fonte {ferramenta, operacoes}`, `consultadoEm` e `evidenciaId`;
- `natureza`: PAGAMENTO, OBRIGACAO, RECEBIVEL, RECEBIMENTO, FATURAMENTO, RESULTADO, SALDO, FLUXO_DE_CAIXA, MOVIMENTO_DE_CAIXA, CALCULO;
- entidade, unidade, período, indicador e estado.

**Resposta parcial segura (`aproveitarFatosValidos`)**

Quando o rascunho é reprovado duas vezes, sai só o que confere, com o aviso "Retirei uma parte…". O que sobra precisa passar inteiro no verificador. Sem isso, a saída é a resposta segura fixa (FB-01).

**Verificador — novas naturezas**

- média/por entrega (só com DIVISÃO/MÉDIA calculada);
- movimento de caixa (sangria, reforço);
- "em aberto" genérico (pagar ou receber);
- termos entre aspas ou atrás de um parêntese que fecha outro valor;
- valor como operando de uma divisão.

**Modo sombra (`criarSombraIsolada`)**

- exige porta **somente leitura** (Proxy: qualquer operação fora das consultas do catálogo dá erro);
- exige orçamento marcado `ISOLADO`;
- `criarSombra` direto é recusado (SH-01).

## 4. Desenho da F4 (nada ligado; tudo atrás de chaves desligadas)

**Prioridade 1 — compra já paga (brownies)**

- **Fluxo:** comprovante + "compra nova, já paguei".
  1. A leitura extrai valor, data, favorecido e meio.
  2. O MOVA prepara: fornecedor (existente ou novo), categoria, competência e conta de saída.
  3. A pessoa confirma **na mesma conversa**, com a versão completa da operação: valor, categoria, fornecedor, beneficiário, unidade e natureza (o mesmo vínculo de confirmação do #203).
- **Gravação:** obrigação **e** liquidação numa só transação idempotente (`chaveIdempotencia` = hash do documento + pendência). Se o fornecedor for novo, entra na mesma transação (reaproveita o comando de 2a54140).
- **Barreiras:**
  - teto por operação (a política de R$ 1.000 do Açaí ainda precisa ser criada);
  - documento já usado → recusa;
  - fornecedor parecido → pergunta qual, nunca escolhe;
  - unidade fora da conversa → recusa.
- **Chave:** `MOVA_IA_RESPOSTAS_PENDENTES` + nova `MOVA_COMPRA_NOVA_PAGA`, ambas OFF. Base técnica: o rascunho do PR #206.

**Sangria com prestação de contas**

- A retirada vira movimento de caixa SANGRIA com finalidade e responsável, e abre uma **prestação de contas pendente** (vence em 48 h).
- O comprovante posterior liga a despesa à sangria: a despesa é registrada como paga **pelo caixa** e consome o saldo da sangria, sem duplicar a saída.
- Sobra devolvida → REFORCO vinculado. Sem prestação no prazo → aviso ao financeiro.

**Vínculo caixa ↔ despesa**

Liquidação com origem = movimento de caixa existente, conferindo:

- valor ≤ saldo não vinculado do movimento;
- mesma unidade;
- data compatível.

Uma despesa nunca é ligada a dois movimentos; a restrição é única no banco.

**Nova obrigação com liquidação atômica**

Generaliza a compra já paga para boletos e notas pagas na hora. É uma única operação do núcleo do Financeiro v2: nunca duas chamadas, nunca uma "meia gravação".

**Para todas as escritas da F4:**

- homologação isolada com o Financeiro v2 em memória;
- testes de concorrência, duplicidade, expiração e revogação;
- só depois, autorização específica por chave e por unidade.

## 5. Limites conhecidos (não resolvidos)

- **Busca por termo sem plural ou raiz:** "embalagem" não encontra "Atacadão Embalagens" (achado da suíte independente real). Não foi corrigido, por regra: corrigir pede um novo conjunto reservado para medir.
- **Pergunta "quanto entrou no caixa físico":** o modelo respondeu só com o reforço. Falta deixar claro que vendas em dinheiro entram por outra leitura.
- **Comprovante citado sem anexo:** o modelo pede para reenviar, o que está correto. O avaliador independente esperava PREPARAR.
