# Financeiro v2 — 22. Preparação da integração com a plataforma Crescer com Delivery (Execução 09)

Data: 14/11/2026. Branch local `feat/financeiro-v2-preparacao-integracao`, derivada de `3acb9a8` (08E).

> **Preparação LOCAL. A integração real NÃO foi iniciada.**
> - Nenhuma rota publicada; o módulo continua sem montagem (guarda estática `isolamento-estatico`); o encaixe do menu
>   existe como módulo puro **não importado** pela aplicação (teste garante).
> - Produção não acessada; `backend/.env` não lido (testes com `node --test` direto); Supabase não acessado; nenhum
>   usuário, concessão ou dado real usado ou alterado; nenhuma migração fora do PostgreSQL isolado; sem push/merge/deploy.
> - Identidades, empresas, unidades, documentos e valores dos testes são sintéticos.

Commits locais: ver § 15. Matriz das pendências para validação: [22a-matriz-pendencias.md](22a-matriz-pendencias.md).

---

## 1. Arquitetura existente (Fase A — com evidências do código)

| # | Pergunta | Como é hoje | Evidência |
|---|---|---|---|
| 1 | Login | E-mail e senha no **Supabase Auth** pelo navegador (`signInWithPassword`); login novo limpa o contexto anterior | `frontend/src/sessao.js` `login()` |
| 2 | Criação da sessão | Duas credenciais: (a) **access token** do Supabase (identidade); (b) **Context Token** assinado pelo servidor (HMAC-SHA256, v2) com `sid` de uma linha em `sessoes_contexto` | `shared/contextToken.js` `emitirContextToken`; `sessao.service.js` `criarSessao` (a linha nasce antes do token) |
| 3 | Validação no backend | `requireAuth`: `supabase.auth.getUser(token)` + relê `perfis`, `plataforma_admins`, `painel_administrativo_usuarios` a cada requisição. `requireContexto`: verifica assinatura/versão/expiração do Context Token, confere `sub` = usuário, **relê a linha `sessoes_contexto`** (revogada? expirada? org/unidade iguais ao token?), confere `pid` × perfil ativo, empresa não bloqueada | `middlewares/auth.js` L99–164, L178–296 |
| 4 | Organização | Só da linha de `sessoes_contexto` (os cabeçalhos antigos `x-organizacao-id`/`x-unidade-id` foram removidos) | `auth.js` cabeçalho; `req.tenant` L261 |
| 5 | Unidades autorizadas | Vínculo de **empresa** do perfil (dá todas as unidades ativas) **ou** vínculo **direto** com a unidade; "todas as unidades" só com vínculo de empresa | `sessao.service.js` `acessoEfetivoDaUnidade`, `selecionarContexto` |
| 6 | Unidade ativa | Escolhida em `POST /sessao/selecionar` (validada no servidor), gravada na sessão de contexto | `sessao.routes.js` L36 |
| 7 | Troca de unidade | `POST /sessao/trocar-unidade` cria sessão nova e **revoga a anterior** (Model Y); no navegador, `limparContexto` + `invalidarGeracaoDeContexto` descartam respostas em voo | `sessao.service.js` `trocarUnidadeDoContexto`; `frontend/src/sessao.js`, `contextoEscopo.js` |
| 8 | Menu do financeiro | Setor FINANCEIRO com `MENU_FINANCEIRO`; máquina de estados `loading → financeiro_2 / legado / negado / erro` decidida por `GET /gestao-financeira/status` (nunca cai no legado por padrão nem em erro) | `frontend/src/financeiroMenu.js`, `financeiroAcesso.js` |
| 9 | Expiração | Access token do Supabase com renovação automática no navegador (`autoRefreshToken`); sessão de contexto **8 h** (impersonação **1 h**), conferida no banco a cada requisição; heartbeat `ultimo_uso_em` | `supabaseClient.js`; `contextToken.js` `VALIDADE_PADRAO_S`; `auth.js` L212 |
| 10 | Permissões e papéis | Papéis de vínculo (`organization_admin`, `unit_manager`, `finance`, `operations`, `viewer`, …) com permissões congeladas na sessão; papéis globais `plataforma_admins` (SuperAdmin) e `painel_administrativo_usuarios`. **Impersonação passa por qualquer `requirePermissao`/`requireModulo`/`requirePapel`** (bypass de suporte) | `shared/permissoes.js`; `auth.js` L422–497 |
| 11 | MFA | Supabase MFA (TOTP etc.). `aal`/`amr` lidos do JWT **depois** de `getUser` validar a assinatura; `mfaEm` = carimbo do 2º fator mais recente. Exigência **dormente** (flags `MFA_ENFORCE_*` desligadas). Política de "MFA recente" (aal2 + fator ≤ 10 min) existe em `shared/mfaRecente.js`, com nota: confirmar a unidade do `amr[].timestamp` contra um JWT real antes de ligar | `auth.js` L61–73, L135; `config/seguranca.js`; `shared/mfaRecente.js` |
| 12 | Logout e revogação | `POST /sessao/encerrar` revoga a sessão de contexto (com ou sem contexto válido) e audita; depois `signOut({ scope: "local" })`. Revogação forçada/bloqueio de empresa valem na requisição seguinte (linha relida) | `sessao.service.js` `encerrarContexto`, `revogarSessoes`; `frontend/src/sessao.js` L187–200 |

Achados relevantes para o financeiro:
- **Multi-perfil:** uma conta de login pode ter várias pessoas operacionais (seleção por PIN). O segundo fator prova a
  CONTA, não a pessoa.
- **Bypass de impersonação** na plataforma (suporte): o financeiro não pode herdá-lo.
- O **financeiro antigo** já tem gate próprio (`middlewares/financeiro.js`): módulo na empresa e na unidade, concessão
  explícita do perfil, sem bypass de impersonação, sem acesso do perfil de exibição; concessões administradas pelo
  SuperAdmin **sem MFA específico** (decisão de 20/10) atrás de `FINANCEIRO_CONCESSOES_HABILITADAS`. O v2 **não** lê
  nem herda nada disso.

## 2. Contrato do adaptador de identidade (Fase B)

Implementado em `backend/src/modules/financeiro-v2/integracao/plataforma.js` (puro: sem HTTP, banco, ambiente ou
financeiro antigo; portas injetadas). Entrada: `{ user, tenant, acesso }` = exatamente `req.user`, `req.tenant`,
`req.acesso` depois de `requireAuth` + `requireContexto` (teste "contrato" confere esses campos no código da plataforma).

**Recusas (falha fechada, motivo estável em `detalhes.motivo`):** sessão ausente/incompleta, expirada (sem
`expiraEm` = expirada), conta inativa, senha provisória, **impersonação**, perfil de exibição, sem pessoa operacional,
"todas as unidades", contexto divergente (org/unidade de `tenant` ≠ `acesso`), **conta compartilhada** (> 1 pessoa
ativa na conta), empresa ou unidade **não liberada**, unidade fora dos vínculos da pessoa na plataforma, **sem
concessão** do v2, MFA não comprovado em ação sensível, qualquer falha de leitura.

**Saída:** `contexto` do núcleo (`organizacaoId`, `unidadeId`, **`usuarioId` = pessoa operacional**, permissões só da
concessão do v2), `ator` (`perfilId`, `contaId`), `unidadesDaPessoa`, `autenticacao` (`aal`, `mfaRecente`), `origem`
(`PLATAFORMA`, `sessaoId`, `expiraEm`). Nada fica em cache: `contexto()` é chamado a cada operação.

**Portas que a plataforma precisará implementar (no servidor, nunca no navegador):**

| Porta | Método | Fonte futura |
|---|---|---|
| `liberacoes` | `consultar({organizacaoId, unidadeId}) → {empresa, unidade}` | Tabela NOVA de liberação do v2 por empresa/unidade (não o módulo `gestao_financeira`) |
| `vinculos` | `unidadesDoPerfil({perfilId, organizacaoId})`, `perfisAtivosDaConta({contaId})` | Mesma regra de `acessoEfetivoDaUnidade` / `perfis_operacionais` |
| `concessoes` | `listar({organizacaoId, usuarioId})` | Concessões do v2 (`criarConcessoesDoRepositorio`, banco financeiro) |
| `administracao` (provisionamento) | `autoridadeSobre({contaId, organizacaoId, unidadeId})`, `contaDoPerfil({perfilId})` | Vínculo `organization_admin` / `plataforma_admins` |

**Ações com MFA recente (proposta):** `conceder`, `revogar`, `homologar`, `reabrir`. As demais exigem só a sessão
válida + concessão. Depende de a plataforma ter MFA cadastrado e verificável (§ 11).

## 3. Navegação (Fase C)

Preparado em `frontend/src/financeiroV2Encaixe.js` (puro, **não importado** — teste garante que o menu publicado não muda):
- o **mesmo** item "Dashboard Financeiro"; o status do servidor ganha (no futuro) `financeiroV2: { liberado, disponivel, operavel, motivo }`;
- `liberado: false` (ou bloco ausente) → **tudo como hoje** (legado / 2.0 / negado / erro);
- `liberado: true` → o v2 **substitui** o menu (sete áreas, itens `fv2-*`, nenhum duplicado, nada do antigo); sem
  pessoa válida ou sem concessão → acesso negado ao v2, **nunca** o legado (não há dois financeiros para a mesma unidade);
- bloco malformado → erro (nunca v2 nem legado);
- unidade = a da plataforma; troca de unidade descarta respostas atrasadas (`chaveDoContexto`/`respostaVale`, além do
  mecanismo existente `geracaoContexto`);
- a interface própria do v2 (`frontend/financeiro-v2`) será carregada dentro do shell em `#/financeiro-v2/<área>`, sem
  login próprio (o login sintético `/entrar` é só da homologação).

**Liberação por empresa e unidade:** controla a disponibilidade da interface; **não** concede nada (a concessão
individual continua obrigatória). Ativar/desativar vale na operação seguinte (testado).

## 4. Permissões

- `financeiro_v2.*` só por concessão explícita do v2, por **pessoa operacional** e unidade. Papel da plataforma
  (inclusive `finance` e `organization_admin`), SuperAdmin, Painel Administrativo, módulos e concessões do financeiro
  antigo **não** concedem nada (testado).
- Revogação no v2 vale na operação seguinte; revogação/expiração/troca na plataforma derruba a sessão de contexto e,
  com ela, o acesso.
- Impersonação e perfil de exibição: sem acesso (sem o bypass de suporte da plataforma).
- Conta compartilhada: sem acesso por padrão (`permitirContaCompartilhada: false`) — **decisão pendente** (§ 13).

## 5. Gateway de autoridade (Fase D) — desenho

O banco do v2 só aceita sessões emitidas por `fv2_autoridade` (07B). Hoje, na homologação, essa autoridade vive num
processo separado (`scripts/fv2/gatewayTeste.mjs`) com credencial própria (`gateway.json`); o serviço da aplicação só
tem `aplicacao.json` (teste "13" confere que `iniciar` só lê esse arquivo e não conhece `urlAutoridade`).

| Requisito | Desenho para produção |
|---|---|
| Credenciais separadas | Papel PostgreSQL `fv2_autoridade` com senha/certificado **só** no gateway; o serviço comum usa `fv2_app`. Nunca no frontend, nunca no mesmo cofre de segredos do backend comum |
| Identidade validada | O gateway recebe do backend a sessão da plataforma **já validada** por um canal autenticado (mTLS ou token de serviço assinado, rotacionável) e REVALIDA o access token no provedor de identidade antes de emitir |
| Emissão | `fv2_abrir_sessao(pessoa, unidade, …)`: token opaco, só o hash guardado; exige concessão ativa no banco |
| Escopo | Uma sessão de banco por pessoa × unidade; RLS por unidade e por ação (0012/0013) |
| Expiração | Curta (minutos), menor que a sessão de contexto; nunca renovada sem nova validação |
| Revogação | `fv2_encerrar_sessoes` chamado em logout, troca de unidade, revogação da concessão e bloqueio da empresa |
| Auditoria | Eventos sem token e sem senha (formato já testado no gateway sintético) |
| Rotação | Credencial do gateway e chave do canal backend→gateway com rotação programada e procedimento de emergência |
| Falha segura | Gateway fora do ar = financeiro indisponível (nunca fallback para credencial do serviço) |

**Não criado nesta execução:** gateway real, credencial real, canal backend→gateway. O gateway sintético continua
válido só para homologação.

## 6. Administrador financeiro inicial (Fase E)

`criarAutoridadeDaPlataforma` (porta `autoridade` do núcleo) atesta o administrador inicial de uma unidade:
- atestante autenticado (sessão verificada no servidor), **sem impersonação**, com **MFA recente** (aal2 + fator ≤ 10 min);
- autoridade administrativa **comprovada** sobre a empresa/unidade (padrão: só `ADMIN_EMPRESA`; `SUPERADMIN` só se
  explicitamente aceito — ser SuperAdmin **não** dá acesso a dados financeiros);
- justificativa (≥ 20 caracteres) e evidência; pessoa indicada com acesso à unidade na plataforma e conta pessoal;
- **não provisiona a si mesmo nem outra pessoa da própria conta**; o atestante **não recebe** acesso algum (testado).
O núcleo continua exigindo autoridade configurada (sem ela, nada acontece) e grava autoria e histórico; o banco confere
de novo o nível `aal2` (07B).

**Bloqueio:** MFA da plataforma está dormente e a unidade do `amr[].timestamp` não foi confirmada contra JWT real.
Sem isso, o provisionamento real não pode ser liberado (o contrato e a interface ficam prontos; nenhum acesso real).

## 7. Matriz das pendências (Fase F)

Ver [22a-matriz-pendencias.md](22a-matriz-pendencias.md): 24 tipos de pendência + 7 impedimentos (+ a verificação de saída sem vínculo no banco), com natureza, fonte, impacto na DRE, no caixa e nos títulos,
forma de resolver, se pode ser ressalva, quando bloqueia, evidências, autorizações, regra e testes. Marcada como
**não aprovada pela empresa**. Teste `matriz-pendencias` amarra o documento ao código.

**Correção feita na revisão:** `TAXA_OU_VALOR_DIVERGENTE` era ressalvável ("efeito conhecido"), mas crédito do
processador menor que o esperado deixa taxa/perda fora da DRE e **superestima** o resultado — contrário ao princípio
da 08E. Passou a bloquear; o caminho certo é registrar o ajuste da taxa com documento (teste "7, 8" ajustado para isso).

## 8. Baixa bancária com saída anterior à obrigação (Fase G)

Sem bloqueio absoluto por data. Quando a saída é anterior à **emissão** da conta:
- a prévia mostra **alerta** (dias de antecedência, beneficiário da conta) e passa a exigir documento;
- a confirmação exige **identificação explícita** de pagamento antecipado (caixa na tela), **documento compatível**
  (comprovante, contrato, nota fiscal ou boleto — conciliação ou valor parecido não bastam) e **justificativa ≥ 30
  caracteres** (beneficiário, motivo, conferência do valor);
- a liquidação grava `antecipacao` (dias, datas, quem identificou, tipo do documento) e o histórico marca
  "[Pagamento antecipado …]"; marcar como antecipado o que não é anterior é recusado;
- **banco (0020, FV041):** liquidação de vínculo de extrato com saída anterior à emissão só entra com a marca coerente
  com as datas reais e documento de tipo compatível;
- testado: parcial, agrupado (uma conta antecipada e outra normal) e entre competências (saída de setembro, conta de
  outubro); nenhuma saída nem despesa nova. A conferência da **contraparte** é humana e registrada (a movimentação não
  traz beneficiário): a tela mostra o beneficiário da conta ao lado da saída e a confirmação declara a conferência.
- Demonstração: a conta de energia sintética passou a ser emitida em 20/10 (antes: 01/11, depois do pagamento de 28/10).

## 9. Acessibilidade (Fase H)

| Verificação | Resultado | Evidência |
|---|---|---|
| Contraste (WCAG AA) dos componentes críticos, tema claro e escuro | **PASS após correção** — antes: link/botão primário/navegação ativa 4,08:1 e selo "ok" 3,86:1; agora ≥ 5,2:1 | `frontend/test/financeiroV2Contraste.test.js` (mede os tokens reais de `fv2.css`) |
| Auditor automático (rótulos, papéis, nomes) nos painéis novos (prévia antecipada, encaixe) | PASS | `financeiroV2Encaixe.test.js`, `financeiroV2BaixaFechamento.test.js` |
| Teclado (Tab → Enter → Escape, foco volta à origem), modais `role="dialog"` + `aria-modal` | PASS na 08E (navegador real) | doc 21 § 8 |
| Alertas (`role="alert"`) e resultados (`role="status"`, `aria-live`) | PASS no auditor | idem |
| Tabelas com rótulo por célula no celular | PASS (08D/08E, 390 px sem rolagem horizontal) | doc 20/21 |
| **Leitor de tela real** | **NÃO TESTADO** — NVDA não instalado; o Narrador existe, mas sua fala não pode ser capturada de forma verificável aqui | roteiro abaixo |
| Contraste de foco visível, estados de hover e gráficos | **NÃO TESTADO** (fora do medidor de tokens) | — |

**Roteiro de validação humana (leitor de tela, NVDA ou Narrador):**
1. Entrar, abrir Contas a Pagar; navegar pela tabela com as setas de tabela; conferir que cada célula anuncia o rótulo da coluna.
2. Abrir "Detalhar" (Enter): o foco vai para "Fechar"; o título do painel é anunciado.
3. Escolher uma saída anterior à emissão e "Ver prévia": o alerta "Atenção — saída anterior à emissão" é anunciado sem mover o foco.
4. Tentar confirmar sem marcar "pagamento antecipado": o navegador anuncia o campo obrigatório.
5. Confirmar: o resultado (`role="status"`) é anunciado.
6. Central → Fechamento: a lista "O que impede homologar" é lida em ordem; botões indisponíveis anunciam o motivo (`aria-describedby`).
7. Escape fecha o painel e o foco volta ao botão de origem.
Registrar para cada passo: anunciado corretamente / incompleto / ausente.

## 10. Desempenho (Fase H)

Sem refatoração nesta execução (otimizações da 08D preservadas). Medição repetida com o gerador da 08D
(`node scripts/fv2-desempenho.mjs <meses> 200`, PostgreSQL isolado, dados sintéticos, este computador — observações,
não metas). Dados dobrando de 3 para 6 meses (600 → 1.200 vendas; 810 → 1.620 lançamentos):

| Tela | 3 meses (ms) | 6 meses (ms) | Crescimento |
|---|---|---|---|
| Apuração / DRE (mês) | 26 | 34 | 1,31× |
| Visão Geral | 63 | 112 | **1,78×** |
| Composição de indicador | 25 | 33 | 1,32× |
| Contas a pagar (página) | 12 | 17 | 1,42× |
| Contas a receber (página) | 30 | 65 | **2,17×** |
| Caixa e bancos (mês) | 32 | 64 | **2,00×** |
| Vendas (página) | 102 | 132 | 1,29× |
| Central de Conferências | 103 | 133 | 1,29× |
| Pendências (página) | 107 | 129 | 1,21× |
| Fechamento (situação) | 122 | 152 | 1,25× |
| Prévia de homologação | 106 | 132 | 1,25× |
| 10 apurações simultâneas | 254 | 295 | 1,16× |
| 10 telas simultâneas | 385 | 498 | 1,29× |

- Equivalência carga dirigida × completa: **IDÊNTICO** nos 6 meses.
- **Gargalo remanescente (já conhecido na 08D):** as telas de POSIÇÃO (Contas a Receber, Caixa e Bancos, Visão Geral)
  crescem quase linearmente com o histórico, porque saldo e posição dependem de todo o passado. Caminho investigado,
  **não implementado** (exigiria mudar o modelo, fora do escopo): saldos de referência por conta/mês persistidos no
  fechamento (âncoras) para começar o cálculo da última âncora conferida, sem mudar nenhuma fórmula.
- O gerador registrou recusas de fechamento em todos os meses: são a regra da 08E/09 funcionando (o gerador cria saídas
  sem classificação de propósito e tenta "com pendências documentadas", agora recusado com 45 bloqueantes). O gerador
  ainda trata isso como "não esperado" porque é anterior à 08E — atualizá-lo é pendência de ferramenta, não de regra.

## 11. Infraestrutura futura (Fase I)

| Item | Já existe | Precisa ser contratado / criado / configurado |
|---|---|---|
| Banco PostgreSQL financeiro | Só o cluster **local descartável** (PG 17, 127.0.0.1) | Instância gerenciada dedicada (separada do Supabase atual ou projeto próprio), com papéis `fv2_dono`, `fv2_app`, `fv2_autoridade`, `fv2_guardiao`; validar extensões e `pg_current_xact_id` |
| Migrações 0001–0020 | Aplicadas e testadas só no isolado; hash conferido por `fv2_migracao` | Procedimento de aplicação em homologação real e produção (com dono, sem superusuário na aplicação), ensaio de reversão |
| Isolamento org/unidade | RLS por unidade + autorização por ação + sessão de banco (07B/08) | Revalidar no ambiente gerenciado (RLS do provedor, `search_path`, papéis) |
| Gateway de autoridade | Sintético (processo local) | Serviço separado, credencial própria, canal autenticado, rotação, monitoramento (§ 5) |
| Serviço da aplicação | Servidor de homologação local | Rotas do v2 no backend da plataforma (atrás de `requireAuth` + `requireContexto` + adaptador), CSP, CSRF |
| Cofre documental | Disco local com hash (`criarCofreDisco`) | Armazenamento de objetos privado, criptografia em repouso, URLs assinadas curtas ou entrega pelo serviço, integridade por sha256 |
| Antimalware | **Não existe** | Varredura dos arquivos enviados antes de liberar o documento (quarentena) |
| Backup e restauração | Ensaio local com `pg_dump`/restore (08) e cofre | Backup gerenciado com PITR, restauração testada periodicamente, backup do cofre sincronizado com o banco |
| Logs sem segredos | Gateway sintético registra sem token/senha (testado) | Política de logs no ambiente real; mascaramento; retenção |
| Monitoramento | — | Disponibilidade do gateway e do banco, erros FV0xx, filas, tempos das telas |
| Estatísticas PostgreSQL | `ANALYZE` exigido após carga (08C/08D) | Autovacuum/ANALYZE configurados; rotina pós-importação grande |
| Disponibilidade | — | Meta acordada; financeiro indisponível ≠ dado errado (falha fechada) |
| Reversão de ativação | Liberação por unidade (desligar = volta ao financeiro atual, testado no encaixe) | Tabela de liberação real + procedimento documentado |
| Retenção documental | — | Política (prazo legal/fiscal), descarte auditado; hoje não há exclusão física no módulo |

## 12. Testes (Fase J)

| Suíte | `3acb9a8` (08E) | Final 09 |
|---|---|---|
| Núcleo em memória (`node --test test/financeiro-v2/*.test.js`) | 348/348 | **367/367** |
| Núcleo em PostgreSQL isolado (`FV2_REPOSITORIO=postgres`) | 348/348 | **367/367** |
| Só em memória, sem banco (condição equivalente; `3acb9a8` num worktree temporário) | 289 aprovados, 59 pulados, 0 falhas | **307 aprovados, 60 pulados, 0 falhas** |
| Modo de conferência da carga (`FV2_CONFERIR_CARGA=1`, sem banco) | — | **307 aprovados, 60 pulados, 0 falhas** |
| Frontend (`node --test test/`) | 1949 aprovados, 26 pulados | **1956 aprovados, 0 falhas, 26 pulados** |
| Mutação das regras da 09 | — | **15/15 detectados** |

Comparação por nome: os 348 testes de `3acb9a8` continuam presentes e nenhum passou a falhar ou a ser pulado. Um teste
antigo foi **ajustado** por mudança de regra (não afrouxada): "7, 8" (taxa divergente agora exige registrar a taxa).

**Os 25 itens pedidos:**

| # | Item | Onde |
|---|---|---|
| 1 | Sessão válida | `integracao-plataforma` "1, 9" |
| 2 | Sessão expirada | "2, 23" |
| 3 | Sem acesso financeiro | "3, 4, 5, 24" |
| 4 | Empresa sem liberação | "3, 4, 5, 24" |
| 5 | Unidade sem liberação | "3, 4, 5, 24" |
| 6 | Troca de unidade | "6, 7" (backend) e `financeiroV2Encaixe` "6" (respostas atrasadas) |
| 7 | Contexto adulterado | "6, 7" |
| 8 | Revogação | "8" |
| 9 | Papel antigo sem concessão | "1, 9" |
| 10 | MFA não comprovado | "10" |
| 11 | Provisionamento | "11, 12" (autoridade da plataforma → núcleo) |
| 12 | Autoconcessão recusada | "12" |
| 13 | Isolamento do gateway | "13" |
| 14 | Menu sem duplicidade | `financeiroV2Encaixe` "14, 24" |
| 15 | Financeiro antigo preservado | `financeiroV2Encaixe` "15" e "não ativado" |
| 16 | Baixa anterior à obrigação | `fechamento-ressalvas-baixa` "16, 17", "16" e "banco — 0020"; `financeiroV2Encaixe` "16, 17" (tela) |
| 17 | Evidência de pagamento antecipado | idem + "17" (agrupado, parcial, entre competências) |
| 18 | Pendência bloqueante | `matriz-pendencias`; `fechamento-ressalvas-baixa` "4, 8" |
| 19 | Pendência admissível | `matriz-pendencias`; "3, 6, 7" |
| 20 | Homologação com ressalvas | "3, 6, 7" (08E, preservado) |
| 21 | Coerência da DRE | baixa antecipada sem nova despesa/saída ("16, 17"); "9, 10, 11, 12, 24, 25" (08E) |
| 22 | Isolamento PostgreSQL | `isolamento-autorizacao`, barreiras 0018–0020 (suíte PG) |
| 23 | Falha segura de autenticação | "2, 23" (leitura que falha = nada liberado) |
| 24 | Ativação/desativação por unidade | "3, 4, 5, 24"; `financeiroV2Encaixe` "14, 24" |
| 25 | Ausência de acesso a produção | "25"; `isolamento-estatico` |

**Mutações (15/15):** impersonação aceita; conta compartilhada aceita; liberação ignorada; MFA recente não exigido;
papel da plataforma concedendo tudo; autoconcessão; contexto divergente aceito; sessão expirada aceita; antecipada sem
identificação, só com conciliação ou com documento incompatível; barreira 0020 desligada (banco); taxa divergente de
volta a ressalva; encaixe somando o v2 ao menu antigo; encaixe caindo no legado sem concessão.

Testes de integração local com identidades sintéticas: o adaptador e a autoridade foram exercitados contra o núcleo real
(memória e PostgreSQL isolado). As rotas reais da plataforma **não** foram ligadas (não há rota publicada), então não há
teste HTTP da plataforma com o v2 — isso é da próxima etapa.

## 13. Dependências externas e bloqueios

1. **MFA verificável:** ligar e cadastrar MFA para quem vai atestar/homologar; confirmar a unidade de `amr[].timestamp`
   e o comportamento de `getUser` após `signOut` local num projeto descartável. Sem isso: provisionamento real e ações
   com MFA recente **bloqueados**.
2. **Decisão sobre conta compartilhada** (multi-perfil com PIN): manter recusada (recomendado) ou aceitar com regra própria.
3. **Validação da matriz** pelo responsável financeiro (22a), em especial crédito não identificado, transação sem
   pedido, conta sem comprovante e a correção de taxa divergente.
4. **Infraestrutura** do § 11 (banco gerenciado, gateway, cofre, antimalware, backup).
5. **Tabela de liberação** do v2 por empresa/unidade e o campo `financeiroV2` no status do Dashboard Financeiro.
6. Teste com **leitor de tela** por pessoa (roteiro § 9).
7. Amostras reais pendentes (iFood, Foody) — fora do escopo desta execução.

## 14. Plano de liberação futura, reversão e GO/NO-GO

**Liberação (cada passo só com autorização em palavras próprias):**
1. Infraestrutura de homologação real (banco, gateway, cofre) com dados sintéticos; repetir as jornadas.
2. Rotas do v2 no backend atrás de `requireAuth` + `requireContexto` + adaptador, sem liberação em nenhuma unidade.
3. Provisionar o administrador financeiro inicial de UMA unidade piloto (atestante com MFA).
4. Liberar a unidade piloto; operar em paralelo ao financeiro atual **sem** homologar competência real.
5. Primeira homologação real só depois da matriz validada e da conferência com o financeiro atual.

**Reversão:** desligar a liberação da unidade (o Dashboard Financeiro volta ao atual na operação seguinte); revogar
sessões de banco; nenhum dado do v2 é apagado; o financeiro antigo nunca é alterado pelo v2.

**GO para a próxima etapa (homologação em infraestrutura real com dados sintéticos)** se: § 13 itens 1 e 4 resolvidos
para o ambiente de homologação; matriz em validação; suítes verdes. **NO-GO para produção** enquanto § 13 itens 1–5
estiverem abertos.

## 15. Commits locais

| Commit | Conteúdo |
|---|---|
| `4448a2f` | Parte 1 — adaptador da plataforma, autoridade de provisionamento, baixa antecipada (0020), encaixe do menu (não ativado) |
| (este) | Parte 2 — matriz das pendências (22a) amarrada ao código e correção de `TAXA_OU_VALOR_DIVERGENTE`; contraste AA corrigido e testado; testes da matriz e de contraste; este documento |

Sem push, merge ou deploy.
