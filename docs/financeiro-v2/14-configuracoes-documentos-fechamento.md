# Financeiro v2 — 14. Configurações, permissões, cofre documental e fechamento mensal (Execução 06D)

Data: 13/11/2026. Branch local `feat/financeiro-v2-configuracoes-fechamento`, derivada de `74e5e37` (06C).

> Público: só dados sintéticos. Nada foi publicado; nenhuma rota do aplicativo foi criada; produção não foi acessada.

## 1. Diagnóstico (Fase A) — lacunas que comprometiam a integridade

| # | Lacuna | Onde | Correção |
|---|---|---|---|
| L1 | Decidir uma conciliação (confirmar, rejeitar, divergir, aguardar documento) não conferia o estado da competência; confirmar ainda alterava a movimentação sem trava | `aplicacao/conciliacao.js` | Guarda de competências na mesma transação (§ 2) |
| L2 | Criar candidata de conciliação (manual e automática) também não conferia | `conciliacao.js`, `importacoes.js`, `formacao.js` | Mesma guarda; geradores automáticos não criam candidata em competência homologada e informam quantas deixaram de criar |
| L3 | Liquidar ou estornar liquidação conferia só a competência da movimentação, não a do título alterado | `aplicacao/caixa.js` | Título passa a ser "competência referenciada" (§ 2) |
| L4 | No banco, só lançamento e movimentação eram protegidos; correspondência, títulos, ajuste, venda e liquidação não. E o gatilho não tomava a trava da competência | migração 0001 | Migração 0009 (§ 9) |
| L5 | Não havia retrato da versão homologada: a DRE era sempre recalculada, e um recebimento posterior podia mudar a apuração de um mês homologado sem rastro | apuração | Versões de fechamento imutáveis (§ 7) |
| L6 | Divergência de conciliação registrada não bloqueava a homologação; operações importadas pendentes, importação em validação e classificação provisória também não | `dominio/conferencias.js` | Novos impedimentos (§ 7) |
| L7 | O núcleo confiava nas permissões do contexto: um contexto montado antes de uma revogação continuava operando | `aplicacao/base.js` | Revalidação contra a concessão gravada (§ 4) |
| L8 | A demonstração usava permissões fixas em memória, e a revogação não tinha efeito | `scripts/fv2/demoInterface.mjs` | Concessões gravadas, lidas a cada requisição |

## 2. Conciliação × competência homologada (Fase B)

**Competências envolvidas** (cada registro tem a sua):

| Registro | Competência |
|---|---|
| Venda e despesa | Competência econômica |
| Movimentação | Data efetiva (o período do movimento bancário) |
| Título | Competência do fato |

A **competência da conciliação** é a mais recente entre os registros vinculados: o vínculo "acontece" quando o último fato existe. Ela é gravada na correspondência (`competenciaDaConciliacao`).

**Política de atualizações posteriores ao fechamento** (`base.exigirCompetenciasDoVinculo`):

| Situação | Regra |
|---|---|
| Competência **gravada**: a da conciliação ou a de um registro que a decisão altera (ex.: movimentação conciliada) | Precisa aceitar escrita. Homologada é recusada (`COMPETENCIA_HOMOLOGADA`) |
| Competência **referenciada**: registro só citado (venda de setembro conciliada com crédito de outubro; título de setembro liquidado em outubro) | Se homologada, a operação segue **somente** se não muda o resultado econômico dela. Grava a marca `ATUALIZACAO_POSTERIOR_AO_FECHAMENTO` no histórico da competência, com o motivo. A versão homologada não muda |
| Mudança econômica em registro de competência homologada (ajuste, reclassificação, cancelamento, título novo) | Recusada no núcleo e no banco |

**Exemplo sintético testado.** Venda de setembro, setembro homologado, crédito em outubro:

1. A liquidação e a conciliação em outubro são aceitas.
2. A correspondência registra `posteriorAoFechamento: ["2026-09"]`.
3. A DRE de setembro não muda e a versão homologada continua reproduzível.
4. Um ajuste de taxa no título de setembro é recusado.

**Concorrência.** Todas as travas são compartilhadas, tomadas **em ordem**, dentro da **mesma transação** que grava. A homologação toma a trava exclusiva da competência, no núcleo e também no banco (gatilho da 0009). A transação de escrita usa READ COMMITTED: depois de obter a trava, a leitura do estado enxerga uma homologação já confirmada.

Resultado: uma decisão iniciada antes **espera** a homologação e depois é recusada; nunca a contorna. Isso foi testado de forma determinística no PostgreSQL, segurando a trava, e com execução simultânea na memória.

## 3. Configurações (Fase C)

Organização e unidade vêm sempre da sessão.

| Seção | O que existe | Regras |
|---|---|---|
| Organização e unidade | Nome de exibição, identificação da empresa, situação, contas vinculadas e canais ativos | Exige `configurar`; justificativa; histórico |
| Plano de contas | Árvore, natureza por classificação, histórico e uso de cada categoria | Categoria **nunca é excluída**. Inativar mantém o histórico apurável e recusa lançamento novo. Categoria do sistema não é inativada |
| Canais e processadores | Cadastro da unidade apontando para um **código base** do motor (canal ou processador) | Canal ≠ forma de pagamento ≠ processador (ex.: "STONE" como canal é recusado). **Sem campo de taxa contratual**: taxa desconhecida não é presumida |
| Contas financeiras | Renomear, ativar ou desativar | Renomear exige `configurar`. Ativar ou desativar exige também `conciliar`, justificativa e nenhuma sessão de caixa aberta |
| Competências e metodologia | Catálogo versionado (`dominio/metodologias.js`): versão, vigência, publicação e critérios de fechamento | Versão nova não recalcula homologadas; homologar com metodologia diferente da implementada é recusado |

## 4. Permissões e responsáveis (Fase D)

**Concessão** (`fv2_concessao`, uma por usuário e unidade). Registra: usuário, organização, unidade, ações, quem concedeu, justificativa, data, situação e histórico completo (antes/depois). Proibido, e testado:

- autoconcessão e autorrevogação;
- conceder ação que o concedente não possui (escalada);
- papel antigo, superadministrador ou permissão do sistema anterior concederem algo;
- organização ou unidade vindas do cliente: a unidade sempre é validada contra as concessões.

**Revogação vale na próxima ação.** Com `exigirConcessaoPersistida` (ligado na demonstração), cada operação confere a permissão contra a **concessão gravada**, dentro da mesma transação. Um contexto montado antes da revogação deixa de operar na hora. Isso foi testado no núcleo e pela interface, com o mesmo token e a mesma sessão.

**Nova ação `financeiro_v2.documentos`.** Abrir, baixar e conferir arquivos do cofre exige essa ação; a ficha continua visível com `ver`. A lista fechada de ações no banco foi atualizada.

**Responsáveis por pendência** (`fv2_atribuicao_pendencia`):

- **Quem pode ser responsável:** só um usuário com concessão **ativa** na unidade; nunca nome livre nem responsável fictício.
- **Atribuir e reatribuir:** exigem `revisar`; reatribuir exige justificativa.
- **Acompanhamento:** situação (em análise, aguardando terceiro, concluída, sendo que concluir exige comentário), data de revisão e comentários.
- **Histórico:** antes/depois de cada atribuição.
- **Atribuir não resolve:** a pendência continua aberta enquanto a causa existir.

## 5. Provisionamento do administrador inicial

**Procedimento** (`provisionarAdministradorInicial`):

1. **Autoridade externa.** Uma autoridade **previamente autenticada e comprovadamente autorizada** (porta `autoridadeDeProvisionamento.verificar`) atesta o ato: organização, unidade, usuário, ações explícitas, justificativa e evidência.
2. **Escopo antes da autoridade.** O núcleo confere primeiro se o escopo está entre os autorizados; só então consulta a autoridade (falha fechada).
3. **Recusas** (`PROVISIONAMENTO_RECUSADO`):
   - não há autoridade configurada (nenhum acesso é concedido);
   - o atestado não confere;
   - a autoridade tenta provisionar a si mesma;
   - a unidade **já tem** quem possa conceder (a partir daí, só a concessão normal).
4. **Registro.** A concessão nasce com `concedidoPor` = autoridade e a justificativa e a evidência ficam no histórico.

**Não existem:** administrador universal, credencial padrão, conta oculta, nem acesso por identificador enviado pelo cliente.

**Bloqueio no ambiente isolado.** Não há autoridade real disponível. O procedimento está implementado e testado com uma autoridade **de teste** (HMAC com chave aleatória). A demonstração usa uma autoridade **sintética**, só para a organização fictícia e com chave aleatória do processo. Em produção, a autoridade precisa ser definida (ex.: rotina operacional assinada por quem administra a plataforma) **antes** de qualquer uso real.

## 6. Cofre documental e acesso seguro (Fase E)

**Consultas e operações:**

| Operação | Permissão | Comportamento |
|---|---|---|
| `consultarDocumentos` | `ver` | Fichas por unidade: tipo, origem, competência, versão, se está vigente, se o arquivo está no cofre deste ambiente, e se quem pergunta pode abrir |
| `detalharDocumento` | `ver` | Cadeia de versões, vínculos e histórico de decisões e acessos |
| `verificarIntegridadeDoDocumento` | `documentos` | Recalcula o SHA-256 e compara com a ficha; o resultado vai para o histórico |
| `obterArquivoDoDocumento` | `documentos` | Visualizar ou baixar |

**Segurança:**

- **Identificação:** o cliente envia só o **identificador opaco da ficha**. O arquivo é localizado pela ficha, no escopo da sessão; não há caminho, nome ou id do cofre vindo do cliente. A tentativa de *path traversal* é recusada na validação, e o cofre em disco não resolve caminhos fora da pasta (testado).
- **Isolamento:** a ficha de outra unidade ou organização "não existe" (`NAO_ENCONTRADO`), e a tentativa fica no registro de acessos negados (só metadados).
- **Integridade dupla:** o cofre confere o próprio hash e o núcleo recalcula o SHA-256 contra a ficha. Arquivo adulterado: `DOCUMENTO_ADULTERADO`, com acesso bloqueado.
- **Visualização em linha:** só para **PDF sem conteúdo ativo** (sem `JavaScript`, `OpenAction`, `AA`, `Launch`, arquivos embutidos, mídia, formulários remotos, XFA). Os demais são entregues **só como anexo**, com tipo neutro (`application/octet-stream`).
- **Cabeçalhos do arquivo:** `Content-Security-Policy: sandbox; default-src 'none'`, `nosniff`, `no-store`, `Cross-Origin-Resource-Policy: same-origin`, `no-referrer` e nome neutro (`documento-vN.ext`).
- **Limites:** 25 MiB e tipos suportados (PDF, CSV, TXT, XLSX, OFX).
- **Revalidação:** permissão e escopo são conferidos **a cada pedido**. Não há link público: a tela busca o arquivo com a sessão e o mostra a partir de um `blob:` local, que é revogado em seguida.
- **Logs:** nenhum conteúdo vai para log ou histórico, só a finalidade e o resultado.
- **Sem cofre:** sem cofre configurado, ou com uma ficha cujo arquivo não está neste ambiente, aparecem só os metadados. Não há link falso.

**Interface:** a página de demonstração permite `frame-src blob:` e `object-src blob:`. Um documento `blob:` herda a política da página, e o visualizador de PDF do navegador precisa de `object-src` para o próprio `blob`. Só esse `blob`, criado pela página a partir de uma resposta autorizada, é aceito.

### Política de retenção proposta (configuração a validar)

Ainda **não está em uso**: precisa de validação jurídica e contábil antes de qualquer uso real.

| Classe | Exemplos | Proposta |
|---|---|---|
| Fiscais e contábeis | Notas, extratos, relatórios de vendas | Prazo legal aplicável (a definir pelo contador), contado do fim do exercício |
| Comprovantes operacionais | Comprovantes, boletos, demonstrativos | O mesmo prazo da classe fiscal enquanto ligados a registro financeiro |
| Versões substituídas | Versões anteriores | Mantidas pelo mesmo prazo da versão vigente (prova da substituição) |
| Registros de acesso | Metadados de acesso | Prazo a definir (segurança × privacidade) |

**Regras:**

- **Nada de exclusão automática.** O contrato do cofre não tem como apagar; descarte, se um dia existir, será decisão explícita, auditada e versionada.
- **Backup e restauração:** cópia do cofre e do banco na mesma janela; conferência de integridade por hash após restaurar; teste periódico de restauração.
- **Proteção:** pasta privada fora do Git e do OneDrive, permissão restrita, criptografia em repouso no destino real, chaves separadas dos dados.
- **Recuperação:** procedimento documentado de reconstrução das fichas a partir do cofre e vice-versa (hash como elo).

## 7. Fechamento mensal (Fase F)

**Estados:** aberta → preliminar → com pendências documentadas → homologada. Toda passagem por um estado de fechamento grava uma **versão imutável** (`fv2_versao_fechamento`, somente inserção), com:

- número, tipo e revisão;
- metodologia aplicada (texto da decisão e identificador versionado `nome@versão`);
- **impressão** (SHA-256 das entradas da apuração, independente do estado e da hora);
- retrato dos indicadores e das linhas da DRE;
- pendências documentadas e verificações;
- quem decidiu, quando e a justificativa.

| Estado | Exigências |
|---|---|
| **Preliminar** | Permissão `fechar`. Preserva indicadores e metodologia; ajustes autorizados continuam |
| **Com pendências documentadas** | `fechar` + lista estruturada (descrição e **impacto** obrigatórios; responsável real, evidências, documentação faltante e decisão quando houver). Texto solto é recusado. Documentar não resolve |
| **Homologada** | `homologar` + **confirmação explícita** + metodologia; o responsável é o usuário da sessão. O núcleo confere: metodologia vigente igual à implementada, apuração reproduzível (impressão gravada) e **impedimentos** (abaixo) |
| **Reabertura** | `revisar` + justificativa + confirmação (vinda de homologada). Registra a versão homologada anterior (`versaoHomologadaAnteriorId`). A versão antiga fica intacta; a próxima homologação gera outra |

**Impedimentos de homologação** (sem tolerância; todos testados):

- divergência entre relatórios sem explicação;
- saldo informado que não confere;
- receita em duplicidade (agregado × pedidos);
- divergência de **conciliação** sem resolução comprovada por documento (`resolverDivergenciaDeConciliacao` exige justificativa **e** evidência; a diferença continua registrada);
- **classificação provisória** que entra no resultado (descontos sem financiador comprovado);
- **operações importadas** ainda não aplicadas nem rejeitadas;
- **importação** do período ainda em validação.

Recebíveis válidos ainda não pagos **não** bloqueiam.

**Materialidade.** Não há política aprovada: nenhum limite em reais ou percentual e nenhuma "aprovação genérica". A estrutura `POLITICA_DE_MATERIALIDADE` (`aprovada: false`) está pronta para receber uma política versionada no futuro, avaliada por natureza, evidência e autorização.

**Idempotência.** Pedir o estado em que a competência já está não grava nada (`repetido: true`), sem nova versão nem histórico.

**DRE e Visão Geral da homologada:**

- a apuração traz a `versaoHomologada` (número, data, metodologia, impressão e se **reproduz** a atual);
- a DRE mostra a versão; se a atual não reproduzir, a tela exibe os **valores da versão homologada** e avisa que a diferença exige revisão formal;
- a Visão Geral mostra a situação da competência.

## 8. Experiência (Fases G, H e I)

- **Central → Fechamento mensal:** uma ação por transição possível, cada uma com a **prévia do núcleo** (`previaDaMudancaDeEstado`): estado atual e proposto, o que passa a valer, permissão exigida (e se você a tem), justificativa, confirmação, impedimentos e motivos.
  - O botão fica **desabilitado** quando o núcleo não permite, com o motivo ligado por `aria-describedby`.
  - A gravação passa pela demonstração com sessão, **CSRF**, confirmação, transação e auditoria.
  - O formulário de "com pendências" monta a documentação a partir das pendências reais da Central.
- **Versões do fechamento** listadas, com a vigente marcada.
- **Pendência:** responsável, revisão e comentários, com histórico da atribuição.
- **Configurações:** seis seções, com formulários só para quem tem a permissão. O plano de contas tem um painel de histórico e uso por categoria.
- **Documentos:** lista, ficha, versões, histórico de acessos, visualizar (PDF limpo), baixar e verificar integridade.
- **Integração com as demais telas:**
  - DRE com a versão homologada;
  - Visão Geral com a situação da competência;
  - escritas econômicas ordinárias recusadas na competência homologada (núcleo e banco);
  - permissão revogada some da sessão seguinte e é recusada já na ação seguinte.
- **Sessão expirada:** 401 com mensagem própria, antes de qualquer outra conferência.
- **Troca de unidade:** limpa pessoas, configurações e filtros; só a última resposta é aplicada.
- **Celular (375 px):** sem rolagem horizontal em nenhuma das telas novas; ações de fechamento em grade adaptável.
- **Teclado:** abas por botão com foco preservado; Esc fecha o painel e devolve o foco.

## 9. Persistência (migração 0009, só no banco local isolado)

- **Trava no banco:** `fv2_trava_da_competencia` (mesma chave do núcleo). Os gatilhos de competência homologada tomam a trava **compartilhada**; homologar toma a **exclusiva**.
- **Proteção nova:** `fv2_bloquear_homologada` passou a cobrir ajuste, liquidação e correspondência (pela competência da conciliação). `fv2_posicao_em_homologada` cobre títulos e venda, liberando só a posição financeira: pago, saldo e devolvido; situação do título apenas entre aberta, parcial e quitada, nunca cancelamento.
- **Tabelas novas** (RLS por escopo, sem exclusão, histórico obrigatório, versionamento): `fv2_versao_fechamento` (imutável: FV015; versão homologada só com a competência homologada na mesma transação), `fv2_atribuicao_pendencia`, `fv2_canal_processador` e `fv2_configuracao_unidade`.
- **Concessão:** lista fechada de ações com `financeiro_v2.documentos`.

## 10. Testes

| Suíte | Cobre |
|---|---|
| `backend/test/financeiro-v2/configuracoes-fechamento.test.js` (memória e PostgreSQL, 13 testes) | Itens 1–30, 32–36 e 41–42 do núcleo |
| `backend/test/financeiro-v2/postgres-fechamento.test.js` (3 testes) | Concorrência determinística conciliação × homologação; SQL "à mão" recusado (vínculo, título, venda, versão); concessão com a ação nova |
| `frontend/test/financeiroV2Administracao.test.js` (8 testes) | Itens 31–41 pela demonstração: CSRF e confirmação, repetição, prévia e botão desabilitado, pendências documentadas, reabertura, DRE/VG da homologada, configurações e permissões, revogação, responsável, documentos, sessão expirada, troca de unidade, responsivo e teclado |

**Ajustes nos testes anteriores (contrato novo, sem afrouxar nada):**

- `confirmar: true` nas homologações;
- pendências como objetos com descrição e impacto;
- seis testes que homologavam com propostas importadas pendentes, importação em validação ou desconto a classificar passaram a **decidir** essas pendências antes, ou a afirmar o novo bloqueio;
- repetir o estado atual deixou de ser erro (item 32).

**Mutação** (cópia de segurança e restauração conferida por hash): seis mutantes, todos **mortos** em memória:

1. guarda da conciliação removida;
2. concessão gravada não conferida;
3. escopo do repositório removido (acesso entre unidades);
4. reabertura sem justificativa;
5. divergência de conciliação não bloqueia;
6. homologação sem confirmação.

No PostgreSQL, o mutante 1 **sobrevive ao núcleo** porque o gatilho da 0009 recusa sozinho: é a defesa em camadas, comprovada.

## 11. Limitações e pendências

- **Integração real:** sessão, CSRF da plataforma, provisionamento por autoridade real e rotas publicadas continuam bloqueados (docs 10 a 13). A demonstração é local, com sessão simulada e autoridade sintética.
- **Retenção:** proposta, não aplicada; depende de validação jurídica e contábil.
- **Materialidade:** sem política aprovada, toda divergência que pode alterar o resultado continua bloqueante.
- **Nomes nas telas:** pessoas aparecem pelo nome sintético da demonstração. Na integração, o nome virá do cadastro de usuários da plataforma (fora do módulo).
- **Visualização de PDF:** depende do visualizador do navegador. Sem ele, só o download (anexo) está disponível.
