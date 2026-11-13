# Financeiro v2 — 15. Auditoria integrada (Execução 07)

Data: 13/11/2026. Branch local `feat/financeiro-v2-auditoria-integrada`, derivada de `bdb2d11` (06D).

> Público: só dados sintéticos. Nada foi publicado; produção não foi acessada; nenhuma permissão real foi alterada.

## 1. Escopo auditado

| Área | O que foi auditado |
|---|---|
| Núcleo | Contratos entre módulos: venda → pagamento → recebível → liquidação → conciliação → indicador; obrigação → liquidação; ajuste; competência |
| Banco | Migrações 0001 a 0010; gatilhos de competência homologada; RLS; privilégios do papel da aplicação |
| Telas | As sete áreas da demonstração no navegador (desktop e celular) |
| Segurança | Sessão, concessões, escopo, CSRF, cofre e caminhos de contorno pelo banco |
| Desempenho | Volume sintético de 1, 6 e 12 meses |
| Integração | Autenticação e navegação existentes (só leitura de código) |

**Linha de base em `bdb2d11`:**

| Suíte | Resultado |
|---|---|
| Financeiro v2, memória | 261/261 |
| Financeiro v2, PostgreSQL | 261/261 |
| Frontend | 1931 aprovados |
| Backend | 22 falhas e 1 cancelado, todas preexistentes |

## 2. Matriz de invariantes financeiras

| # | Invariante | Onde é garantida | Evidência |
|---|---|---|---|
| I1 | Cada venda gera **uma** receita; pagamento e recebimento nunca geram receita | Núcleo + conservação | Cenário integrado; `verificarConservacao` |
| I2 | Cada despesa é **um** lançamento; pagar ou antecipar não cria outra | Núcleo | Cenário integrado; 06A |
| I3 | Natureza vem da categoria (dedução, despesa, patrimonial) | Núcleo | Cenário integrado (principal do empréstimo fora do resultado) |
| I4 | Subtotais da DRE = soma das linhas; linha = soma das folhas | Motor | Cenário integrado (conferência independente) |
| I5 | DRE, Visão Geral e composição usam a mesma apuração | Aplicação | Cenário integrado (impressão igual) |
| I6 | Desconhecido nunca é zero; parcial nunca é definitivo | Motor | Fase F (`auditoria-cadeias`) |
| I7 | Competência homologada: nenhuma alteração econômica, no núcleo e no banco | Núcleo + gatilhos 0009/0010 | `auditoria-competencias`, `postgres-auditoria`, `postgres-fechamento` |
| I8 | Fato posterior (pagamento, recebimento, estorno, taxa descoberta depois) é efeito do mês do fato e deixa a marca **ATUALIZACAO_POSTERIOR_AO_FECHAMENTO** | Núcleo + 0010 | A1–A5 |
| I9 | Resultado **e composição** da versão homologada não mudam depois do fechamento | Retrato completo | A4, A7 |
| I10 | Saldo = saldo informado + movimentos; não depende da ordem de registro; desconhecido sem saldo informado | Tesouraria | Fase D |
| I11 | Transferência interna tem efeito líquido zero no consolidado | Tesouraria | Fase D |
| I12 | Projeção usa só o pendente (nada pago é contado de novo) | Tesouraria | Fase D; cenário integrado |
| I13 | Importação não cria efeito; proposta aplica uma vez (repetida ou concorrente); falha no meio não deixa efeito parcial | Formação | Fase E |
| I14 | Movimentação desconhecida não vira receita nem despesa | Motor | A8; cenário integrado |
| I15 | Permissão revogada vale na ação seguinte; sem autoconcessão nem escalada | Núcleo (06D) | 06D; interface |

## 3. Cenários executados

**Cenário integrado** (`auditoria-cenario-integrado.test.js`): um mês com Balcão, iFood, Anota AI, pagamento misto, desconto da loja, subsídio de terceiro comprovado, desconto sem financiador, taxa Stone, comissão, anúncios e mensalidade iFood, venda cancelada, estorno parcial, fornecedor pago em parte, entregador pago no mês seguinte, saída bancária sem classificação e empréstimo com principal e juros.

**Competências** (`auditoria-competencias.test.js`, A1–A8):

1. venda de setembro recebida em outubro;
2. despesa paga depois;
3. estorno e correção de pagamento depois do fechamento;
4. pagamento posterior via processadora;
5. taxa descoberta depois;
6. composição homologada × pagamento posterior;
7. saldo informado posterior;
8. homologação concorrente com liquidação;
9. segunda homologação após revisão;
10. entrada posterior não classificada.

**Cadeias** (`auditoria-cadeias.test.js`):

- **Importação:** repetida, concorrente, com duplicado no arquivo, versão corrigida, outra unidade, falha no meio, documento adulterado.
- **Tesouraria:** ordem de registro, retroativo, duplicado, transferência, projeção.
- **DRE:** prejuízo, zero, desconhecido, despesa sem receita, resultado financeiro assinado, dados parciais, resultado × saldo.

**Equivalência** (`auditoria-desempenho-equivalencia.test.js`): a apuração carregada só com o mês é idêntica à calculada sobre o histórico completo, em cinco competências.

**Banco** (`postgres-auditoria.test.js`): ajuste solto recusado; concorrência determinística entre liquidação e homologação.

## 4. Resultados esperados × observados (cenário integrado)

Valores em reais. Conta feita à mão, escrita no teste como constante.

| Item | Conta | Esperado | Observado |
|---|---|---|---|
| Faturamento bruto | 100 + 200 + 50 + 80 + 60 + 40 + 30 + 50 (cancelada fora) | 610,00 | 610,00 |
| Bruto por canal | Balcão / iFood / Anota AI | 320,00 / 240,00 / 50,00 | igual |
| Deduções | loja 6 + sem financiador 3 + devolução 10 | 19,00 | 19,00 |
| Receita líquida | 610 − 19 | 591,00 | 591,00 |
| Custos operacionais | insumos | 70,00 | 70,00 |
| Despesas operacionais | 24 + 10 + 5 + 1,50 + 12 | 52,50 | 52,50 |
| Resultado financeiro | juros | −8,00 | −8,00 |
| Resultado gerencial | 591 − 70 − 52,50 − 8 | 460,50 | 460,50 |
| Patrimonial (fora do resultado) | principal do empréstimo | 500,00 | 500,00 |
| Recebíveis em aberto | 161 + 30 + 10 + 50 + 48,50 | 299,50 | 299,50 |
| Obrigações em aberto (15/10) | 30 + 0 + 450 + 0 | 480,00 | 480,00 |
| Caixa físico (30/09) | 100 + 30 + 54 + 27 + 50 − 10 | 251,00 | 251,00 |
| Banco (30/09 e 15/10) | 1.000 + 500 − 40 − 2,50 − 58; depois − 12 | 1.399,50 / 1.387,50 | igual |

A soma das folhas de cada linha confere. Nenhum lançamento aparece em duas linhas. A distribuição de cada R$ 100 soma 100,00% sobre o bruto.

## 5. Problemas encontrados

| # | Gravidade | Achado | Reprodução |
|---|---|---|---|
| P1 | **Crítico** | Núcleo e banco discordavam em fatos posteriores ao fechamento. Estorno de pagamento com recebível, pagamento posterior via processadora e taxa reconhecida depois **passavam em memória sem marca de auditoria** e **eram recusados no PostgreSQL**. O núcleo não conferia a competência do título ou da venda alterados | A1, A2, A3 (falhavam nos dois modos) |
| P2 | **Crítico** | Pagamento posterior via processadora criava o recebível **na competência da venda**, mesmo homologada, sem conferência nenhuma no núcleo | A2 |
| P3 | **Alto** | A composição da versão homologada não era congelada: o retrato guardava só os totais, e a árvore apresentada vinha da apuração ao vivo. Pago e saldo de obrigações, e liquidado e saldo de repasses, mudavam depois do fechamento | A4 |
| P4 | **Médio** | A conferência de invariantes (`verificarConservacao`) acusava toda venda com desconto como violação (regra anterior à composição da 03B). Falso positivo que inutilizava a auditoria em meses com desconto | Cenário integrado |
| P5 | **Médio** | Saldo informado com data em mês homologado era aceito sem nenhuma marca no histórico da competência | A5 |
| P6 | **Médio** (desempenho) | A apuração de um mês lia o histórico **inteiro** de todas as competências: o tempo do mesmo mês crescia com os meses acumulados | Medição (§ 11) |
| P7 | **Alto** (risco, não corrigido) | Concessões podem ser gravadas direto no banco por quem tem a credencial da aplicação, sem as regras de escalada do núcleo | Revisão de contorno (§ 10) |
| P8 | **Médio** (risco, não corrigido) | O escopo do RLS vem de variável de sessão definida pelo cliente do banco: protege contra consulta sem filtro, não contra quem tem a credencial | Revisão (§ 10) |
| P9 | Baixo | Os índices por competência de venda, obrigação, recebível, ajuste e proposta não existem; com a correção P6, as consultas passam a usá-los | Leitura das migrações |

Achados de inspeção sem defeito:

- **Saldos em datas diferentes:** Caixa e Bancos mostra o fim do mês da competência e a Visão Geral mostra hoje; cada tela informa a sua data.
- **Duplicado no arquivo:** linhas idênticas são colapsadas e contadas, por definição da Execução 02.

## 6. Correções realizadas

| # | Correção | Arquivos |
|---|---|---|
| P1/P2 | `estornarPagamentoDeVenda`, `registrarPagamentoDeVenda` e `registrarAjuste` passam pela guarda de competências da 06D (mês do fato gravado; mês da venda ou do título referenciado, com marca). O recebível de pagamento com data informada nasce no mês do pagamento | `aplicacao/vendas.js`, `aplicacao/economico.js` |
| P1 (banco) | Migração **0010**: o ajuste de um título homologado só muda se ficar igual à soma dos registros de ajuste. Esses registros, por sua vez, só podem estar em competência aberta (gatilho 0009). Ajuste solto continua FV001 | `0010_auditoria_posicao_posterior.sql` |
| P3 | Retrato **completo** (indicadores com a composição, DRE com a árvore, cada R$ 100), tirado já com o estado novo. Para competência homologada, a apuração **apresenta a versão homologada** (`fonteDaApresentacao: VERSAO_HOMOLOGADA`); a apuração atual fica só como conferência (`reproduz`) | `aplicacao/competencias.js`, `aplicacao/apuracao.js` |
| P4 | Conservação compara o pago com **bruto − descontos** | `aplicacao/competencias.js` |
| P5 | Saldo informado deixa a marca no histórico da competência | `aplicacao/tesouraria.js` |
| P6 | A apuração lê só o mês: igualdade por competência e período das movimentações, paginado no banco. Comprovado idêntico ao cálculo sobre o histórico completo | `aplicacao/apuracao.js` |

## 7. Testes e evidências

| Suíte | Antes (`bdb2d11`) | Depois |
|---|---|---|
| Financeiro v2, memória | 261 | **281** (+20), todos passando |
| Financeiro v2, PostgreSQL | 261 | **281**, todos passando |
| Frontend | 1931 aprovados | 1931 aprovados, 0 falhas |
| Backend | 22 falhas, 1 cancelado | **idêntico** (mesma lista de falhas) |

**Mutação** (cópia de segurança e restauração por hash): sete mutantes; seis **mortos**:

1. estorno posterior sem guarda e sem auditoria;
2. pagamento posterior no mês da venda;
3. taxa posterior sem marca;
4. retrato sem composição;
5. retrato com o estado antigo;
6. conservação ignorando descontos.

O sétimo (carregar movimentações de outros meses) **sobrevive por ser equivalente** para a correção: a própria apuração filtra o mês. A guarda dele é o teste de equivalência mais a medição de desempenho. Os seis mutantes da 06D continuam válidos.

## 8. Riscos remanescentes

- **P7:** concessões gravadas direto no banco.
- **P8:** escopo do RLS definido pela sessão do banco.
- **Leituras de histórico completo:** Central de Conferências, fechamento e tesouraria ainda carregam o histórico completo da unidade. O custo cresce com os meses: em 12 meses sintéticos, a Central levou cerca de 0,4 s. Para os volumes atuais é aceitável, mas tende a piorar. A tesouraria precisa de títulos abertos de qualquer mês, então a otimização exige consultas por situação e período.
- **Visualização de PDF:** depende do visualizador do navegador.
- **Leitores sem amostra real:** iFood, Foody, recebimentos Stone e SAIPOS por pedido ainda não têm amostra real conferida.

## 9. Pendências documentais

- **Amostras reais privadas:** iFood (repasse), Foody, recebimentos Stone, SAIPOS por pedido (explicar a diferença faturamento × formas) e extrato OFX da Unicred.
- **Políticas:** materialidade e retenção (§ 14) aguardam aprovação.
- **Autoridade de provisionamento:** a decisão de quem é a autoridade real é do usuário e da administração da plataforma (§ 12).

## 10. Segurança

**Cobertura** (testes da 06D, da interface e desta execução):

- sessão ausente ou expirada (401);
- sem concessão e só leitura;
- operador acessando outra unidade (403/404);
- revogação durante sessão ativa (próxima ação recusada);
- autoconcessão e escalada;
- documento de outra unidade;
- repetição sem efeito duplicado;
- CSRF (token por perfil, origem e confirmação);
- concorrência (travas no núcleo e no banco);
- competência homologada e reabertura sem justificativa;
- arquivo do cofre alterado (hash);
- caminho arbitrário e identificador inválido (validação de UUID).

**Contorno pelo banco:**

- **Histórico:** só inserção e leitura (sem alteração nem exclusão).
- **Protegido também por gatilho:**
  - competência homologada, para todos os registros que mudam resultado ou vínculo;
  - versão de fechamento imutável;
  - sessão de caixa e saldo informado;
  - concessão com lista fechada de ações.
- **Não protegido no banco** (riscos P7 e P8):
  - a regra "o concedente precisa ter a ação" (escalada);
  - a escolha do escopo pela variável de sessão.

  Mitigação proposta antes de produção:
  1. gatilho adiado em `fv2_concessao` que exige do concedente uma concessão ativa com `conceder` e as ações concedidas (com exceção auditada só para o provisionamento atestado);
  2. `exigirConcessaoPersistida` **obrigatório** na integração;
  3. credencial da aplicação restrita ao servidor, com rotação.

  Não foi aplicado agora porque muda o modelo de contexto confiável usado pelos testes de núcleo e precisa ser decidido junto com a integração.

## 11. Desempenho

**Volume sintético:** 400 vendas por mês (Balcão, iFood, Anota AI e Stone com taxa), 40 obrigações por mês, liquidações e movimentações, no PostgreSQL isolado deste computador. São observações, **não metas aprovadas**.

| Consulta (mediana) | 1 mês | 12 meses (antes) | 12 meses (depois) |
|---|---|---|---|
| Apuração / DRE do mês | 30 ms | 261 ms | **37 ms** |
| Visão Geral (apuração + resumo) | 71 ms | 535 ms | **286 ms** |
| Composição de um indicador | 29 ms | 246 ms | **34 ms** |
| Contas a pagar (página) | 33 ms | 206 ms | 234 ms |
| Contas a receber (página) | 27 ms | 226 ms | 243 ms |
| Caixa e bancos (mês) | 26 ms | 203 ms | 199 ms |
| Vendas (página) | 53 ms | 423 ms | 398 ms |
| Central de Conferências | 57 ms | 434 ms | 418 ms |
| Pendências (página) | 54 ms | 394 ms | 406 ms |
| Fechamento (situação) | 58 ms | 391 ms | 383 ms |
| Prévia de homologação | 40 ms | 294 ms | 292 ms |
| 10 apurações simultâneas | 277 ms | 2.144 ms | **308 ms** |
| Memória do processo (RSS / heap) | 166 / 51 MB | 373 / 251 MB | **198 / 38 MB** |

Volume de 12 meses: 4.800 vendas, 6.480 lançamentos e 480 obrigações. A carga levou 69 s.

**O que mudou.** A apuração do mês passou a custar o mesmo com 1 ou 12 meses acumulados. A Visão Geral caiu pela metade; o restante dela é o resumo de tesouraria.

**Gargalos remanescentes.** Contas a pagar e a receber, caixa, vendas, Central, pendências, fechamento e prévia ainda carregam o histórico completo da unidade e crescem cerca de 7 a 8 vezes de 1 para 12 meses. Correção recomendada, numa execução própria com teste de equivalência como o desta:

- títulos abertos por situação;
- vendas e pendências paginadas no banco;
- fechamento e prévia restritos ao mês e aos vínculos.

As diferenças de ±10% entre as colunas "antes" e "depois" dessas telas são ruído da medição.

## 12. Plano futuro de integração (somente plano; nada foi conectado)

| Tema | Como é hoje (código local) | Proposta |
|---|---|---|
| Autenticação | `requireAuth` (`backend/src/middlewares/auth.js`): token Bearer validado no provedor; monta `req.user` (id, ativo, superadmin, painel administrativo, nível de MFA) | Mesmo middleware, sem mudança |
| Sessão e organização | `requireContexto`: token de contexto revalidado no banco a cada requisição (expiração, revogação, organização, unidade, impersonação); monta `req.tenant` e `req.acesso` | O adaptador de sessão do Financeiro v2 já consome `{ user, tenant, acesso }`. A organização vem **só** daí; impersonação é recusada por padrão |
| Unidades autorizadas | Contexto escolhido pelo usuário | `criarConcessoesDoRepositorio`: unidades = concessões ativas `financeiro_v2.*` do usuário (nunca papel ou módulo antigo) |
| Permissões | `shared/permissoes.js` e módulos (financeiro antigo) | Só concessões do Financeiro v2; **`exigirConcessaoPersistida: true`** |
| Endpoints | `routes.js`: rotas por domínio dentro de `tenant` (após `requireContexto`) | Novo roteador `/financeiro-v2` dentro de `tenant`, com flag de liberação por unidade (lista explícita na configuração do servidor). Leitura por GET. Escrita por POST com confirmação e chave de idempotência (a API usa Bearer, não cookie: o CSRF clássico não se aplica, mas a origem é conferida). Erros mapeados como na demonstração |
| Disponibilidade só à unidade autorizada | — | Flag por unidade + concessão por unidade; sem flag, a rota responde 404 |
| Financeiro antigo | `/gestao-financeira` com `requireFinanceiro()` | Intocado; o v2 não lê nem escreve tabelas antigas (teste estático já garante) |
| Persistência | — | Esquema `fv2_*` próprio, migrações 0001–0010 aplicadas por procedimento aprovado, papel `fv2_app` sem `bypassrls` |
| Reversão | — | Desligar a flag (rota some); as tabelas `fv2_*` permanecem (nada se apaga); o financeiro antigo nunca foi alterado. Retomar = religar a flag |

**Administrador inicial (proposta).** A autoridade é uma operação dedicada da plataforma, protegida por `requireSuperadmin` **e** `requireAAL2` (MFA), que **atesta** o ato:

- unidade, usuário (diferente de quem atesta), ações explícitas e evidência (ex.: identificação do pedido formal);
- o atestado é verificado por `autoridadeDeProvisionamento.verificar`;
- ser superadmin **não** dá acesso financeiro: quem atesta não recebe nada e não pode atestar a si mesmo;
- vale uma vez por unidade, sem administrador universal;
- requer **decisão** sobre quem pode atestar (ex.: dois administradores, quem pede ≠ quem atesta).

**Dependência:** essa decisão e a criação da operação na plataforma.

## 13. Bloqueios para homologação operacional

| Bloqueio | Tipo |
|---|---|
| Integração ao login e às rotas (§ 12) | Dependência externa (decisão e implantação) |
| Autoridade real de provisionamento | Dependência externa (decisão) |
| Mitigação P7 (gatilho de concessões) e `exigirConcessaoPersistida` obrigatório | Técnico, antes de produção |
| Política de materialidade aprovada | Decisão |
| Política de retenção validada (jurídico e contábil) | Decisão |
| Amostras reais pendentes (iFood, Foody, recebimentos Stone, SAIPOS por pedido, OFX) | Documental |
| Migrações 0001–0010 aplicadas num ambiente de homologação (não produção) | Implantação |

## 14. Políticas propostas (para aprovação; nada está em vigor)

### Materialidade (critérios qualitativos, sem limite em reais ou percentual)

| Tipo | Bloqueia homologar? | Critério |
|---|---|---|
| Divergência econômica (valores de fontes diferentes não fecham) | **Sim** | Até explicação registrada **com** documento |
| Divergência documental (falta o documento que comprova um valor já registrado) | Sim, se o valor entra no resultado | Fechamento "com pendências documentadas" é permitido; homologar não |
| Divergência de classificação (categoria provisória) | **Sim** | A categoria definitiva pode mudar o resultado |
| Diferença de arredondamento comprovada | Não | Só quando o cálculo de origem (ex.: 6 casas da Stone) está documentado e a diferença é explicada por ele |
| Recebível válido ainda não pago | **Não** | Posição financeira, não resultado |
| Documento ausente sem valor econômico | Não | Fica como pendência documental |
| Erro de período (fato na competência errada) | **Sim** | Corrigir antes; depois do fechamento, só com reabertura |
| Risco de duplicidade (agregado × pedidos, importação repetida) | **Sim** | Até a eliminação comprovada |

Nenhuma aprovação genérica e nenhuma tolerância automática. A homologação é sempre decisão de pessoa autorizada.

### Retenção documental (classes e requisitos; prazos a validar)

| Classe | Acesso | Preservação |
|---|---|---|
| Fiscais e contábeis (notas, extratos, relatórios de vendas) | `financeiro_v2.documentos`, por unidade | Prazo legal a definir pelo contador |
| Comprovantes operacionais | Idem | Enquanto ligados a registro financeiro, no mínimo o prazo da classe fiscal |
| Versões substituídas | Idem | Mesmo prazo da versão vigente |
| Registros de acesso (metadados) | Administração | Prazo a definir (segurança × privacidade) |

**Requisitos:**

- **Sem exclusão:** nenhum documento é excluído (o cofre não tem operação de apagar).
- **Proteção:** pasta privada fora do Git e de sincronização, criptografia em repouso no destino real, chaves separadas.
- **Backup e restauração:** cofre e banco na mesma janela; restauração conferida por hash; teste periódico.
- **Auditoria:** o histórico de acesso é preservado com o documento.

## 15. Critérios de aprovação (esta execução)

| Critério | Situação |
|---|---|
| Fluxos financeiros principais testados de ponta a ponta | Atendido (cenário integrado e cadeias) |
| Sem inconsistência crítica conhecida | Atendido: P1 e P2 corrigidos e testados nos dois modos |
| Competências homologadas protegidas; DRE reproduzível | Atendido (I7–I9) |
| Recebimentos e pagamentos sem duplicar resultado | Atendido (I1, I2, I12) |
| Saldos e projeções coerentes | Atendido (I10–I12) |
| Rastreabilidade documental | Atendido (06D + Fase E) |
| Permissões e isolamento comprovados | Atendido no núcleo e na interface; riscos P7 e P8 no banco documentados |
| Sete áreas coerentes | Atendido (inspeção, § 3 e relatório) |
| Testes relevantes passando; regressão sem falha nova | Atendido |
| Pendências externas identificadas | Atendido (§ 13) |
| Produção intocada | Atendido |
