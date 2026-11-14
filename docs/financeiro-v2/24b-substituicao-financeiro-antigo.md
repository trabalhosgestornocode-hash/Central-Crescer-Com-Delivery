# Financeiro v2 — 24b. Substituição do financeiro antigo: inventário, retenção, backup, substituição e remoção segura

Data: 14/11/2026. Execução 09C (atualização de escopo). Branch local `feat/financeiro-v2-escalabilidade`.

> **Só planejamento, feito no código local.** Nada foi lido, alterado ou excluído em produção. Nenhum `DROP`,
> `TRUNCATE`, exclusão em massa ou migração destrutiva foi preparado para execução. Qualquer exclusão irreversível só
> acontece **depois** da ativação validada do Financeiro v2 **e** de uma autorização específica para a limpeza em produção.

## 1. Decisões recebidas (aprovadas pela empresa) e limites desta fase

| Decisão | Efeito no plano |
|---|---|
| Financeiro v2 é o único sistema financeiro definitivo | o legado entra em congelamento e remoção (§ 6–8) |
| Só o projeto Supabase existente | v2 em schema dedicado `financeiro_v2` (doc 24 § 11) |
| Reutilizar login, seleção de empresa/unidade e menu | o item "Dashboard Financeiro" e o gate do módulo **ficam**; muda o conteúdo (§ 3) |
| Substituir o Dashboard Financeiro antigo | por unidade, via liberação (0021); nunca dois financeiros ativos para a mesma unidade |
| **Não migrar** registros do sistema antigo | abertura do v2 por documentos de origem (§ 9), não por cópia de linhas |
| Preparar descontinuação e exclusão do legado | inventário (§ 2), retenção (§ 4), backup (§ 5), remoção em etapas (§ 8) |
| Preservar os demais módulos | pontos de contato listados (§ 3) e tratados antes de qualquer remoção |

## 2. Inventário do legado (levantado no repositório; produção não consultada)

**Banco** — migrações `120`, `121`, `122` (Gestão Financeira) e `151`–`156` (Financeiro 2.0), cada uma com seu
`_rollback.sql`:

- **29 tabelas exclusivas:** `fin_auditoria`, `fin_conciliacao_resolucoes`, `fin_conciliacao_saidas`, `fin_contas`,
  `fin_divida_eventos`, `fin_dividas`, `fin_excecoes_fechamento`, `fin_fornecedores`, `fin_importacoes`,
  `fin_lancamentos`, `fin_obrigacoes`, `fin_pagamentos`, `fin_pendencias_documentais`, `fin_periodos`,
  `fin_plano_contas`, `fin_rateio_parcelas`, `fin_rateios`, `fin_recebimentos`, `fin_recebiveis`, `fin_referencias`,
  `fin_saldos_abertura`, `fin_sangria_excecoes`, `fin_transferencias`, `fin_transferencias_multiplas`,
  `fin_transferencias_multiplas_entradas`, `fin_vendas_ajustes`, `fin_vendas_canal`, `gestao_financeira_concessoes`,
  `gestao_financeira_concessoes_auditoria`.
- **74 funções** (`fin_*` e `gestao_financeira_*`, inclusive as RPCs de período, transferência, importação e exceção
  de fechamento) e os gatilhos dessas tabelas.
- **Chaves estrangeiras para a plataforma** (o legado depende dela; a plataforma não depende do legado):
  27 para `organizacoes`, 25 para `unidades`, 1 para `perfis_operacionais`.
- `database/schema.sql` não contém objetos do legado.

**Backend** — `src/modules/gestao-financeira/` (rotas, serviços, domínio, importadores XLSX, concessões),
`src/financeiro-calculos/motor.js` (usado só pelo legado), `src/middlewares/financeiro.js` (`requireFinanceiro`),
`src/shared/gestaoFinanceira.permissoes.js`, montagem em `src/routes.js` (`/gestao-financeira`) e
`src/modules/plataforma/plataforma.routes.js` (`/plataforma/gestao-financeira/concessoes`). **42** arquivos de teste
do backend citam o legado.

**Frontend** — `frontend/src/financeiro/` (40 arquivos: painel, conciliação, conferências, fluxo de caixa,
lançamento rápido, vendas diárias, contas a pagar…), `financeiroAcesso.js`, `financeiroMenu.js`,
`financeiroRoteador.js`, `adminAcessoFinanceiroModelo.js`, trechos de `adminApi.js` e `adminUnidadeWizard.js`.
**16** arquivos de teste do frontend.

**Nenhum outro módulo lê tabelas `fin_*`** (busca no `backend/src`): Dashboard Executivo, agente, iFood, Foody,
Parser e administrativo não dependem do legado.

## 3. Pontos de contato com a plataforma (o que NÃO pode ser removido junto)

| Ponto | Situação | Tratamento |
|---|---|---|
| Módulo `gestao_financeira` (tabela `modulos`, `MODULOS.GESTAO_FINANCEIRA`, liberação por empresa/unidade) | É a **porta de entrada** que o v2 reaproveita | **Manter.** Só o conteúdo muda |
| Item de menu "Dashboard Financeiro" e `financeiroAcesso.js` | O encaixe do v2 (`financeiroV2Encaixe.js`, 09) estende esta máquina de estados | Manter até o v2 virar o único estado; depois simplificar |
| `GET /gestao-financeira/status` | O encaixe do v2 lê o bloco `financeiroV2` daqui | Mover para uma rota do v2 **antes** de remover o roteador antigo |
| `requireFinanceiro` + `gestao_financeira_concessoes` | Gate do legado (concessão por perfil) | O v2 tem concessões próprias (`fv2_concessao`); decidir se a concessão antiga continua como pré-requisito do menu ou é substituída (D-24b-1) |
| Gatilho `trg_unidades_guarda_financeiro` em `public.unidades` (+ `gestao_financeira_unidades_guarda_org`) | Impede mover unidade de organização quando há dados financeiros | **Não remover sem substituto:** o v2 precisa da mesma guarda para os seus dados antes da remoção (D-24b-2) |
| Restrição `modulos_categoria_check` (categoria `financeiro`) | Criada pela 120 na tabela da plataforma | Manter (o módulo continua na categoria `financeiro`) |
| `/plataforma/financeiro` (planos e assinaturas) | **Não é o legado** (cobrança da plataforma) | Fora do escopo; não tocar |
| `adminUnidadeWizard.js` (exclui o módulo do assistente) | Comportamento da plataforma | Rever na fase de ativação |
| **L-1** — Setores de navegação de TODOS os usuários: `GET /api/v1/sessao/setores` (`sessao.controller.js`) → `calcularSetores` (`shared/setores.js`, que importa `MODULO_FINANCEIRO` de `gestaoFinanceira.permissoes.js`) ← `resolverAcessoFinanceiro` (`middlewares/financeiro.js`), que lê `gestao_financeira_concessoes` (`nivel`, `somente_financeiro`) | Achado da auditoria do Agente 2. É a ÚNICA fonte de "somente financeiro". Por desenho (teste "somente_financeiro sem financeiro vigente não esconde o operacional"), sem concessão vigente a restrição não vale. Por isso, revogar ou apagar a concessão antiga devolve o setor **operacional** a quem é exclusivamente financeiro. É regra de **navegação**: as rotas operacionais continuam protegidas pelas permissões do perfil. Sem a tabela, a rota de setores falha fechado (500 para todos) | **Não remover** roteador, middleware, `gestaoFinanceira.permissoes.js` nem a tabela enquanto não houver **fonte substituta** de "financeiro"/"somente financeiro", por exemplo as concessões do v2 (D-24b-1, D-24b-6). Testes: `backend/test/financeiro-setores-legado.test.js` (perfis sintéticos, risco fixado, falha fechada e alarme que falha se a fonte mudar sem atualizar este plano); aceite P17 |

## 4. Avaliação de retenção

- O legado guarda registros gerenciais reais (importações, lançamentos, conciliações, fechamentos) de empresas da
  rede. Não migrar **não** significa descartar sem guarda: documentos e registros que sustentam decisões financeiras e
  fiscais costumam ter prazo de guarda legal (em geral, enquanto não houver prescrição/decadência — referência usual
  de 5 anos). **O prazo é decisão da empresa com o contador (D-24b-3)**; este plano não o define.
- Proposta: guardar uma **exportação completa e verificável** (§ 5) pelo prazo decidido, fora do repositório público
  e fora do banco ativo, e só então permitir a exclusão das estruturas.
- Arquivos de evidência: o código do legado não usa o Storage (busca sem ocorrências); confirmar em produção, com
  autorização, se há arquivos ligados a `fin_pendencias_documentais` fora do banco.

## 5. Plano de backup (antes de qualquer remoção)

1. **Congelar** escrita do legado (§ 6, F3) para a foto ser estável.
2. **Exportar** com `pg_dump` só os objetos do legado (`-t 'public.fin_*' -t 'public.gestao_financeira_*'` +
   definições das funções), em formato custom, **e** CSV por organização para leitura sem banco.
3. **Integridade:** sha256 de cada arquivo + contagem de linhas por tabela e por organização, registradas num termo.
4. **Guarda:** armazenamento privado com acesso restrito e cifrado; nunca no repositório (público).
5. **Restauração ensaiada:** restaurar num PostgreSQL isolado e conferir contagens e somas por tabela/organização.
   Sem ensaio aprovado, nada é removido.
6. O backup automático do Supabase é do **projeto inteiro**: não serve como desfazer seletivo do legado (restaurar o
   projeto voltaria a plataforma inteira). Ele é rede de segurança adicional, não o plano.

## 6. Plano de substituição (por fases, cada uma reversível até F5)

| Fase | O que acontece | Reversão |
|---|---|---|
| F0 | v2 aplicado no schema `financeiro_v2` (aditivo; doc 24 § 11), homologação local/remota conforme critérios do doc 24 § 15 | remover o schema novo (sem dados reais) |
| F1 | Unidade piloto: liberação do v2 (0021) → o menu mostra **só** o v2 para ela; legado dela fica só leitura | desligar a liberação: volta ao legado |
| F2 | Demais unidades, em lotes, mesmo mecanismo | idem, por unidade |
| F3 | Legado **congelado** para todas: rotas de escrita desligadas no backend (somente consulta, para conferência) | religar as rotas |
| F4 | Backup e ensaio de restauração (§ 5) aprovados | — |
| F5 | Remoção do **código** do legado (frontend e backend) e do bloqueio de dois estados no menu. **Pré-condição (L-1):** a rota de setores já usa a fonte substituta de "financeiro"/"somente financeiro" e o aceite P17 passa (usuário exclusivamente financeiro continua sem o setor operacional; operador continua com o dele) | reverter o commit |
| F6 | Remoção das **estruturas** no banco (§ 8) — **irreversível**, exige autorização específica | só pelo backup (§ 5) |

Regra: em nenhum momento a mesma unidade tem os dois financeiros ativos (o encaixe da 09 já impõe isso: com o v2
liberado, o legado não aparece, nem como alternativa).

## 7. Validação (critério de saída de cada fase)

- **F1/F2:** jornada completa no v2 da unidade (Visão Geral, DRE, contas, caixa, fechamento) com dados dela; o
  legado da unidade não recebe escrita nova (contagem de linhas estável); suporte sem chamados bloqueantes.
- **F3:** tentativa de escrita no legado recusada; leitura ainda funciona.
- **F4:** contagens e somas do ensaio de restauração = produção; termo assinado.
- **F5:** suítes da plataforma verdes sem o código do legado; nenhum import remanescente; menu com um único financeiro.
- **F6:** inventário de objetos pós-remoção = inventário pré-remoção **menos** exatamente a lista do § 2; objetos da
  plataforma (§ 3) intactos (mesma técnica do C0 da sonda: foto sha256 antes/depois).

## 8. Remoção segura das estruturas (F6 — preparada como plano, não como script executável)

Ordem, numa migração única e transacional, com **pré-condições que abortam**:
1. Pré-condições: F4 aprovada (hash do backup informado na migração); o v2 já tem a guarda de transferência de
   unidade (D-24b-2); nenhuma rota do backend referencia `fin_*` (verificação no código antes do deploy).
2. Substituir o gatilho de `public.unidades` pela guarda do v2 (nunca deixar a unidade sem guarda).
3. Remover funções/RPCs `fin_*` e `gestao_financeira_*` (lista nominal, sem curingas).
4. Remover as 29 tabelas por **lista nominal** (sem `cascade` amplo; dependência inesperada = aborto).
5. Manter `modulos` (linha e restrição), `organizacoes`, `unidades`, `perfis_operacionais` intactos.
6. Pós-condição: foto do inventário da plataforma idêntica à de antes.

Os `_rollback.sql` existentes (156 → 120) servem de ponto de partida, mas **não** podem ser usados como estão: o da
120 remove também o gatilho de `unidades` sem substituto.

## 9. Saldos de abertura e competência inicial do v2

Sem migrar registros, a abertura vem de **documentos de origem**:
- **Competência inicial por unidade** (D-24b-4): o primeiro mês inteiro operado no v2; meses anteriores não existem
  no v2 (nem DRE nem fechamento).
- **Saldos de abertura por conta:** saldo informado (`FIM_DO_DIA`) no último dia antes da competência inicial, com o
  extrato como documento — é a âncora que o v2 já usa (06A/06B) e que deixa "saldo desconhecido" visível enquanto
  faltar.
- **Títulos em aberto na data de corte:** contas a pagar e a receber ainda pendentes são registradas no v2 a partir
  dos documentos (boletos, relatório do processador), com a data e a competência originais; o que foi pago antes do
  corte não entra.
- O legado pode ser consultado **só para conferência** (F3), nunca como fonte copiada.
- A testar na próxima execução: registrar títulos de competência anterior à inicial sem abrir essas competências no
  v2 (comportamento atual ainda não coberto por teste).

## 10. Decisões pendentes (nenhuma tomada aqui)

| Código | Decisão | Quem |
|---|---|---|
| D-24b-1 | Concessão antiga como pré-requisito do menu ou só as concessões do v2 | empresa |
| D-24b-2 | Guarda de transferência de unidade no v2 (desenho e prazo) antes de F6 | empresa + técnica |
| D-24b-3 | Prazo de guarda do backup do legado | empresa + contador |
| D-24b-4 | Competência inicial e unidade piloto | empresa |
| D-24b-5 | Autorização específica para F6 em produção | empresa (por escrito) |
| D-24b-6 | (L-1) Fonte de "exclusivamente financeiro" depois do legado: atributo da concessão do v2, do perfil da plataforma, ou deixar de existir. E se a restrição deve continuar valendo quando a concessão financeira é revogada (hoje não vale) | empresa + técnica |
