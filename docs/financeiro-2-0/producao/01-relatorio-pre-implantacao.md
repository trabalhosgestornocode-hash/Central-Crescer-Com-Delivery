# 01 — Relatório de pré-implantação da migration 151 (Etapa 2 do GO de produção)

Data: 05/11/2026 · Branch local `feat/financeiro-2-0` (commit `de471fe` + docs), **sem push** · **Nada foi executado em produção.**

## 1. Projeto e banco de destino

| Item | Valor | Fonte |
|---|---|---|
| Projeto | **Crescer Com Delivery** — ref `uqybgauuxcrqzquultfu` | `list_projects` do conector Supabase (metadados da conta) |
| Região / motor | us-west-2 · PostgreSQL 17.6.1.141 | idem |
| Host | `db.uqybgauuxcrqzquultfu.supabase.co` (conexão direta, porta 5432, usuário `postgres`) | idem + doc 25 |
| Projeto de testes (recusado pelo script) | `teste-multiempresarial` — `wiqqsxnysbzhcrzrrean` | idem |
| Outros projetos da conta | `Atlaz Funil Imobiliário`, `mabruk-acai`: **não relacionados**, recusados por host | idem |

**Limite desta auditoria:** a leitura do catálogo de produção (consulta somente de catálogo) e a leitura dos arquivos `.env` foram **negadas pelo controle de permissões**. Não houve tentativa de contornar. Por isso:
- **não está confirmado** que a 120/121/122/126 estão aplicadas em produção. O registro de migrations do Supabase não as lista, porque foram aplicadas pelo operador via `prod-migrar.mjs`, que não grava nesse registro;
- **não está confirmado** que as funções compartilhadas em produção são idênticas às da 120.

As duas verificações viraram condições **automáticas** do preflight (§9). Se alguma falhar, o script recusa.

## 2. Alterações exatas da migration 151

`database/migrations/151_financeiro_2_contas_pagar.sql`, sha256 `b3b0cb48ba045b2d4c3d4281787c1b8521b0a029cab09ba8000c8b9281827ab8` (rollback: `2253b3e626e109a9f12c30b1f072ed60500223439be6acc07cee4552e010636c`; o script recusa qualquer outro arquivo). Transação única, `lock_timeout` de 5 s.

| Tipo | Objeto | Observação |
|---|---|---|
| CHECK alterado | `gestao_financeira_concessoes.nivel` | aceita também `contador` e `administrador` (as linhas existentes não mudam) |
| Tabelas novas (4) | `fin_fornecedores` (por empresa), `fin_obrigacoes`, `fin_pagamentos`, `fin_conciliacao_saidas` (por unidade) | RLS ligada, 0 policies, só SELECT/INSERT/UPDATE para o `service_role`, nada para anon/authenticated |
| Funções novas | 7 RPCs: quitar, desfazer quitação, classificar, confirmar registro, cancelar, confirmar e revogar conciliação. Auxiliares: `fin2_travar_meses`, `fin2_obter_obrigacao_para_alterar`, `fin2_bloqueios_fechamento`, tolerâncias | nenhuma SECURITY DEFINER; EXECUTE só para o `service_role` |
| Gatilhos novos nas tabelas novas | escopo, auditoria, `updated_at`, guardas e trava de período | — |
| Gatilho novo em tabela EXISTENTE | `trg_fin2_lancamentos_vinculo_saida` em `fin_lancamentos` | só recusa mudar valor, conta, data, sentido, status ou virar transferência/saldo anterior **numa saída vinculada a pagamento**. Saídas sem vínculo: comportamento idêntico |
| Gatilho novo em tabela EXISTENTE | `trg_fin2_periodos_bloqueia_fechamento` em `fin_periodos` | só age na passagem para `fechado` e só bloqueia por divergências dos dados da 151. Sem dados da 151 o conjunto é vazio |
| Funções compartilhadas redefinidas (2) | `gestao_financeira_tabelas_da_unidade()` e `gestao_financeira_verificar_unidade_transferivel(uuid)` | corpo da 120 + as 3 tabelas novas + rótulos + `coalesce` (corrige o achado de que a guarda deixava passar a transferência quando faltava rótulo). O rollback restaura o texto literal da 120 |

**Não há** DML sobre dados existentes, DROP, nem mudança em tabelas de outros módulos.

## 3. Dependências identificadas

- **Do banco:** 120 (concessões, guarda de transferência), 121 (`fin_lancamentos`, `fin_contas`, `fin_plano_contas`, `fin_auditoria`, `fin_validar_escopo`, `fin_auditar`), 122 (`fin_periodos`, `fin_periodo_travar_e_checar`, `fin_guarda_periodo_data`, `fin_fechar_periodo`), 126 (regra de concessão). Nenhuma migration de 123 a 150 redefine as funções compartilhadas.
- **Do código:** backend com o flag `FINANCEIRO_2_ORGANIZACOES` vazio funciona com ou sem a 151 (provas E40–E42 e `financeiro2FlagPreFechamento.test.js`).
- **Transferência de lojas** (`remapear_organizacao_em_tabelas_de_unidade`, da 054 substituída pela 120): a suíte real de 73 provas dá o mesmo resultado sem e com a 151 (74 com a prova de aplicação).

## 4. Resultado da revisão independente

Feita por um revisor separado, sem acesso ao raciocínio do autor, com provas próprias no cluster local.

| Passada | Veredito | Achados |
|---|---|---|
| 1ª | APROVADO COM RESSALVAS | 1 ALTO (a mesma saída podia ser conciliada acima do valor), 4 MÉDIOS (estados irrecuperáveis; ordem de implantação; pagamento de operador sem confirmação), 8 BAIXOS, INFOs |
| 2ª (após correções) | APROVADO COM RESSALVAS | 13 de 14 resolvidos; #3 parcial; regressão nova N1 (MÉDIO); N2 (BAIXO); N3 (INFO) |
| Correções finais (`de471fe`) | — | #3 (redução de valor) e N1 corrigidos com provas H11–H13. **Não houve uma 3ª passada do revisor sobre esse último commit.** |

Itens aceitos e documentados, sem correção de código:
- N2: desligar o flag de uma empresa que já tem dados trava o fechamento dela (regra operacional no plano, §4);
- N3: pagamento dividido em várias saídas, registrar como dois pagamentos;
- cancelar um pagamento duplicado depois do fechamento do mês do pagamento original é recusado, e a diferença fica como acréscimo a classificar como "outro";
- as flags `fin2.*` não defendem contra SQL bruto como `service_role` (mesmo limite documentado da 122).

## 5. Resultado dos testes

| Suíte | Resultado | Evidência (`docs/financeiro-2-0/implementacao/evidencias/`) |
|---|---|---|
| Provas PG da 151 (inclui as provas de cada achado da revisão) | **136 / 0** | `pg-151-provas.txt` |
| Suíte PG existente (120/121/122/126, concorrência real) **com a 151** | **todas OK** | `pg-suite-existente-com-151.txt` |
| Transferência/promoção de lojas, cadeia real da `origin/main` + 151 | **74 / 0** | `transferencia-lojas-com-151.txt` |
| Ensaio do script de produção | **14 / 0** | `ensaio-producao-151.txt` |
| Ensaio de recuperação de dados | **7 / 0** | `ensaio-recuperacao-151.txt` |
| E2E HTTP (gate → rotas → serviços → banco), inclui flag | **53 / 0** | `e2e-http.txt` |
| Navegador (5 perfis, celular escuro, flag desligado) | **34 / 0** | `qa-navegador.txt` |
| Frontend | **1.663 / 0** | `frontend-suite.txt` |
| Backend completo | 6.391 testes: 6.349 pass, **16 fail**, 1 cancelado, 25 pulados | ver abaixo |

**As 16 falhas do backend (item 5 do GO):** nenhuma toca o Financeiro.

| Arquivo | Causa verificada |
|---|---|
| `central-conversas` (8) e `central-visao-historico` (3) | **testes dependentes do calendário**: fixam `AGORA = 24/09/2026` e o serviço usa o relógio real com janela de dias. Com o relógio do processo fixado em 24/09/2026 passam **30/30 e 18/18** |
| `performance-calc` (1) e `sessao-perfil` (2) | já conhecidas na `main`: regra de negócio pendente e necessidade de Supabase T3 (`fetch failed`) |
| `checklist-operacional-service` (1) | todos os 17 subtestes passam; o arquivo não encerra (recurso aberto) e estoura o tempo |
| `dashboard-executivo-metas-dinamicas`, `parser-food-delivery-periodo` (quando aparecem) | queda intermitente do Node no Windows, código **0xC0000005**; isolados, passam **3/3** |
| `whatsapp-retry-*` | ambiente: com o `node_modules` do gateway disponível, passam **14/14 e 14/14** |

A mesma lista dá o **mesmo resultado numa cópia limpa da `origin/main`** (93 pass / 16 fail / 1 cancelado nos dois lados).

## 6. Garantias de isolamento

- **Entre empresas e unidades:** gatilhos conferem o tenant de fornecedor, categoria, conta, obrigação, pagamento e saída; as RPCs filtram empresa + unidade; o contexto vem só do gate; a organização e a unidade enviadas no corpo da requisição são ignoradas (provas PG I01–I08, E2E E09–E11c).
- **Dos clientes:** o flag começa vazio, as rotas novas respondem 404 (E40) e o menu fica oculto (N28/N29). O financeiro anterior funciona igual com o flag desligado (E41/E42, N29).
- **QA:** organização própria criada pelo fluxo da plataforma; flag só para ela; o passo `isolamento` precisa contar **0** registros da 151 fora dela.
- **Dados existentes:** o script compara o md5 do conteúdo de toda tabela financeira e de plataforma antes e depois. Qualquer diferença vira "DIVERGÊNCIA" (ensaio E06).

## 7. Situação dos backups

- **PITR/backup do Supabase: NÃO VERIFICADO por mim.** Não tenho acesso ao painel nem ao catálogo de produção. É o passo 2 do plano, de responsabilidade do operador: conferir e **anotar o horário**. O script exige `PROD_BACKUP_CONFIRMADO=SIM`.
- **Exportação lógica dos dados financeiros:** o procedimento foi ensaiado (7/7: conteúdo idêntico por md5, travas preservadas, auditoria sem duplicar). Ressalva: no ensaio a restauração rodou como superusuário; no Supabase precisa ser ensaiada no projeto de testes.

## 8. Riscos residuais

| # | Risco | Mitigação |
|---|---|---|
| 1 | Estado de produção desconhecido para mim (120–126 e funções compartilhadas) | o preflight recusa automaticamente qualquer divergência |
| 2 | O último commit (correções da 2ª passada) não teve 3ª passada do revisor | as provas H11–H13 reproduzem os cenários do revisor; recomenda-se uma 3ª passada curta |
| 3 | A 151 troca o corpo de duas funções compartilhadas da transferência de lojas | texto comparado com o da 120 pelo revisor; suíte real de transferência idêntica; o rollback restaura o texto literal |
| 4 | Gatilhos novos em `fin_lancamentos` e `fin_periodos` (tabelas em uso) | só agem sobre dados da 151; suíte existente e E2E do financeiro anterior verdes |
| 5 | Desligar o flag de uma empresa com dados trava o fechamento dela | regra operacional (plano §4); nesta etapa só a QA terá dados |
| 6 | Restauração lógica não ensaiada no Supabase | o PITR é o caminho primário; ensaiar no projeto de testes |
| 7 | `CREATE TRIGGER` em `fin_lancamentos`/`fin_periodos` pede trava exclusiva rápida | `lock_timeout` de 5 s; o preflight recusa com travas aguardando ou transações longas; janela de pouco uso |
| 8 | Promoção de unidade já quebrada na `main` (42P10, defeito pré-existente) | não relacionado à 151; segue registrado |

## 9. Procedimento de recuperação

Ver o plano `02-plano-implantacao-reversao.md`, §5–§6. Em resumo:
- **R1:** esvaziar o flag, sem perda.
- **R2:** reverter o código.
- **R3:** expurgo restrito à QA, mantendo a auditoria. O script ainda **precisa ser escrito e revisado**.
- **R4:** `reverter`, que recusa se houver dados ou concessões com os níveis novos (inclusive revogadas). Só existe **antes** de a homologação conceder `contador`/`administrador`; depois disso a reversão é esvaziar o flag (doc 02 §5).
- **R5:** dados, por exportação lógica ou, em último caso, PITR. O PITR volta o banco **inteiro** e descarta as gravações de todas as empresas depois do horário escolhido.

## 10. Recomendação

### **GO condicionado** para aplicar a 151 em produção

Condições, todas obrigatórias e na ordem do plano:
1. sua aprovação deste relatório, escrita com suas palavras;
2. backup/PITR conferido por você no painel, com horário anotado;
3. exportação lógica feita e conferida (todas as tabelas no dump);
4. **preflight com "PREFLIGHT: OK"**. Isso confirma automaticamente o que eu não pude ler: 120–126 presentes e funções compartilhadas idênticas às da 120. Qualquer "NÃO APLICAR" transforma esta recomendação em **NO-GO**.

Recomendado, mas não bloqueante: uma 3ª passada curta do revisor sobre o commit `de471fe`.

### **NO-GO** para
- ligar o flag para qualquer empresa que não seja a de QA;
- publicar a interface para clientes;
- migrar dados reais do Açaí no Grau nesta etapa.

Pendências contábeis seguem registradas e abertas: **INC-012** (taxas Stone), **INC-013** (metodologia da DRE) e **INC-014** (diferenças na folha).
