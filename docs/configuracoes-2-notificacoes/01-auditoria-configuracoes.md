# 01 — Auditoria da área Configurações

> Base: `origin/main` `9da8210` (Dashboard Operacional 2.0 já em produção). Somente leitura: nenhum código, banco ou configuração alterado.
> Evidências: arquivos citados com caminho; banco de produção consultado só por catálogo e contagens agregadas (30/10/2026).

## 1. Como a página funciona hoje

- **Arquivo único:** `frontend/src/configuracoes.js` (703 linhas), rota `configuracoes` (`frontend/src/router.js:103`), item "Configurações" da seção SISTEMA (`frontend/src/config.js:73`).
- **Rota nunca gateada por módulo.** É a rota de saída garantida (`router.js:47-54`).
- **Layout:**
  - grade de 8 cartões (`SECOES`, `configuracoes.js:137-146`) com emoji como ícone;
  - ao clicar, a grade é substituída por um painel com "← Configurações" (`abrirSecao`, `:174-186`).
  - Não há navegação lateral, URL própria por seção, indicação de pendências nem busca.
- **Multi-tenant:** toda seção parte de `state.sessao.empresa/unidade`. O backend resolve o tenant pelo Context Token e o frontend nunca envia `organizacao_id`/`unidade_id` (`configuracoes.js:1-17`). A troca de contexto limpa a tela (`registrarResetDeContexto`, `:696-703`).
- **Permissões** (`backend/src/shared/permissoes.js`):
  - `configuracoes.ver`: organization_admin, unit_manager e finance.
  - `configuracoes.gerenciar`: **só organization_admin**.
  - `usuarios.ver`: organization_admin e unit_manager.
  - `usuarios.gerenciar`: **só organization_admin**.

## 2. Inventário — o que existe na página

| # | Item | Localização | Estado | Persistência | Permissões | Problemas de UX | Dependências | Recomendação |
|---|---|---|---|---|---|---|---|---|
| 1 | **Dados da Unidade** (nome, CNPJ, endereço, cidade, UF, responsável, e-mail, telefone; status só leitura) | `configuracoes.js:189-243`; API `PATCH /api/v1/unidade/dados` (`backend/src/modules/unidade/unidade.routes.js:19-20`) | **Completa** | `unidades` (migration 057) | ver: `configuracoes.ver`; editar: `configuracoes.gerenciar` | sem validação de CNPJ/UF/e-mail no cliente; sem estado "alterado/não salvo"; salvar sem confirmação; telefone livre (não E.164) | topbar/seletor (evento `app:contexto-atualizado`) | **Manter** em "Unidade e empresa"; validar campos; barra de salvar com estado |
| 2 | **Metas e Limites de CMV** (CMV saudável/atenção, faturamento dia/mês, margem mínima) | `:246-300`; `PATCH /api/v1/unidade/metas-cmv` (`unidade.routes.js:23-24`) | **Completa** | `unidade_config` (058), com default do sistema | idem | sem explicação dos defaults; sem histórico de alteração na tela | Dashboard, Produtos/CMV (`cmvConfig.js`) | **Manter** em "Metas e operação" |
| 3 | **Tabelas Comerciais** (tabela oficial Balcão/iFood) | `:303-397`; `PATCH /api/v1/unidade/tabelas-comerciais` | **Completa** (alteração com aviso e motivo, auditada) | `unidades.tabela_balcao/tabela_ifood` | idem | fluxo bom; confirmação por texto, não por diálogo | Dashboard, Produtos/CMV; CTA do Dashboard iFood (`abrirSecaoConfiguracoes`) | **Manter** em "Metas e operação" ("Operação comercial") |
| 4 | **Usuários e Permissões** (lista, cargo por empresa, conceder acesso com senha, remover) | `:407-508`; `/api/v1/usuarios` (`usuarios.routes.js:15-19`) | **Parcial** | Supabase Auth + `usuarios_organizacoes`/`usuarios_unidades` | ver: `usuarios.ver`; gerenciar: `usuarios.gerenciar` | **o formulário "Conceder acesso", o seletor de cargo e a lixeira aparecem para quem só tem `usuarios.ver`** (unit_manager): não há `pode("usuarios.gerenciar")` na tela, e o servidor responde 403. A senha é digitada e exibida em campo `type="text"` e repassada manualmente. Remoção por `confirm()` nativo. Vínculos de unidade só leitura (cadeado), gerenciados no Painel ADM | sessões (`sessoes_contexto`), perfis/PIN (Painel ADM) | **Concluir**: esconder ações sem permissão; convite por e-mail/link em vez de senha definida pelo admin (**decisão**); diálogo próprio |
| 5 | **Segurança** (lista estática de proteções + 2FA da própria conta) | `:512-526` + `montarMfa` `:611-691`; `frontend/src/mfa.js` (Supabase Auth) | **Completa** para o 2FA próprio; a lista é **declarativa** | Supabase Auth (fatores) | qualquer usuário (própria conta) | a lista de proteções é texto fixo, não estado real; não mostra sessões ativas; exigência de MFA (`MFA_ENFORCE_*`) dormente | `middlewares/auth.js` | **Manter** em "Segurança e privacidade"; trocar lista fixa por estado real (2FA ativo, última troca de senha) |
| 6 | **Notificações** | `:528-539` | **Ausente** (placeholder "em preparação"; nada é salvo) | — | — | promete "estoque crítico, CMV alto, faturamento" que não existem | — | **Substituir** pela Central de Notificações (doc 04) |
| 7 | **Aparência** (tema claro/escuro) | `:541-565` | **Completa** | `localStorage` (`cd.tema`, migra `saci-tema`) | qualquer usuário | — | `tema.js` | **Manter** em "Preferências" |
| 8 | **Backup e Manutenção** (exporta/limpa o que está no navegador — hoje só o tema) | `:567-604` | **Completa, de baixo valor**. É honesta ("não exporta dados do banco") | `localStorage` | qualquer usuário | o nome "Backup" sugere backup de dados | — | **Reorganizar**: fundir em "Preferências deste dispositivo"; nada é removido |

## 3. Configurações espalhadas por outros módulos (existentes, reais)

| Item | Onde está | Estado | Persistência | Quem altera | Recomendação |
|---|---|---|---|---|---|
| **Metas de tempo do Checklist** (preparo/entrega/vida, versionadas) | Checklist Operacional → Dashboard (`api.js:470-473`, `PUT /checklist-operacional/metas`) | Completa | `checklist_metas` + histórico (127, 131) | `configuracoes.gerenciar` | **Manter no módulo**; atalho em "Metas e operação" (sem duplicar a tela) |
| **Modelo logístico iFood com vigência** | Dashboard iFood (`dashboardExecutivoModeloModal.js`) | Completa | `unidades.modelo_logistico_ifood` + vigência (089) | `dashboard_executivo.configurar` | Manter no módulo; atalho |
| **Metas e faixas da Bonificação** | Bonificação Mensal (`bonificacaoMensalMetasModal.js`) | Completa (versionada) | `bonificacao_metas*` | `bonificacao_mensal.configurar` (só org admin) | Manter no módulo; atalho |
| **Configurações Financeiras** (categorias, contas) | `frontend/src/financeiro/configuracoes.js` | Completa no domínio Financeiro | tabelas `fin_*`/`gestao_financeira_*` | permissões do Financeiro | Manter no Financeiro; atalho |
| **Conexão iFood** (OAuth por loja, multi-conexão) | página Integração iFood (`ifood.js`, 2.473 linhas) | Completa | `ifood_conexoes`, `ifood_credenciais`… (129 aplicada) | `integracoes.gerenciar` | Manter; mostrar **estado** em "Integrações" |
| **Catálogo de integrações** | página "Integrações" (`views.js:346`) | Completa (cartões) | backend `obterCatalogoIntegracoes` | `integracoes.ver` | Reaproveitar como "Integrações" em Configurações 2.0 |
| SWFast/PDV, Coca-Cola, Cláudia Hortifruti, Estoque, Distribuidoras, Relatórios | menu (`config.js:55-71`) | **Em construção** (`tipo: "construcao"`) | — | — | Não exibir em Configurações até existirem |
| **Dados da empresa e da unidade, status, módulos, acessos** | **Painel SuperAdmin** (`adminEmpresaDetalhe.js`, `adminUnidadeDetalhe.js`, wizards) | Completa (plataforma) | `organizacoes`, `unidades`, módulos | SuperAdmin | **Não trazer** para o cliente; mostrar só leitura em "Unidade e empresa" (ex.: módulos contratados) |
| **Dashboard iFood por unidade** ("considerar sanduíche…") | Painel SuperAdmin (`adminUnidadeDashboardIfood.js`) | Completa | config da unidade | SuperAdmin | Fica na plataforma |
| **Acesso Financeiro por unidade/usuário** | Painel SuperAdmin (`adminAcessoFinanceiro.js`) | Completa | — | SuperAdmin | Fica na plataforma |
| **Perfis operacionais e PIN** (multi-perfil) | Painel SuperAdmin (`adminViews.js`/`adminApi.js`) + seleção (`selecaoPerfil.js`) | Completa | `perfis_operacionais`, PIN (064/068) | SuperAdmin | Avaliar leitura em "Usuários e acesso" (**decisão**) |
| **Perfil de exibição (TV da loja)** | `perfilExibicao.js` + papel `display_operator` | Completo | vínculo de unidade | SuperAdmin | Fica na plataforma |
| **Destinatários de WhatsApp, categorias, envio automático, limites, pausa, fuso da empresa** | **Painel Administrativo** → Comunicação (`painelAdmEmpresaWhatsapp.js`, rotas `administrativo.routes.js:61-109`) | Completa **para a equipe Crescer**; **o cliente não tem acesso** | `comunicacao_contatos_empresa`, `comunicacao_habilitacoes`, `comunicacao_destinatario_categorias` | `requirePainelAdministrativo` | **Núcleo da Central de Notificações** (docs 02 e 04) |
| **Fuso horário / horário de funcionamento da unidade** | — | **Ausente**: `unidades` não tem fuso nem horário (catálogo de produção). Só a empresa tem fuso em `comunicacao_habilitacoes.timezone` (3 fusos em uso), e o Dashboard 2.0 usa o fuso da plataforma | — | — | **Concluir** em "Unidade e empresa" (resolve o "dia sem eventos = Incompleto" do Dashboard 2.0) |
| **Minha conta** (nome, troca de senha voluntária, sessões) | — | **Ausente**: só existe a troca de senha obrigatória do primeiro acesso | Supabase Auth | — | **Concluir** em "Segurança e privacidade" |
| **Privacidade** (consentimentos, retenção, LGPD) | — | **Ausente** (proposta de retenção do iFood em `docs/dashboard-operacional-2/03-retencao-anonimizacao.md`, não executada) | — | — | **Concluir** (doc 05) |

## 4. Problemas transversais

1. **Hierarquia visual antiga:**
   - cartões com emoji e grade única, sem navegação persistente;
   - não usa `icon()` (`icons.js`) nem os padrões do Dashboard 2.0 (abas com teclado, `aria-*`, estados de carga e erro padronizados).
2. **Permissão visível ≠ permissão real:**
   - a seção Usuários mostra ações que o servidor recusa;
   - o unit_manager vê Dados/Metas/Tabelas desabilitados sem saber por quê, até abrir a seção.
3. **Sem estado de salvamento:**
   - não há "alterações não salvas" nem proteção ao sair;
   - o botão só desabilita durante a gravação, e a resposta é um toast genérico.
4. **Confirmações nativas** (`confirm()`) em ações críticas (remover acesso, limpar local) em vez de diálogo acessível.
5. **Sem rota por seção:** recarregar volta à grade, e não dá para linkar "Configurações → Notificações" (o atalho do Dashboard iFood usa `abrirSecaoConfiguracoes`).
6. **Configuração crítica fora do alcance do cliente:** os destinatários de WhatsApp de 38 empresas com envio automático ligado só são administrados pela equipe Crescer (doc 02).
7. **Ausências estruturais:** fuso e horário da unidade, "minha conta" e privacidade.

## 5. Nada a remover

Nenhuma funcionalidade é candidata a remoção. "Backup e Manutenção" e "Aparência" são reorganizadas em "Preferências deste dispositivo". A Notificações-placeholder é substituída por uma funcionalidade real.
