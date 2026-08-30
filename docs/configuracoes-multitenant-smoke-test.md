# Smoke test — Reforma multi-tenant das Configurações

Branch `feature/configuracoes-multitenant`. Executar **manualmente** contra um
ambiente com **duas empresas reais** (nenhuma delas a "Modelo Padrão").
Requer as migrations **057** e **058** aplicadas no ambiente onde o teste roda.

Preencher `[ ]` → `[x]` e anotar o que divergir.

Legenda das empresas/unidades usadas neste roteiro:

| Rótulo | O que é |
|---|---|
| **Empresa A** | qualquer empresa real com **2+ unidades ativas** |
| **A1**, **A2** | duas unidades da Empresa A |
| **Empresa B** | outra empresa real, distinta de A |

---

## 1. Pré-condições

- [ ] Migrations 057 e 058 aplicadas no ambiente de teste (SQL Editor).
- [ ] `select responsavel, email from unidades limit 1;` não dá erro.
- [ ] `select * from unidade_config limit 1;` não dá erro.
- [ ] Login como um usuário `organization_admin` da Empresa A.
- [ ] Login separado (ou o mesmo usuário, se tiver vínculo) para a Empresa B.

---

## 2. Empresa A / Unidade A1 — leitura

Entrar na Empresa A, selecionar a unidade **A1**. Abrir **Configurações**.

- [ ] O subtítulo mostra **`Empresa A · A1`** (nomes reais). **Nunca "Subway Saci".**
- [ ] **Dados da Unidade** abre com os dados reais de A1 (nome, CNPJ, endereço,
      responsável, e-mail, telefone). O e-mail é o da loja — **não** o e-mail do
      usuário logado.
- [ ] O **Status da unidade** aparece como texto/badge (🟢 Ativa / ⚪ Inativa),
      **sem** `<select>` editável, com a nota "alterado apenas por um Administrador
      da plataforma".
- [ ] **Metas e Limites de CMV** abre. Se A1 nunca teve config → mostra 32 / 40
      com o aviso "ainda usando os valores padrão do sistema". Se já teve →
      mostra os valores salvos.
- [ ] **Tabelas Comerciais** mostra a tabela oficial atual de A1 (balcão e iFood).
- [ ] Clicar em **Alterar** numa tabela → o `<select>` "Nova tabela" lista **só**
      tabelas que a Empresa A tem preço cadastrado (nunca "AERO A" se a Empresa A
      não usa "AERO A"). Se a empresa não tem preço nenhum → estado neutro
      "não tem nenhuma tabela de preço cadastrada".
- [ ] **Usuários e Permissões** lista os usuários com acesso à Empresa A.
      Usuário com acesso **só por unidade** aparece com badge "Só por unidade",
      cargo read-only e 🔒 no lugar do 🗑️.
- [ ] **Segurança** lista só proteções reais (senha mín. 8, troca no 1º acesso,
      etc.) — **sem** toggles.
- [ ] **Notificações** mostra "Recurso ainda não configurado".
- [ ] **Backup** está rotulado "configurações locais deste navegador".

---

## 3. Empresa A / Unidade A1 — escrita + propagação

Em **Dados da Unidade** de A1:

- [ ] Alterar o **nome** da unidade (ex.: acrescentar " ✎"), o **responsável** e o
      **telefone**. Salvar → toast "Dados da unidade salvos."
- [ ] **A topbar atualiza sem logout** — o chip de empresa/unidade passa a mostrar
      o nome novo.
- [ ] **O seletor de unidade (dropdown do topo) atualiza** — A1 aparece com o
      nome novo.
- [ ] Recarregar a página (F5) → o nome novo persiste; o contexto continua em
      Empresa A / A1.
- [ ] Abrir **Dados da Unidade** de **A2** (trocar unidade no seletor) → A2
      continua com **os dados originais**, intacta.
- [ ] Entrar na **Empresa B** → nenhum dado da Empresa A aparece; a unidade de B
      tem os próprios dados.
- [ ] (Opcional, painel SuperAdmin) Confirmar que a linha de A2 e as unidades de
      B não foram tocadas no banco.

---

## 4. Troca de contexto — nada vaza

- [ ] Empresa A / A1 → abrir Configurações, confirmar os valores.
- [ ] Trocar para **A2** pelo seletor global → abrir Configurações → **nenhum
      valor de A1 permanece** (nome, CMV, tabela, usuários — tudo de A2).
- [ ] Trocar para **Empresa B** → abrir Configurações → **nenhum dado da Empresa A
      permanece**.
- [ ] Deixar Configurações → Dados da Unidade **aberto** e trocar de unidade pelo
      seletor → a tela recarrega para a unidade nova (não fica com o formulário
      da anterior).

---

## 5. CMV por unidade (visual)

Pré-requisito: duas unidades com limites diferentes.

- [ ] Em **A1** → Configurações → Metas de CMV → definir **CMV saudável 25 /
      atenção 30**. Salvar.
- [ ] Em **A2** (ou Empresa B) → definir **saudável 40 / atenção 45**. Salvar.
- [ ] Escolher um produto cujo **CMV fique entre 30% e 40%** (ex.: 33%).
- [ ] Em **A1**: abrir Produtos/CMV (ou o Dashboard) → esse produto aparece como
      **🔴 Crítico** (acima de 30).
- [ ] Trocar para **A2** (ou B) → o **mesmo produto** aparece como **🟢 Saudável**
      ou **🟡 Atenção** (abaixo de 40) — o status **muda** entre os tenants.
- [ ] Voltar para A1, editar as Metas de CMV (ex.: saudável 35), salvar, e **sem
      recarregar a página** ir ao Dashboard/Produtos-CMV → a coloração já reflete
      o limite novo (o cache de `cmvConfig.js` foi atualizado).
- [ ] Trocar de unidade e voltar → a régua da unidade correta é aplicada (o cache
      não reaproveita a anterior).

---

## 6. Usuários e associação (Empresa)

### 6a. Tenant — "Usuários e Permissões" (Configurações)

- [ ] Conceder acesso a um e-mail **novo** → conta criada, entra na lista com o
      cargo escolhido.
- [ ] Conceder acesso a um e-mail que **já tem conta** noutra empresa → toast
      "acesso concedido, senha mantida"; entra na lista.
- [ ] Trocar o cargo de um usuário no `<select>` → toast "Cargo atualizado";
      recarregar e confirmar que persistiu.
- [ ] Confirmar (painel SuperAdmin → detalhe do usuário) que **o cargo desse
      usuário em outra empresa NÃO mudou** — cargo é do vínculo `usuario +
      organizacao`, não do perfil.
- [ ] Remover o acesso → 🗑️ → o usuário sai da lista; a conta continua existindo.

### 6b. Painel SuperAdmin — modal "Associar empresas"

Abrir um usuário → **+ Associar empresa**.

- [ ] Título: **"Associar empresas — [Nome]"**.
- [ ] **Vínculos atuais**: as empresas já associadas aparecem com o cargo atual
      num seletor; badge "Associado". Não somem da lista.
- [ ] **Adicionar acesso a empresas**: só as **não** associadas, com checkbox +
      seletor de cargo.
- [ ] Busca por nome aparece se houver > 8 empresas e filtra as duas listas.
- [ ] Marcar **1 empresa** + cargo → "Associar selecionadas" → toast "1 empresa
      associada".
- [ ] Marcar **3 empresas** → aparece "mesmo cargo em todas?" → **Sim** →
      um único seletor "Cargo para todas" → associar → as 3 ficam com o cargo.
- [ ] Marcar **3 empresas** → **Não** (individual) → cada empresa com seu seletor →
      associar → cada uma fica com o seu cargo.
- [ ] Marcar uma empresa **já associada** não é possível (ela está em "Vínculos
      atuais", sem checkbox). Se o backend receber uma já associada no lote (bug
      de frontend) → responde **409** e **não grava nada**.
- [ ] Alterar o cargo de um **vínculo atual** no seletor → aparece a flag "cargo
      alterado" → "Associar selecionadas" → toast mostra "N cargo(s) alterado(s)";
      as sessões daquele usuário naquela empresa são encerradas.
- [ ] Botão mostra "Aguarde…" e não aceita duplo-clique; erro aparece no topo do
      modal sem fechar.

### 6c. Usuário só por `usuarios_unidades`

- [ ] (Painel SuperAdmin) Associar um usuário **só a uma unidade** de A (sem
      vínculo de empresa).
- [ ] No tenant da Empresa A → Configurações → Usuários e Permissões → esse
      usuário **aparece** com badge "Só por unidade", cargo da unidade em texto,
      🔒 no lugar do 🗑️.
- [ ] O `<select>` de cargo dele está desabilitado / ausente (não dá para editar
      cargo de vínculo de unidade por aqui).

---

## 7. Regressão — módulos que compartilham contexto

Fazer um smoke rápido em cada, com o contexto em **Empresa A / A1**, e confirmar
que carregam dados e não quebram:

- [ ] **Dashboard Executivo** — abre, carrega o mês, o simulador de preço lista as
      tabelas da empresa (não a lista global antiga).
- [ ] **Produtos / CMV** — abre, a tabela colore os produtos, o seletor "Comparar:"
      lista só as tabelas da empresa.
- [ ] **Parser Food Delivery** — abre, importa/lista.
- [ ] **Bonificação Mensal** — abre, carrega indicadores.
- [ ] **Agente Crescer** — abre, responde uma pergunta simples de contexto.
- [ ] **Martin Brower** — abre a aba de integração.
- [ ] **Seletor global de unidade** — troca de unidade funciona, topbar atualiza.
- [ ] **Impersonação SuperAdmin** — entrar como uma empresa, navegar, sair;
      Configurações mostra os dados da empresa impersonada.
- [ ] Trocar de unidade **enquanto** cada uma dessas telas está aberta → a tela
      recarrega para a unidade nova, sem dado da anterior.

---

## 8. Resultado

- [ ] Todos os itens acima passaram → registrar data, ambiente e responsável.
- [ ] Qualquer divergência → **não mergear**; abrir issue com o item e o print.
