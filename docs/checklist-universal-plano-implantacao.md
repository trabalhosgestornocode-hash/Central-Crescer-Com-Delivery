# Checklist Operacional universal — plano de implantação (NÃO executar sem autorização expressa)

Plano operacional para depois da aprovação do PR #47. **Nada aqui foi executado.** Cada passo de produção exige autorização própria.
Número da migration: **123** (provisório até o merge; ver §1).

## 0. O que torna a implantação segura por desenho
- O gate é `checklist_operacional OU ifood` (backend e menu): **o código funciona com ou sem a migration aplicada**. Quem já usa o Checklist (módulo `ifood`) não perde acesso em nenhuma ordem de implantação.
- A migration só escreve em `modulos`, `organizacao_modulos` e `unidade_modulos`; é idempotente, transacional e tem rollback; não toca em pedidos, conexões, credenciais nem tokens do iFood.
- Nenhuma duração é gravada: as fórmulas novas valem assim que o código novo roda, e voltam sozinhas se o código voltar.
- A migration NÃO habilita empresas novas: só copia o módulo novo para quem já tem `ifood`. Habilitar outras empresas é passo separado, pela tela de Acessos.
- O `OU ifood` NÃO é removido neste plano (etapa futura, PR próprio).

## 1. Pré-condições
1. PR #47 revisado e aprovado; saiu de Draft **por decisão sua**.
2. **Numeração**: conferir `main` e as migrations da trilha financeira já integradas; número = maior existente + 1 (hoje 123; a financeira ocupa 120–122). Se mudar, renomear `123_*` (arquivos + comentários + travas de teste) e reexecutar `checklist-operacional-modulo.test.js` e as duas travas (088/103). O teste do módulo descobre o arquivo pelo nome.
3. Testes do PR verdes exceto as falhas já existentes na `main` (lista no PR); `checklist-operacional-pg.test.js` rodado contra Postgres descartável (13/13).
4. **Previews/CI**: previews de PR do Render desligados (confirmado pelo responsável); lembrar que o serviço do app tem **auto-deploy por commit na `main`** — o merge dispara o deploy (ver §4).
5. Janela de baixo movimento da Saci e alguém acompanhando a TV da loja.
6. Contagens de referência anotadas ANTES (consulta de leitura): empresas e unidades com `ifood`; pedidos do dia da Saci (recebidos/concluídos/ativos).
7. Responsável definido para a decisão de reverter (§10).

## 2. Ordem exata das migrations
Cada migration é independente das demais deste plano; a regra é numeração única e crescente em `main`.
1. Migrations anteriores pendentes já integradas à `main` (se existirem na data): na ordem numérica.
2. Trilha financeira (120 → 121 → 122), **somente se já integrada à `main`** — fora do escopo deste plano; não a aplique por causa dele.
3. **123_checklist_operacional_modulo.sql** (este PR).
Aplicação: Supabase → SQL Editor, o arquivo inteiro, uma vez. Verificação imediata (consultas no fim do arquivo):
- 1 linha em `modulos` (`checklist_operacional | Checklist Operacional | operacao | 18`);
- `organizacao_modulos` com o módulo novo = nº de empresas com `ifood` (hoje 4: a da Saci, Empresa Teste, Ideal Mall, Açaí no Grau Saci);
- `unidade_modulos` com o módulo novo = nº de unidades com `ifood`;
- nenhuma empresa/unidade sem `ifood` com o módulo novo.

## 3. Backup e rollback
**Backup (antes da migration)**: exportar `modulos`, `organizacao_modulos` e `unidade_modulos` (CSV pelo SQL Editor) e guardar fora do repositório. A migration só adiciona linhas, então o backup serve de conferência.
**Rollback do banco**: `123_rollback.sql` (transação única; apaga só `checklist_operacional` nos vínculos de unidade e de empresa e depois no catálogo; nunca toca `ifood`). Idempotente; reaplicável.
**Rollback do código**: reverter o merge (`git revert`) e fazer deploy manual do serviço. As fórmulas antigas voltam sozinhas.
**Ordem do rollback**: código primeiro, banco depois (o gate `OU ifood` já cobre quem usa o Checklist; se algum dia o `OU ifood` for removido, o código antigo volta ANTES de apagar o módulo).
Tempo estimado: migration e rollback de banco < 1 min; deploy do serviço ~30 s (+ propagação).

## 4. Sequência do deploy
1. Aplicar a migration 123 (§2) e conferir a verificação. *(Pode ser feita antes ou depois do deploy — o gate aceita as duas; recomendo antes.)*
2. Merge do PR na `main` (só com sua autorização). **O merge dispara o auto-deploy do serviço `crescercomdelivery` (rootDir `backend`, que também serve o frontend)**; este PR altera backend, então o deploy acontece. Acompanhar o deploy até `live` e `/health` OK.
3. Conferir que o `styles.css?v=`/JS novos estão no ar (o frontend é servido pelo backend).
4. TVs/abas já abertas com JavaScript antigo continuam funcionando (gate `OU ifood`); recarregar quando conveniente.
5. Não há migration automática no deploy; o worker de comunicação e o poller do iFood não são alterados.

### 4.1 Janela entre a migration e o deploy (analisada no Checkpoint G)
O catálogo exibido na tela de Acessos vem do **código** (`CATALOGO_MODULOS`), não da tabela `modulos`; já os vínculos vêm das tabelas. Consequências:
- **Migration aplicada, código antigo ainda no ar** (janela de minutos): o acesso de ninguém muda (o código antigo só conhece `ifood`). Único efeito: se o SuperAdmin **salvar os módulos de uma das 4 empresas que ganharam o vínculo** pela tela antiga, o cálculo de diferença (`definirModulosEmpresa`/`definirModulosUnidade`) enxerga `checklist_operacional` como "a remover" e apaga o vínculo novo daquela empresa/unidade. O acesso continua por `ifood`. **Mitigação:** não mexer na tela de Acessos entre a migration e o deploy e **reaplicar a migration (idempotente) depois do deploy** — ela devolve o vínculo a quem tem `ifood`. A verificação do §2 já pega a diferença.
- **Código novo no ar sem a migration**: tudo funciona (gate `OU ifood`), mas habilitar o módulo novo pela tela de Acessos **falha** (chave estrangeira `modulo_id → modulos(id)` sem a linha do catálogo). Por isso a ordem recomendada é migration → merge/deploy, e nenhuma habilitação (piloto, ondas) antes de confirmar a migration.
- **Rollback do banco depois de habilitações**: `123_rollback.sql` remove TODOS os vínculos do módulo novo, inclusive os do piloto e das ondas. Quem só tem o módulo novo (empresas sem iFood) perde o Checklist; quem tem `ifood` não. Antes de usá-lo, listar os vínculos existentes (consulta) para poder reabilitar.
- **Sessões**: continuam congeladas por até 8 h; quem abriu antes da migration entra por `ifood` (ou, para empresas do piloto, precisa selecionar o contexto de novo).

## 5. Validação inicial da Subway Saci (primeira meia hora)
1. Abrir o Checklist na TV da Saci (Modo Televisão): carrega, selo "Ao vivo", sem erros visíveis.
2. Conferir: os três cards com definições novas ("Da chegada…até a saída"), amostras ao lado das médias, a linha "Com os 3 horários (n pedidos)" e a decomposição em dois trechos.
3. Comparar com a contagem anotada (§1.6): recebidos/concluídos/ativos iguais; alertas iguais.
4. Conferir um pedido recente à mão: preparo = saída − chegada; entrega = conclusão − saída; vida = conclusão − chegada.
5. Conferir que os pedidos de retirada aparecem sem tempos ("Retirada: sem tempos") e que o poller do iFood segue ao vivo (selo e `ultimo_evento_em` avançando).
6. Logs do Render: nenhum erro novo em `/api/v1/checklist-operacional/resumo`.

## 6. Piloto principal: Subway North Shopping (Fortaleza/CE) — vínculo iFood sem credencial de pedidos
**Identificação (leitura em produção, 17/10/2026):** a única unidade com "North" ou "Fortaleza" no cadastro é **"Subway North Shopping"** (Fortaleza/CE), id `6a417349-2ece-4e85-9e7f-884391aecd90`, ativa, `eh_teste = false`. Ela pertence à **mesma empresa da Subway Saci** (Grupo Jailton e Vanessa) e é a mesma unidade antes chamada "North Shopping (teste)". O cadastro não tem CNPJ, responsável nem e-mail.
**iFood:** módulo `ifood` na empresa e na unidade; conexão ativa com loja vinculada (loja de teste no iFood); credencial `financial` ativa (expirou em 08/10) e **sem credencial de pedidos (`order`)** — nunca recebeu pedidos (0 pedidos, 0 eventos).
**Classificação (decisão do responsável, Checkpoint K):** **piloto de unidade com vínculo iFood, mas sem credencial de pedidos autorizada**, e unidade piloto principal do Checklist. **Não** é piloto "sem iFood". Não se modifica a conexão iFood, não se solicitam novas credenciais e não se criam pedidos artificiais.
**Não há habilitação a fazer:** a unidade já tem `ifood` nos dois níveis, então a migration lhe dá o módulo novo automaticamente (uma das 7 unidades do backfill). Permissão necessária: `checklist.visualizar` (papéis `organization_admin`, `operations`, `finance`, `unit_manager`, `viewer` e `display_operator`); os vínculos da empresa valem para as duas unidades.
**Esperado na tela:** o aviso "Integração não ativada — A loja não autorizou o aplicativo de pedidos da Central." (modo integrado, estado `nao_ativada`, motivo `sem_credencial_order`), sem números, sem pedidos e sem erro de console; **não** o aviso "Unidade sem integração com o iFood".
**Valida:** acesso ao Checklist; seleção da unidade; permissões; isolamento entre North Shopping e Subway Saci; o estado de integração não ativada; ausência de pedidos e de indicadores fictícios; e a compatibilidade com o módulo independente.
**A North Shopping NÃO substitui o teste de uma unidade realmente desconectada do iFood. Pendência obrigatória antes de liberar o módulo para todas as empresas:** uma unidade **realmente desconectada** (sem módulo `ifood`, sem conexão) acessando o Checklist só pelo módulo novo e vendo "Unidade sem integração com o iFood". Hoje isso só está provado em testes automáticos. Será um **piloto separado**, com uma unidade autorizada e sem conexão iFood. **Essa segunda unidade não é escolhida nem ativada automaticamente**: a escolha e a autorização são do responsável.

## 7. Verificação de isolamento (antes de ampliar)
1. A North não vê pedidos da Saci (mesma empresa, outra unidade) nem de outra empresa; a Saci não vê a North.
2. Usuário da Saci continua vendo só os pedidos da Saci.
3. Usuário sem `checklist.visualizar` recebe 403; empresa sem o módulo (nem `ifood`) recebe 403.
4. Consulta de leitura confirma que `checklist_operacional` está só nas empresas/unidades pretendidas.
5. `checklist-operacional-pg.test.js` (Postgres descartável) permanece verde com a versão publicada.

## 8. Ativação gradual das demais empresas
- Ondas pequenas (1 → 3 → resto), cada onda só depois de 24 h estáveis e do checklist de §7 repetido.
- Habilitar somente empresas **autorizadas por você**, pela tela de Acessos (empresa + unidade). Nada em lote por SQL.
- Para empresas com iFood a integração continua sendo outro assunto (vincular loja e autorizar OAuth são passos do dono da loja e **não** fazem parte deste plano).

## 9. Monitoramento após a publicação
- Primeiras 2 h: logs do Render a cada 15 min (5xx e 403 inesperados em `/checklist-operacional/resumo`); `/health`; latência da consulta.
- 24 h e 72 h: pedidos da Saci (contagens e alertas "sem conclusão"), selo da TV, `eventos com falha`, lease do poller.
- Conferir a TV da Saci no horário de pico.
- Registrar qualquer 403 inesperado de usuário que usava o Checklist (sinal de módulo ausente na unidade).

## 10. Critérios objetivos para interromper ou reverter
**Interromper a ativação** (não avançar de onda) se qualquer um ocorrer: um 403 inesperado em usuário que já usava o Checklist; um erro de console recorrente na tela; uma unidade vendo dado de outra; contagens da Saci diferentes das anotadas; TV cortada ou com rolagem.
**Reverter imediatamente** (§3) se: qualquer vazamento entre empresas/unidades; a Saci perder o acesso ao Checklist; 5xx persistente (> 5 min) em `/checklist-operacional/resumo`; queda do poller do iFood atribuível ao deploy; migration com resultado de verificação diferente do esperado.
**Rollback parcial**: para uma empresa SEM iFood habilitada depois, retirar `checklist_operacional` da empresa/unidade pela tela de Acessos. A North (e a Saci) têm `ifood` e continuam abrindo pelo gate `OU ifood`.

## 11. O que este plano NÃO inclui
Remoção do gate `OU ifood`; correção dos 4 pedidos `CONCLUDED` sem horário e da máquina de estados iFood (plano próprio); metas por unidade persistidas; qualquer alteração em credenciais, conexões ou tokens do iFood.

## 12. Checklist operacional definitivo (pré-implantação) — nada abaixo foi executado
Marcar cada item com data e responsável antes de iniciar. Qualquer "não" adia a publicação.
| # | Item | Responsável | Estado |
|---|---|---|---|
| 1 | **Número da migration reconfirmado no dia**: maior número existente em `main` + trilhas financeiras integradas + 1 (candidato 123; hoje a `main` está na 119 e a financeira ocupa 120–122). Se mudar: renomear migration e rollback, comentários e travas 088/103. | quem aplica a migration | pendente |
| 2 | **Ordem do catálogo = 18** em código, migration e testes (a 17 é da financeira). | — | **feito** neste PR |
| 3 | **Backup de produção**: exportar `modulos`, `organizacao_modulos`, `unidade_modulos` (CSV) e confirmar PITR/backups automáticos no painel do Supabase; refazer o snapshot se o estado mudou. | responsável pelo banco | pendente |
| 4 | **Linha de base da Subway Saci** do dia (módulos, conexão iFood, poller, contagens e indicadores) antes da migration. | quem executa | pendente |
| 5 | **Monitoramento dos logs do Render** (build, `live`, `Subway Saci API rodando`, `iFood Events: embarcado ATIVO`, `events.lease_de_outro` transitório, erros e 5xx em `/checklist-operacional/resumo`) por pessoa com acesso ao serviço; o `/health` não substitui os logs. | a designar | **pendente (sem acesso hoje)** |
| 6 | **Homologação visual da TV da Saci** na resolução real da TV, com alguém na loja. | a designar | pendente |
| 7 | **Plano de rollback** conhecido por quem decide: código primeiro, banco depois; exportar os vínculos antes do rollback do banco (ele remove também os do piloto e das ondas). | quem decide reverter | pendente |
| 8 | **Janela de baixo movimento** (manhã de dia útil; evitar sábado/pico). | você | pendente |
| 9 | **Piloto Subway North Shopping** (unidade confirmada pelo responsável: Fortaleza/CE, empresa Grupo Jailton e Vanessa): **designar quem a acompanhará** (o cadastro não tem responsável) e **comunicar os responsáveis pela unidade** sobre o que esperar (abre sem pedidos, aviso "Integração não ativada"). Nada a habilitar: o acesso vem da migration. Não mexer na conexão iFood, não pedir credenciais, não criar pedidos. | você | pendente |
| 9b | **Validação posterior com uma unidade realmente desconectada** (sem `ifood`), autorizada, antes de universalizar o acesso às demais lojas. | você | pendente |
| 10 | Ninguém usa a tela de Acessos entre a migration e o deploy; reaplicar a migration (idempotente) depois do deploy. | quem executa | pendente |
| 11 | PR #47 revisado e fora de Draft por decisão do responsável; ordem com a financeira definida (Checklist primeiro). | você | pendente |
