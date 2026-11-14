# Financeiro v2 — 16. Segurança, isolamento PostgreSQL, desempenho e preparação de homologação (Execução 07B)

Data: 13/11/2026. Branch local `feat/financeiro-v2-hardening-seguranca`, derivada de `565ec0a` (Execução 07).

> **Escopo e limites**
> - **Ambiente:** só PostgreSQL local isolado, identidades e dados sintéticos.
> - **Produção:** não foi acessada; nenhuma rota real foi habilitada.
> - **O que fica provado:** a credencial da **aplicação**, sozinha, não escolhe escopo, não cria sessão e não altera concessão.
> - **O que não fica provado:** que o gateway real autentica pessoas. Esse controle depende da integração e **não** recebe "aprovado" aqui.

## 1. Riscos encontrados (diagnóstico, Fase A)

| # | Área | Situação em `565ec0a` | Gravidade | Reprodução / evidência | Situação agora |
|---|---|---|---|---|---|
| A1 | Escopo do RLS | Políticas usavam `fv2.organizacao_id` e `fv2.unidade_id`, variáveis que o próprio papel da aplicação define. Com a credencial da aplicação, bastava declarar outra unidade para ler e gravar nela | **Crítico** | Antes: `set_config` com a unidade B dava acesso a B. Agora: teste 5/6 (variáveis antigas não abrem nada) | **Corrigido** (sessão de banco, § 3) |
| A2 | Concessões | `fv2_app` tinha INSERT/UPDATE em `fv2_concessao`. Escalada, autoconcessão e concessão entre unidades eram barradas só no núcleo | **Crítico** | Teste 1/2: INSERT/UPDATE direto agora é `42501` | **Corrigido** (§ 4) |
| A3 | Concedente | O núcleo confiava nas permissões do **contexto** do concedente, sem concessão gravada | Alto | Teste "07B — conceder exige a concessão GRAVADA" | **Corrigido** (núcleo + banco) |
| A4 | Revogação | Só valia no núcleo, e só com `exigirConcessaoPersistida`. No banco, uma sessão continuava com acesso | Alto | Teste 9 | **Corrigido**: a revogação derruba as sessões de banco do alvo e corta a transação em andamento |
| A5 | Privilégios do papel | Sem DELETE/TRUNCATE, sem BYPASSRLS, sem CREATE no esquema (já ok). Faltava provar: `set role`, `row_security = off`, desligar RLS, criar função | Médio | Teste 5/6 | **Comprovado** (todos `42501`) |
| A6 | Conexão do pool | Variável local à transação (ok), mas uma variável de **sessão** esquecida na conexão seria herdada | Médio | Teste 7 (valor de conexão deixado de propósito) | **Corrigido**: `fv2_assumir_sessao` limpa o valor da conexão e confere identidade e escopo |
| A7 | Concorrência | Travas consultivas por competência (06D). Faltavam corridas de concessão e revogação | Alto | Teste 9 (6 rodadas: retirada de `conceder` × concessão pelo próprio gestor) | **Corrigido**: trava por escopo nas concessões; emissão de sessão espera revogação em andamento |
| A8 | Cofre documental | O banco guarda ficha e vínculo (com RLS). O **arquivo** fica no adaptador de cofre (memória/disco local), fora do banco | Médio | Teste 15 (documento de outra unidade: invisível e "não encontrado") | Ficha protegida; serviço real do cofre é **dependência** |
| A9 | Histórico completo | Contas a Pagar e a Receber liam 18 tabelas do histórico inteiro; Vendas, Central e Fechamento leem 22–23 | Médio | Medição (§ 7) | Pagar e Receber **corrigidos**; demais documentados (§ 7) |
| A10 | Migração e reversão | Migrações só para frente, com hash conferido. A 0011 é aditiva (tabelas e funções novas; troca de corpo de `fv2_org/fv2_uni`; revogação de privilégios) | Baixo | Teste de migrações do zero | Procedimento de reversão em § 10 (não executado) |

## 2. Causas

- **A1 e A2:** o RLS tratava "o que a aplicação declara" como identidade, e a regra de concessão existia só em código. Um banco que recebe escopo de quem quer acessar não isola nada.
- **A3:** o contexto confiável dos testes (permissões dentro do contexto) virou fonte de autoridade também em produção.
- **A4:** a revogação não tinha efeito sobre o que já estava autorizado na persistência.

## 3. Isolamento RLS e identidade da sessão (Fase C)

**Modelo novo**, migração local `0011_sessao_banco_e_concessoes.sql`:

| Peça | Função |
|---|---|
| `fv2_autoridade` (papel) | É o **gateway de autenticação**, com credencial própria e separada da aplicação. Único que executa `fv2_abrir_sessao`, `fv2_abrir_sessao_de_provisionamento` e `fv2_encerrar_sessoes` |
| `fv2_sessao_banco` | Sessão emitida: usuário, organização, unidade, finalidade, se pode escrever, validade (1 s a 12 h), revogação. Guarda só o **hash SHA-256** do token. A aplicação **não tem nenhum privilégio** nela |
| Emissão | Exige escopo configurado e **concessão ativa** do usuário na unidade. "Pode escrever" = tem alguma ação além de `ver`. Espera a trava de concessões (uma revogação em andamento nunca é furada) |
| `fv2_assumir_sessao(token)` | A aplicação declara o token **por transação** (variável local) e limpa qualquer valor deixado na conexão. Devolve usuário, organização e unidade; o adaptador **confere** que são os esperados |
| `fv2_org()`, `fv2_uni()`, `fv2_usuario()` | Vêm do **registro da sessão** no banco. As variáveis antigas são ignoradas |
| Políticas | Escopo avaliado uma vez por consulta. **Leitura** só com sessão operacional; **escrita** só com sessão que tem ação além de `ver`. Valem para leitura e escrita em todas as tabelas |
| Falha | Sem token, token inválido, expirado ou revogado: nenhuma linha visível e nenhuma gravação (`42501`) |

**Comprovado** (`postgres-seguranca.test.js`, com os privilégios de `fv2_app`):
- token ausente, vazio, inventado ou "parecido";
- variáveis antigas apontando para outra organização, sozinhas ou junto de uma sessão válida;
- token trocado no meio da transação;
- `row_security = off`, `alter table ... disable/no force row level security`;
- `set role fv2_autoridade` ou `fv2_guardiao`;
- leitura das tabelas de sessão e de auditoria;
- criação de função;
- emissão de sessão ou de provisionamento pela aplicação.

Todos recusados ou vazios. Também comprovado:
- mesma pessoa em duas unidades ao mesmo tempo: cada transação só enxerga a sua;
- comando de uma unidade sobre sessão de outra: nada aparece;
- autoridade entregando token de outro usuário ou de outra unidade: o adaptador recusa (`PERMISSAO_INSUFICIENTE`).

**Exceção administrativa explícita.** As funções privilegiadas pertencem a `fv2_guardiao`: sem login, sem membros, sem BYPASSRLS, com `search_path` fixo e EXECUTE revogado de PUBLIC (verificado em teste). As duas únicas políticas novas fora do padrão são do guardião, restritas a `fv2_concessao` e à leitura de `fv2_escopo`. As funções filtram o escopo pela própria sessão.

**O que continua dependente da integração real.** O banco confia em quem detém a credencial de `fv2_autoridade`. Ele **não autentica pessoas**. A garantia é de separação: comprometer a credencial da aplicação não basta para escolher unidade nem para criar sessão.

Riscos que permanecem:
- quem compromete o **processo** da aplicação obtém os tokens em uso naquele processo (reuso de até 5 min no adaptador, validade definida pela autoridade);
- quem compromete a **autoridade** emite sessões para quem tem concessão.

## 4. Gestão de concessões (Fase B)

- **Sem escrita direta:** `fv2_app` perdeu INSERT, UPDATE, DELETE e TRUNCATE em `fv2_concessao` (ficou só SELECT).
- **Única escrita:** `fv2_gravar_concessao(registro, versão)`, do guardião. A função confere **no banco**:

| Regra | Como |
|---|---|
| Ator autenticado | Ator = usuário da sessão de banco, nunca um campo enviado. A autoria (`concedido_por`, `atualizado_por`) precisa ser a dele |
| Ator autorizado | Concessão **ativa e gravada** com `conceder` na mesma unidade |
| Sem autoconcessão | Alvo ≠ ator (inclusive revogar a si mesmo) |
| Sem escalada | Ações **novas** ⊆ ações gravadas do ator |
| Sem cruzar unidades | Registro precisa ter o escopo da sessão; sem concessão na outra unidade, não há sessão lá |
| Concorrência | Trava exclusiva por escopo. A sessão do ator é **revalidada depois da trava** (retirada concorrente de `conceder` é respeitada) |
| Justificativa e auditoria | `fv2_auditoria_concessao`, só inclusão (nem o dono altera ou apaga: `FV040`): ator, sessão, alvo, antes, depois, operação, justificativa, papel do banco, instante. O histórico do núcleo continua obrigatório (gatilho adiado) |
| Revogação imediata | Toda mudança nos direitos do alvo **revoga as sessões de banco dele**. A transação em andamento perde visão e escrita no comando seguinte; a próxima ação é recusada porque a autoridade não emite sessão sem concessão ativa |

- **No núcleo**, sem depender do banco: conceder e revogar exigem a concessão **gravada** do concedente, e as ações repassáveis são as gravadas **e** presentes no contexto. A mesma regra vale em memória.

**Revisão da função `SECURITY DEFINER`:**

| Item | Situação |
|---|---|
| Dono | `fv2_guardiao` |
| `search_path` | `pg_catalog, public, pg_temp` |
| Argumentos | Registro tipado por `jsonb_populate_record`; escopo e autoria conferidos contra a sessão |
| Identidade do ator | Da sessão de banco (hash do token), nunca de argumento |
| Execução | Só `fv2_app`; PUBLIC revogado |
| Acesso às tabelas | Guardião só nas tabelas de concessão, sessão, auditoria e provisionamento, mais leitura de escopo |

## 5. Procedimento administrativo — administrador financeiro inicial (Fase H)

1. Um administrador da plataforma, autenticado com MFA (**aal2**), atesta pela operação da plataforma (`requireSuperadmin` + `requireAAL2`):
   - unidade;
   - usuário alvo (≠ atestante);
   - ações explícitas;
   - justificativa;
   - evidência.
2. O **gateway** (credencial `fv2_autoridade`) chama `fv2_abrir_sessao_de_provisionamento`. O banco confere:
   - nível `aal2`;
   - atestante ≠ alvo;
   - justificativa e evidência preenchidas;
   - ações não vazias;
   - escopo configurado;
   - **nenhum administrador ativo** na unidade (sob trava).

   Se tudo confere, registra o ato em `fv2_provisionamento_inicial` e emite uma sessão **de provisionamento** (2 minutos). Essa sessão:
   - não enxerga dados financeiros;
   - não grava nada além da concessão atestada;
   - não concede a outra pessoa nem ações diferentes das atestadas.
3. O núcleo (`provisionarAdministradorInicial`) também exige a atestação, `aal2` e escopo autorizado, e grava a concessão com histórico. A função guardada confere de novo e marca o ato como **concluído**.
4. O atestante **não recebe acesso**: não tem concessão, logo nunca obtém sessão operacional (testado).
5. **Repetição:** recusada enquanto a unidade tiver quem conceda. Não existe administrador universal nem acesso oculto: toda concessão está no histórico, na auditoria e no registro de provisionamento.

Comprovado com identidades e autoridade **sintéticas**. **Dependência real:** a plataforma precisa expor o nível de autenticação (`aal`) confiável da sessão. O middleware atual já tem `requireAAL2`, mas a operação de atestação e o gateway não existem. Por isso este controle **não** está aprovado para produção.

## 6. Concorrência e integridade (Fase D)

| Cenário | Teste | Resultado |
|---|---|---|
| Concessão × revogação da mesma permissão (corrida) | Segurança 9 (6 rodadas) | Nenhuma concessão do gestor gravada depois da retirada do `conceder` dele (ordem real, sequência da auditoria) |
| Revogação durante operação | Segurança 9 | A transação em andamento perde leitura e escrita no comando seguinte; a próxima ação é recusada |
| Mudança de unidade em sessões diferentes | Segurança 7 | Cada transação só vê a própria unidade |
| Reutilização de conexão após erro | Segurança 7 | Rollback sem efeito; conexão volta sem sessão |
| Transação interrompida | Segurança 7 | Nada persiste |
| Conciliação × homologação | `postgres-fechamento` (06D) | Mantido |
| Liquidação posterior a competência homologada | `postgres-auditoria` (07) | Mantido |
| Reabertura e nova homologação | `auditoria-competencias` A7 (07) | Mantido |
| Operações repetidas | `postgres-trava-repeticao`, cadeias (07) | Mantido |
| Duas alterações no mesmo documento | Versão + trava (06D) | Mantido |
| Concessões concorrentes ao mesmo usuário | `acessos-sessao` | Um registro coerente |

## 7. Desempenho (Fases E e F)

**Otimização feita (Contas a Pagar e Contas a Receber, prioridades 1 e 2):**
- **Carga dirigida:** só as tabelas usadas e, nelas, só as linhas ligadas aos títulos (`em: { id | alvoId | movimentacaoId | registroId }`, paginado no banco em lotes).
- **Cálculo:** pelas **mesmas** funções de `dominio/tesouraria.js`, então totais, páginas, ordenação e situações são idênticos.
- **Prova:** `desempenho-equivalencia-telas.test.js` compara com a carga completa de referência (`cargaCompletaDeReferencia`, opção só de teste), nos dois adaptadores. O cenário tem cinco meses, títulos pagos em parte, uma saída pagando dois títulos, documentos em título e em movimentação, recorrência, ajuste, recebimento parcial, 9 filtros/páginas de Contas a Pagar e 7 de Contas a Receber.

**Medição** (PostgreSQL isolado, 12 meses sintéticos):
- **Volume:**
  - 4.800 vendas, 3.600 recebíveis, 480 obrigações;
  - 1.428 movimentações, 6.480 lançamentos;
  - 84 documentos, 480 propostas;
  - 8 meses com versão de fechamento.
- **Mesmas condições:** máquina, script e volume iguais. Observações, **não metas**.

| Consulta (mediana) | 07 depois (`565ec0a`) | 07B antes da otimização | 07B depois |
|---|---|---|---|
| Apuração / DRE do mês | 37 ms | 35 ms | 34 ms |
| Visão Geral (apuração + resumo) | 286 ms | 291 ms | 303 ms |
| Composição de um indicador | 34 ms | 40 ms | 34 ms |
| **Contas a pagar (página)** | 234 ms | 220 ms | **46 ms** |
| Contas a receber (página) | 243 ms | 241 ms | 222 ms |
| Caixa e bancos (mês) | 199 ms | 295 ms | 250 ms |
| Vendas (página) | 398 ms | 397 ms | 429 ms |
| Central de Conferências | 418 ms | 427 ms | 424 ms |
| Pendências (página) | 406 ms | 411 ms | 393 ms |
| Fechamento (situação) | 383 ms | 434 ms | 407 ms |
| Prévia de homologação | 292 ms | 326 ms | 311 ms |
| 10 apurações simultâneas | 308 ms | 316 ms | 293 ms |
| 10 telas simultâneas (mistas) | — | 2.099 ms | 1.891 ms |
| Memória do processo (RSS / heap) | 198 / 38 MB | 395 / 313 MB | 272 / 187 MB |

**Como ler a tabela:**
- **Colunas não idênticas:** a coluna "07 depois" usou o script da 07, sem documentos, propostas, pendências e versões. As duas colunas da 07B usam o script ampliado, com o mesmo volume.
- **Segurança:** a sessão de banco e as políticas novas não mudaram os tempos de forma perceptível (diferenças de ±10% são ruído).
- **Contas a Pagar:** caiu cerca de 4,8×.
- **Contas a Receber:** quase não mudou. Os totais da tela cobrem **todos** os recebíveis do histórico (3.600) e suas ligações; a carga dirigida corta só as outras tabelas. Reduzir mais exige totais agregados no banco por situação, o que depende de regras com data de hoje e documento. Fica como gargalo.
- **Memória:** o pico caiu de 395 para 272 MB de RSS.

**Ressalva do volume:** em 3 dos 11 meses, o fechamento sintético foi recusado (`FV2_TRANSICAO_INVALIDA`). O volume ficou com 8 meses com versão de fechamento.

**Gargalos que permanecem:** Vendas, Central, Pendências, Fechamento, Prévia, e Caixa/Visão Geral no resumo. Eles montam a **visão de vendas** de todo o histórico (pagamentos, recebíveis, liquidações e registros de fonte de outros meses explicam a venda do mês).

Para otimizar sem alterar resultado, é preciso uma carga por competência com o **fecho dos vínculos** (venda do mês → pagamentos → recebíveis → liquidações → movimentações → documentos, e o inverso), validada por equivalência como a desta execução. Fica para uma execução própria; fazer às pressas arriscaria a exatidão.

## 8. Testes e evidências

| Suíte | `565ec0a` | Agora |
|---|---|---|
| Financeiro v2, memória | 281 | **292**, todos passando |
| Financeiro v2, PostgreSQL | 281 | **292**, todos passando |
| Frontend | 1.931 aprovados | 1.931 aprovados, 0 falhas (26 pulados, como antes) |
| Backend | 6.469 testes: 22 falhas e 1 cancelado | **Idêntico**: mesmas 15 linhas de falha, todas preexistentes |

**Testes novos:**
- **`postgres-seguranca.test.js`** (8 testes, cobrindo os itens 1–15 da lista obrigatória, sem concessão-fixture). O item 16 (concorrência de fechamento) segue coberto pelos testes da 06D e da 07.
- **`desempenho-equivalencia-telas.test.js`** (itens 17–21).
- Um teste novo em `acessos-sessao` (concedente gravado; MFA no núcleo).
- Testes existentes adaptados ao novo modelo, sem afrouxar nenhuma asserção:
  - provisionamento antes de conceder;
  - listas filtradas pelo usuário em questão;
  - tabela nova de privilégios;
  - unidade inexistente: sem sessão.

**Fixture de teste (declarada).** Nos testes gerais, a autoridade de teste grava, como **dono do banco**, uma concessão espelhando o contexto confiável quando um usuário sintético opera pela primeira vez sem concessão. É o equivalente a "já provisionado". Ela:
- nunca sobrescreve uma concessão existente;
- fica desligada nos testes de segurança e de concessão.

**Mutação:** § 9.

## 9. Mutações

13 mutantes, cada um aplicado sobre uma cópia de segurança e restaurado com hash conferido. Os mutantes de SQL reconstroem o banco-modelo; no fim, ele foi reconstruído com a 0011 original. **13 de 13 mortos:**

| # | Barreira removida | Morto por |
|---|---|---|
| S1 | Revogação de INSERT/UPDATE em concessão para a aplicação | Segurança 1/2 |
| S2 | Recusa de autoconcessão no banco | Segurança 3/4 |
| S3 | "Ação nova ⊆ ações do ator" no banco | Segurança 3/4 |
| S4 | Sessão revogada deixa de valer | Segurança 9 |
| S5 | Exigência de aal2 no provisionamento | Segurança 10/11 |
| S6 | Escopo exclusivo da sessão (volta a aceitar a variável da aplicação) | Segurança 5/6 |
| S7 | Concessão alterada derruba sessões do alvo | Segurança 9 |
| S8 | Emissão de sessão exige concessão ativa | Segurança 3/4, 9, 10/11 |
| S9 | Trava de concessões (corrida de escalada) | Segurança 9 (corrida em 6 rodadas) |
| J1 | Adaptador confere a identidade devolvida pelo banco | Segurança (adaptador) |
| J2 | Núcleo exige a concessão gravada do concedente | `acessos-sessao` (memória) |
| J3 | Núcleo exige aal2 do atestante | `acessos-sessao` (memória) |
| J4 | Documentos das movimentações na carga dirigida | `desempenho-equivalencia-telas` |

Os mutantes da 07 (competência homologada) e da 06D continuam válidos; nenhum teste deles foi afrouxado.

## 10. Regressões e reversão

- **Regressão:** `565ec0a` comparado com esta branch, ambiente fictício, `test/*.test.js`: idêntica (§ 8).
- **Reversão da 0011** (procedimento, **não executado**; só em ambiente isolado):
  - devolver INSERT/UPDATE de `fv2_concessao` a `fv2_app` **não** é recomendado;
  - para voltar ao modelo antigo seria preciso recriar `fv2_org/fv2_uni` por variável, o que reabre A1;
  - a reversão operacional é **desligar o módulo** (flag por unidade, § 11), sem apagar dados.
  - As tabelas novas são só de inclusão e não se apagam.

## 11. Plano de autenticação real (Fase G — somente plano)

| Tema | Proposta |
|---|---|
| Validar a sessão real | `requireAuth` (Bearer validado no provedor) + `requireContexto` (token de contexto revalidado no banco a cada requisição: expiração, revogação, organização, unidade, impersonação), sem mudança |
| Organização | **Só** de `req.tenant.organizacaoId`, via `criarAdaptadorDeSessao`. O cliente não informa |
| Unidades autorizadas | Concessões `financeiro_v2.*` **ativas** do usuário (`criarConcessoesDoRepositorio`). Papel antigo e superadmin não contam |
| Permissões | `exigirConcessaoPersistida: true` (obrigatório). O núcleo confere a concessão gravada e o banco confere de novo |
| Sessão de banco | Um **gateway** com credencial `fv2_autoridade` (fora do pool da aplicação, segredo próprio e rotacionável) emite o token por usuário e unidade. Referência = `req.acesso.sessionId`; validade ≤ expiração do contexto e ≤ 15 min |
| Endpoints | Roteador `/financeiro-v2` dentro de `tenant` (após `requireContexto`). GET para leitura; POST com confirmação e chave de idempotência. Origem conferida. Sem flag da unidade → 404 |
| Reutilização de contexto | Token por transação (variável local), compatível com pooler em modo transação. `fv2_assumir_sessao` limpa valores de conexão. Cache de token por usuário + unidade só em memória do processo |
| Após revogação | Concessão revogada: o banco derruba as sessões do alvo e a autoridade não emite outra. Logout ou revogação do contexto da plataforma: o gateway chama `fv2_encerrar_sessoes` |
| Auditoria | `fv2_historico` (núcleo), `fv2_auditoria_concessao` (banco, só inclusão), `fv2_sessao_banco` (emissões e revogações), `fv2_provisionamento_inicial` |
| Habilitar só a unidade autorizada | Flag por unidade na configuração do servidor + `fv2_escopo` provisionado + concessão ativa |
| Desabilitar sem apagar | Desligar a flag (rota some). As tabelas `fv2_*` permanecem; o financeiro antigo nunca é tocado |

**Cuidados na integração:**
- configurar o servidor para **não registrar parâmetros de comandos** (o token passa como parâmetro);
- a conexão do Financeiro v2 é PostgreSQL direta (o backend atual usa o cliente Supabase/PostgREST);
- o **dono** das tabelas não pode ser papel com login de aplicação.

## 12. Políticas propostas (para aprovação; nada está em vigor)

### Materialidade (critérios qualitativos; nenhuma tolerância em reais ou percentual)

| Situação | Bloqueia homologar? | Decisão autorizada |
|---|---|---|
| Divergência econômica entre fontes | **Sim** | Explicação registrada **com** documento, por quem tem `homologar` |
| Arredondamento documentado | Não, se a regra de origem (ex.: 6 casas da Stone) estiver documentada e explicar a diferença | Registro da regra + conferência |
| Classificação provisória | **Sim** | Classificação definitiva por quem tem `corrigir` |
| Evidência insuficiente para valor que entra no resultado | **Sim** para homologar ("com pendências" é permitido) | Documento anexado ou valor fora do resultado |
| Recebível válido em aberto | Não | Posição financeira |
| Fato na competência errada | **Sim** | Correção; após homologar, só com reabertura justificada |
| Risco de duplicidade | **Sim** | Eliminação comprovada |
| Revisões | Toda revisão gera nova versão; a anterior fica imutável | Reabertura com justificativa e histórico |

### Retenção documental (prazos pendentes de validação contábil e jurídica)

| Tema | Proposta |
|---|---|
| Classes | Fiscais e contábeis; comprovantes operacionais; relatórios importados (com versões substituídas); registros de acesso; auditoria de concessões e sessões |
| Proteção e acesso | `financeiro_v2.documentos` por unidade; arquivo só por blob controlado; nunca caminho do cliente |
| Backup | Cofre e banco na mesma janela, com hash de cada arquivo |
| Restauração | Restauração conferida por hash; teste periódico documentado |
| Integridade | Hash SHA-256 conferido a cada abertura (adulteração detectada, 06D) |
| Histórico e auditoria | Preservados junto do documento; tabelas de auditoria só de inclusão |
| Exclusão | **Nenhuma** exclusão automática; nenhum prazo inventado |
| Aprovação | Contador e jurídico definem os prazos por classe |

## 13. Dependências externas

1. Gateway real com credencial `fv2_autoridade`, e decisão de onde ele roda.
2. Operação de atestação na plataforma (`requireSuperadmin` + `requireAAL2`) e decisão sobre quem pode atestar.
3. Conexão PostgreSQL direta para o módulo (pooler em modo transação) e papéis criados no ambiente de homologação.
4. Serviço real do cofre (armazenamento privado com criptografia em repouso).
5. Aprovação das políticas de materialidade e retenção.
6. Amostras reais pendentes: iFood, Foody, recebimentos Stone, SAIPOS por pedido, OFX Unicred.

## 14. Critérios de GO/NO-GO

| Critério | Situação |
|---|---|
| Escalada de privilégio conhecida corrigida ou bloqueada | Atendido (A1–A4, testado no banco) |
| Isolamento da persistência comprovado no modelo implementado | Atendido (com a ressalva de § 3) |
| Limitações dependentes de autenticação real documentadas | Atendido (§ 3, § 5, § 13) |
| Consultas de histórico completo otimizadas sem alterar resultado | **Parcial**: Pagar e Receber sim; Vendas, Central e Fechamento documentados |
| Testes de concorrência e segurança passando | Atendido (292/292 nos dois modos; 13/13 mutantes mortos) |
| Sete áreas coerentes; sem regressão financeira | Atendido nos testes: DRE, tesouraria, Central e cenário integrado da 07 inalterados. As telas não mudaram; a inspeção no navegador da 07 não foi repetida, porque a demonstração usa memória e as telas são as mesmas |
| Produção intocada | Atendido |

**Recomendação:**
- **GO** para iniciar a homologação operacional **isolada**: banco de homologação próprio, gateway sintético ou de homologação, dados sintéticos ou amostras autorizadas.
- **NO-GO** para produção e para qualquer acesso real enquanto § 13 (itens 1–4) não estiver resolvido.
- A segurança **não** está integralmente aprovada: o controle de identidade depende do gateway real.
