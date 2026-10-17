# Checklist Operacional — universalização e tempos (Etapa 2, proposta para revisão)

Branch `feat/checklist-universal-tempos` (worktree `crescer-checklist-universal`, a partir de `origin/main` 8d32196).
**Nada foi commitado, publicado, migrado ou habilitado em produção.** Só leituras (GET) no banco de produção para a análise.

## 1. O que muda

### 1.1 Módulo próprio `checklist_operacional`
| Peça | Antes | Depois |
|---|---|---|
| Gate da rota `/checklist-operacional` (`backend/src/routes.js`) | `requireModulo(IFOOD)` | `requireAlgumModulo(CHECKLIST_OPERACIONAL, IFOOD)` |
| Menu (`frontend/src/config.js`) | `modulo: "ifood"` | `modulo: "checklist_operacional"` + `moduloTransicao: "ifood"` |
| Permissão | `checklist.visualizar` (ou `integracoes.ver`) | **inalterada** |
| Catálogo (`backend/src/shared/modulos.js`) | — | `MODULOS.CHECKLIST_OPERACIONAL`, ordem 17, categoria `operacao` |
| Banco | — | `database/migrations/123_checklist_operacional_modulo.sql` (+ `123_rollback.sql`; ver §10.1) |

- O `OU ifood` existe só na **transição**: a sessão congela os módulos por até 8 h, então sessões abertas antes da migration não trazem o módulo novo. A remoção de `MODULOS.IFOOD` do gate e de `moduloTransicao` do menu NÃO é automática por tempo: só depois das verificações do §8.5.
- A migration **só** dá o módulo novo a quem já tem `ifood` (empresa e unidade — o acesso efetivo é a interseção das duas tabelas). **Nenhuma outra empresa é habilitada**: o SuperAdmin libera pela tela de Acessos (o catálogo é data-driven).
- Número da migration: **123** (a trilha financeira ocupa 120–122); sujeito a reconciliação no merge — ver §10.1.

### 1.2 Modo sem integração (modo mínimo "a")
- O backend já tolerava unidade sem conexão. Novo campo aditivo `modo` (`integrado` | `sem_integracao`); `VERSAO_CONTRATO` segue 1.
- `sem_integracao` = sem loja vinculada ou sem credencial `order`. A tela abre, mostra "Unidade sem integração com o iFood" e **nenhum número**; só consulta o vínculo local (nenhuma chamada obrigatória ao iFood).
- Não há tarefas, responsáveis, checklists preenchíveis nem lançamento manual (decisão 3).

### 1.3 Fórmulas (só `DELIVERY`)
| Indicador | Definição | Antes |
|---|---|---|
| Preparo | `PLC → DSP` (o pronto `RTP` **não** encerra) | `CFM → RTP` (ou `CFM → DSP` aproximado) |
| Entrega | `DSP → CON` | igual |
| Vida | `PLC → CON` = preparo + entrega | `PLC → CON` (PLC ou `createdAt`) |

- Chegada = **somente** `placed_event_created_at`. O `createdAt` do pedido não substitui (difere do PLACED em mediana 25 s, até 7 min); ele continua servindo para exibição e para colocar o pedido no dia.
- Retirada (`TAKEOUT`) e pedido sem detalhes ficam **fora dos três indicadores** e são contados à parte (`retiradas`, `semDetalhes`). Continuam no painel; a tabela mostra "Retirada: sem tempos" e a lista de ativos não cronometra meta para eles.
- Duração ≤ 0 ou acima do teto continua descartada e contada (`descartados`); nada é corrigido nem estimado. Agendado continua fora de preparo e vida.
- Cronômetro ao vivo: o preparo corre desde a chegada até o despacho, **inclusive com o pedido pronto aguardando o entregador**.
- Decomposição da vida: dois trechos sem sobreposição (preparo + entrega). O detalhe do preparo (confirmação / até o pronto / espera pelo despacho) é informativo, fora da barra, e só aparece com `PLC ≤ CFM ≤ RTP ≤ DSP`.
- Entrega continua marcada "≈", agora com a causa "conclusão registrada pelo iFood: não confirma, por si só, a entrega ao cliente".
- **Metas**: `METAS_EXEMPLO` não foi alterado (preparo 12 / entrega 35 / vida 45). O 12 era da definição antiga; a nova meta depende de aprovação (ver §4).

## 2. Evidências (leitura da produção, 17/10/2026, 1.266 pedidos, 7 dias, 1 unidade)
- Equivalência: 14 instantes simulados (7 dias × 15:00 e 23:30) com o cálculo antigo e o novo — dia operacional, pedidos ativos, contagens, alertas e "últimos pedidos" **idênticos** nos 14. Só os valores de preparo mudam.
- Identidade por pedido: nos 1.215 entregas com os três carimbos válidos, `preparo + entrega = vida` com diferença máxima de 0,000000 min.
- Semântica do CON: nas entregas do iFood, 229/229 têm `DELIVERY_DROP_CODE_VALIDATION_SUCCESS` seguido do CON (mediana 0,3 min); nas da própria loja, 942/996 (mediana 0 min). Mas 5 entregas da própria loja sem esse evento tiveram CON 260–274 min após o despacho — **o CON nem sempre é a entrega real**. Documentado como "conclusão registrada pelo iFood".
- Sete concluídos sem DSP: 5 retiradas (`PLC>CFM>PRS>RTP>CON`, o fluxo normal da retirada) e 2 entregas da própria loja (`…DDCR>DDCS>CON`, sem `DISPATCHED`). Nenhum horário foi criado para elas.
- Fora de ordem: nenhum caso de DSP antes da PLC/CFM ou CON antes do DSP nos carimbos; 5 pedidos com RTP depois do DSP (não afeta o preparo novo); 208 pedidos tiveram PLC/CFM/DSP/CON **recebidos** fora de ordem, mas os carimbos (`createdAt` do evento) estão corretos.
- Achado separado: 3 pedidos `CONCLUDED` com `status_oficial_em` nulo, embora o evento CON exista em `ifood_eventos`. O cálculo os trata como sem conclusão (nada inventado). Causa não investigada (fora do escopo); correção seria reconciliar `ifood_pedidos` a partir de `ifood_eventos`, o que exige aprovação.
- Reutilização: nenhum outro módulo usa estes cálculos. `dashboardExecutivo` (`operacionalPorSegmento`) é vendas/ticket, não tempos; `ifoodEvents.service.js`/`ifoodOrder.service.js` só gravam/leem os carimbos. Parser Food Delivery tem fórmulas próprias e ficou **fora** (decisão 9).

## 3. Testes (worktree, ambiente fictício, sem tocar produção)
- Frontend e backend: ver §8.6.

- Novos/atualizados: `checklist-operacional-calc` (Cenário D = 18/25/43, E, F, G, retirada), `-service` (gate por módulo, modo `sem_integracao`, duas unidades da mesma empresa), `-modulo` (catálogo ↔ migration ↔ rollback, sem habilitação em massa), e os testes de tela (retirada, decomposição, aviso sem integração, menu).

## 4. Metas — análise somente de leitura (entregas concluídas; minutos)
| | n válidos | média | mediana | p75 | p90 | p95 | máx |
|---|---|---|---|---|---|---|---|
| Preparo `PLC→DSP` | 1.223 | 13,6 | 10,8 | 16,3 | 25,9 | 35,4 | 80,9 |
| Entrega `DSP→CON` | 1.215 | 10,2 | 9,1 | 12,6 | 17,2 | 20,9 | 45,3 |
| Vida `PLC→CON` | 1.222 | 24,9 | 20,4 | 28,1 | 40,1 | 48,8 | 282,4 |

- Excluídos: preparo 2 sem DSP; entrega 5 sem DSP/CON e 5 acima do teto (260–274 min, próprios da loja); vida 3 sem `status_oficial_em`. Para comparar: o preparo antigo (`CFM→RTP`, só 530 pedidos com RTP) tinha média 8,2 e p90 16,2.
- Por modalidade (preparo / entrega / vida, média): iFood 19,2 / 13,7 / 33,0; própria loja 12,4 / 9,4 / 23,1.
- A meta atual de preparo (12) ficaria **abaixo da média nova (13,6)**. Candidatas para decidir (nenhuma aplicada): p75 ≈ 16 / 13 / 28; p90 ≈ 26 / 17 / 40.
- A média de preparo inclui pedidos já despachados e ainda não concluídos (o preparo termina no despacho); por isso a média do preparo + a da entrega pode diferir da média da vida em ~0,1 min no dia corrente. A identidade vale **por pedido**.

## 5. Implantação (somente quando aprovado) e rollback
1. Merge na `main` (PR) — com os previews de PR desligados (conferir `get_service` antes).
2. **Migration 123** no Supabase (SQL Editor): idempotente, só catálogo + vínculos de quem já tem `ifood`. Verificação no fim do arquivo (esperado: 4 empresas e suas unidades; hoje as org com `ifood` são 4). Plano completo em `docs/checklist-universal-plano-implantacao.md`.
3. Deploy do backend (`crescercomdelivery`); como o frontend também muda, o deploy manual cobre os dois.
4. Habilitação gradual: Saci (já coberta) → uma empresa piloto sem iFood, pela tela de Acessos → demais.
5. Remoção do `OU ifood`: NÃO por tempo — só depois das verificações do §8.5.

**Rollback**: reverter o deploy (código) — as fórmulas voltam sozinhas, pois nada é gravado; depois, se necessário, `123_rollback.sql` (apaga só `checklist_operacional`; quem tem `ifood` continua com acesso enquanto o `OU ifood` existir). Se o `OU ifood` já foi removido, voltar o código **antes** do rollback SQL.

## 6. Critérios de homologação
- 18/25/43 no cenário D e identidade por pedido nos dados reais (já demonstrado).
- Saci: mesma contagem de pedidos, ativos e alertas antes/depois (demonstrado em 14 instantes); poller, credenciais e conexões intocados (nenhum arquivo do módulo `ifood` foi alterado).
- Unidade sem iFood: abre, aviso informativo, zero número, zero chamada ao iFood.
- Duas unidades da mesma empresa sem mistura (teste de serviço) e usuário de outra empresa/unidade com 403 (gate + tenant do token).
- Conferência visual na TV/HDMI antes de ligar o piloto.

## 7. Decisões que continuam abertas
1. Metas novas (§4).
2. Vida e a identidade: hoje a vida inclui pedidos sem DSP e as 5 entregas com CON tardio; se quiser a identidade também nas médias, a vida só entraria quando preparo e entrega forem válidos.
3. Reconciliar os 3 `CONCLUDED` sem `status_oficial_em` a partir de `ifood_eventos` (altera dados — exige aprovação).
4. Reconfirmar a numeração (123) no merge e o momento de remover o `OU ifood`.

## 8. Revisão complementar (17/10/2026)

### 8.1 Metas: meta × limite de alerta × referência estatística
- **Achado:** as metas do Checklist **não são persistidas**. Vivem só na memória da aba (`estado.metas`, comentário no código: "persistir exige migration"); a cada carregamento a tela volta a `METAS_EXEMPLO`. Não existe meta por unidade no banco e, portanto, **não há meta existente a substituir**.
- O sistema já separa dois conceitos: **meta** (`meta`, o limite em minutos) e **limite de alerta** (`avisoPct`, a partir de quantos % da meta o pedido em andamento fica "próximo da meta"). Faltava o terceiro: a **referência estatística** — agora `REFERENCIA_P75` (+ `REFERENCIA_P75_INFO`), um conjunto à parte.
- Referência proposta (p75, uma unidade, 7 dias): preparo **16,3**, entrega **12,6**, vida **28,1** min.
- Como entra: botão **"Usar referência observada (p75)"** no diálogo de metas. Ele só **preenche o formulário**; a tela só muda se a pessoa clicar em "Aplicar metas", e o valor continua valendo apenas naquele aparelho. `METAS_EXEMPLO` (12/35/45) **não foi alterado** — nada é substituído em silêncio e o p75 de uma unidade não vira padrão das outras.
- **Meta por unidade de verdade** exige persistência (migration nova + endpoint + permissão). Esboço, para decisão futura: tabela `checklist_metas_unidade(organizacao_id, unidade_id, indicador, meta_min, aviso_pct, origem)` com `origem in ('configurada','referencia')`, RLS por tenant, leitura por `checklist.visualizar` e escrita por permissão de gestão. Não implementada.

### 8.2 Regra final das médias
Dois conceitos de vida, **nunca somados nem comparados entre si**:

| Indicador | Quem entra | Amostra |
|---|---|---|
| Preparo | entregas **não canceladas e não agendadas** com PLC e DSP válidos (inclui as já despachadas e ainda não concluídas) | `preparo.amostras` |
| Entrega | entregas **concluídas** (agendadas incluídas) com DSP e CON válidos | `entrega.amostras` |
| **Vida total** | entregas concluídas e não agendadas com PLC e CON válidos — **mesmo sem DSP** | `vida.amostras` |
| **Vida decomposta** | o subconjunto da vida total com PLC, DSP e CON válidos; só aqui preparo + entrega = vida | `vida.decomposta.amostras` (+ `semSaida` = quem ficou só na total) |

- Fora de **todos**: cancelados (nunca contam como concluídos), pedidos de teste, retirada e pedido sem detalhes. Horário ausente nunca é preenchido; duração ≤ 0 ou acima do teto é descartada e contada.
- Cada indicador devolve `conjunto` (texto do que entra), `amostras` e os contadores de exclusão; a tela mostra o conjunto no `title` da "Média hoje", a amostra ao lado da média e, no card da vida, a linha "Com os 3 horários (n pedidos): preparo X + entrega Y = vida Z".
- Por que a soma das médias de preparo e entrega pode não bater com a média da vida total: são conjuntos diferentes. Dentro da **decomposta** bate (diferença só do arredondamento de 0,1).

### 8.3 Os pedidos `CONCLUDED` sem `status_oficial_em` — diagnóstico (somente leitura)
São **4**, não 3 (3 entregas + 1 retirada), todos da Subway Saci de 10/10/2026. **Não é defeito da projeção de eventos.**
- **Causa:** foram fechados à mão pela reconciliação pontual do commit `d76a243` ("reconciliação pontual dos 4 pedidos… que o Events não chegou a concluir"; branch `chore/checklist-scripts-validacao-reconciliacao`), executada uma única vez em produção e documentada para gravar exatamente `status_oficial='CONCLUDED'` e `status_oficial_em=NULL`. Marcas que confirmam: `status_oficial_evento_id` aponta para o **último evento real** (CFM/RTP/DSP), não para o CON; os eventos CON só chegaram depois (recebidos 21:58–22:01 de 10/10, na recuperação do intervalo) e foram gravados como `IGNORADO / mesmo_status`.
- **Eventos recebidos e persistidos corretamente?** Sim: os 4 CON existem em `ifood_eventos` com `event_created_at` real (a retirada: 21:55:39 — o cliente retirou 4 h depois do pronto).
- **Máquina de estados:** `decidirTransicao` responde `mesmo_status` quando o estado já é igual, sem olhar se o horário está vazio. Esse é o único ponto em que o horário não é recuperado. Todo evento aplicado pelo Events **sempre** grava `status_oficial_em` (`aplicarStatusPedido`).
- **Pode ocorrer com outros eventos?** Só se alguém voltar a fechar pedido à mão. Nos 1.266 pedidos lidos, estes 4 são os únicos terminais sem horário; na janela de recuperação (414 eventos, 48 pedidos) não há outro caso.
- **Efeito no Checklist:** vida e entrega desses 4 ficam "sem horário de conclusão" e fora das médias (nada inventado). Eles contam como concluídos no painel.
- **Correção proposta (NÃO implementada):** em `decidirTransicao`, aceitar o evento oficial quando o estado é igual **e** `status_oficial_em` está vazio (só para preencher o horário, via o compare-and-set já existente). Corrige casos futuros; os 4 existentes só se corrigem com reprocessamento ou `UPDATE` pontual, que altera dado de produção e exige autorização (e o rollback da reconciliação aborta se o horário deixar de ser nulo — alinhar antes).
- **Testes de regressão:** movidos para o plano separado (§9.3); o rascunho não faz parte deste PR.

### 8.4 Numeração das migrations (histórico — superado pelo §10.1: a migration agora é a 123)

| Onde | Migrations ≥ 120 |
|---|---|
| `origin/main` | nenhuma (a última é a 119) |
| `feat/financeiro-agente1-fundacao` | 120 (+ rollback) |
| `integracao/gestao-financeira` | 120 e **121_gestao_financeira_dominio** (+ rollbacks); a pasta de coordenação dos agentes planeja ainda a **122** |
| `feat/checklist-universal-tempos` (esta) | **121_checklist_operacional_modulo** |

- **Conflito real:** a minha 121 colide com a 121 da trilha financeira (que a coordenação dos agentes só aprova **em conjunto com a 122**). Nenhuma depende da outra: a minha só mexe em `modulos`, `organizacao_modulos` e `unidade_modulos`.
- Recomendação: renomear a minha para **123** (ou o próximo livre depois que a financeira entrar). Mantida como 121 em desenvolvimento, conforme pedido, até a ordem ser validada. Ao renomear: arquivos `121_*`, o texto interno, `checklist-operacional-modulo.test.js`, os comentários de `routes.js`/`config.js` e as duas listas de "posteriores conhecidas" (`comunicacao-arquitetura-agendamento.test.js`, `ifood-migration-103.test.js`) — que também precisarão listar 120/121/122 quando a financeira entrar.
- Nada foi aplicado em lugar nenhum.

### 8.5 Gate: de "`checklist_operacional` OU `ifood`" para o gate exclusivo
Estado atual: backend `requireAlgumModulo(CHECKLIST_OPERACIONAL, IFOOD)`; menu com `modulo` + `moduloTransicao`. A migration copia o módulo novo para quem já tem `ifood`.

**A passagem de 8 h NÃO basta.** Só remover o `OU ifood` quando TODAS estas verificações estiverem registradas:
1. Migration aplicada e conferida por consulta: `organizacao_modulos` e `unidade_modulos` com `checklist_operacional` = exatamente as empresas/unidades que têm `ifood` (e nenhuma a mais).
2. Nenhuma empresa que usa o Checklist fica sem o módulo novo, inclusive empresas/unidades criadas depois da migration.
3. Sessões: confirmar a vida real da sessão de contexto (`sessoes_contexto.modulos` fica congelado) e a ausência de sessão ativa sem o módulo novo (consulta em `sessoes_contexto`), inclusive o perfil de **exibição** (TV), cuja sessão é de 8 h absolutas.
4. Telas de TV recarregadas (o JavaScript antigo em memória ainda usa o menu antigo).
5. PR separado, pequeno, com rollback: se a remoção causar 403, basta recolocar `MODULOS.IFOOD` no gate.

Sem isso o `OU ifood` permanece. O custo de mantê-lo: enquanto existir, retirar `checklist_operacional` de uma empresa que tenha `ifood` não fecha o Checklist para ela.

### 8.6 Resultados dos testes
Ver o relatório do checkpoint (categorias: introduzidas pela branch × main × ambiente × puladas × autorização/isolamento × cálculo/integridade temporal).

## 9. Resolução dos bloqueios pré-PR (17/10/2026)

### 9.1 Migration: numeração e dependências da trilha financeira (histórico — superado pelo §10.1)
Inspeção (todas as branches locais e remotas, `git ls-tree`, worktrees e a pasta de coordenação dos agentes; **nenhum arquivo financeiro foi tocado**):

| Branch / fonte | Estado |
|---|---|
| `origin/main` | `8d32196`, última migration **119** |
| `feat/financeiro-agente1-fundacao` | 120 |
| `integracao/gestao-financeira` (`f2b1a40`) | 120 e 121 em `database/migrations/`; **122 ainda provisória** em `docs/gestao-financeira/proposta-122/` (122 + 122b, decidido em **um arquivo só**) |
| Coordenação dos agentes (05-STATUS, 17/10 17:22) | nada publicado; módulo financeiro desabilitado; 122 NÃO promovida; M1/O-1 aguardando revisão; BL-01 (publicar `integracao/gestao-financeira`) pendente de decisão do usuário |

- **Ordem de integração: ainda NÃO definida** (a financeira não foi publicada e não há decisão sobre quem entra primeiro). Por isso a migration do Checklist **continua provisória como 121** em desenvolvimento.
- **Faixa financeira conhecida: 120–122.** O próximo número livre hoje é **123** (conferido em todas as branches; nenhuma outra migration ≥ 123 prevista). A confirmação precisa ser refeita no momento do merge, porque a financeira ainda pode ganhar migrations (M1/O-1).
- **Dependência registrada:** nenhuma de dados (a minha só escreve em `modulos`, `organizacao_modulos`, `unidade_modulos`; a financeira usa tabelas próprias e, no máximo, seu próprio módulo). A dependência é só de **numeração única e monotônica** em `main`: quem entrar depois pega o próximo número; aplicar em qualquer ordem é seguro.
- **Regra de decisão no merge:** número do Checklist = maior número existente em `main` e nas branches financeiras já integradas + 1 (hoje, 123). Se o Checklist entrar antes da financeira, a financeira terá de reconhecer o 123 (ela já planeja 120–122, então o espaço fica livre).
- **Travas de numeração dos testes** (`comunicacao-arquitetura-agendamento.test.js`, `ifood-migration-103.test.js`): já aceitam **121 e 123** do Checklist. Quando a financeira entrar, essas duas listas também precisarão das migrations 120–122 dela (a alteração é da branch financeira ou do merge; **não** foi feita aqui).
- **Renumeração testada em escopo descartável:** copiei migrations/testes/código para uma pasta temporária, renomeei `121_*` → `123_*` (arquivos e texto interno) e rodei as 3 suítes de numeração/módulo: 53/53 passam. O teste do módulo (`checklist-operacional-modulo.test.js`) agora descobre o arquivo pelo nome, então a renumeração real é só renomear os 2 arquivos e ajustar os comentários (`routes.js`, `config.js`, `modulos.js`).
- **Rollback preservado** (`121_rollback.sql` inalterado, testado: só apaga `checklist_operacional`, vínculos antes do catálogo, nunca `ifood`).

### 9.2 Verificação visual (Playwright, Chrome real, ambiente isolado)
Execução com `CHECKLIST_PLAYWRIGHT_PATH` apontando para o Playwright já instalado em `worker-martinbrower/node_modules` e `CHECKLIST_BROWSER_CHANNEL=chrome` (Chrome do Windows). Servidor local em memória + fixtures; **nada de produção, Supabase ou iFood**.
- **Suíte existente do Checklist (40 testes):** na 1ª rodada, **39 passam, 1 falhou: Televisão 1280×720 ("TV sem rolagem")**. **É regressão introduzida pela branch**: o mesmo teste passa na `origin/main` (conferido num diretório descartável extraído do `origin/main`). Causa: a linha nova da vida decomposta, o texto de detalhe do preparo e o subtítulo "(preparo + entrega)" deixaram o card da vida mais alto. **Corrigido** (textos encurtados, explicações movidas para `title`); depois da correção a suíte inteira passa (40/40).
- **Nova suíte** `checklistOperacionalUniversal.browser.test.js` (7 testes, todos passam): módulo só `checklist_operacional`; unidade com iFood (definições novas, amostras, dois trechos na decomposição); unidade sem iFood em TV 1920×1080, 1280×720 e Tablet 1024×768 (aviso informativo, nenhum número, nenhum cronômetro, sem rolagem); cronômetros que andam e pedido novo que aparece no ciclo seguinte; mensagens "Sem conexão" (503) e "Sem acesso" (403, sem citar "pedidos iFood"); diálogo de metas com a referência p75; Tablet em 4 formatos sem rolagem horizontal. **Console sem erros em todos.**
- **Evidências**: capturas em `crescer-checklist-universal-evidencias/universal/` (11 imagens) e `…/base/` (15 imagens da suíte existente, todas as resoluções).
- Inspeção visual das capturas (não só asserções): com iFood, o card da vida mostra a linha "Com os 3 horários (6 pedidos): 14,5 + 20,0 = 34,5 min", a barra com dois trechos e o detalhe do preparo; sem iFood, aviso no topo, cards "Sem medição" com "—", listas vazias e Status "Sem medições hoje"; o diálogo mostra a referência p75 e o botão, com "12 / 35 / 45" como padrão até alguém clicar.
- Observações (não são falhas): (1) o texto da linha decomposta e do detalhe do preparo é pequeno para TV (é informação secundária; o dado principal está nos cards); (2) como o padrão de meta continua 12 min de preparo, o Status mostra "Preparo acima da meta" com a definição nova — é exatamente o descompasso que a referência p75 resolve quando a unidade a escolher.

### 9.3 `decidirTransicao`: fora deste PR
Diagnóstico e plano próprios em `crescer-checklist-universal-evidencias/plano-decidirTransicao-estado-final-sem-horario.md`. O teste de caracterização que eu tinha escrito saiu deste worktree (rascunho em `…/ifood-events-estado-sem-horario.test.js.proposto`). Nada do módulo iFood foi alterado.

### 9.4 Preservado
Indicadores (preparo PLC→DSP, entrega DSP→CON, vida total PLC→CON, vida decomposta com PLC+DSP+CON), amostras exibidas, `METAS_EXEMPLO` intacto, referência p75 separada (só preenche o diálogo), gate `ifood OU checklist_operacional`, permissão `checklist.visualizar` e isolamento multiempresa/multiunidade.

### 9.5 Resultado final dos testes (rodada pré-PR)
- **Frontend** (`--test-concurrency=1`, Playwright + Chrome ligados): 1.593 testes — 1.578 passam, **4 falham**, 11 pulados. As 4 falhas são `iFood — pedidos sem Financial, no navegador` (`ifoodOrderOnly.browser.test.js`) e **reproduzem na `origin/main`** (conferido num diretório descartável). Todas as suítes do Checklist, inclusive as de navegador (40 + 7), passam.
- **Backend** (`test/*.test.js`): 5.334 testes — **3 falhas conhecidas na main** ("distribuições recompõem mês…" e "selecionarPerfil" ×2), 25 pulados. Numa rodada feita com o computador sob carga (frontend em paralelo) `bonificacao-importacao-diaria` falhou uma vez; isolado, passou 2 de 2 (intermitente por carga).
- **Intermitência por carga** (não por defeito): rodando backend e frontend ao mesmo tempo, 3 testes de navegador do Checklist estouraram tempo; em série, passam.
- **Regressões introduzidas pela branch:** nenhuma ao final. Houve duas no caminho, ambas corrigidas: travas de numeração 088/103 e a rolagem da TV 1280×720.
- **A suíte global NÃO está totalmente verde.**

## 10. Homologação pré-merge (Checkpoint F, 17/10/2026)

### 10.1 Migration definitiva: 123
- Estado verificado em 17/10 (fetch de todas as branches): `origin/main` = `8d32196`, última migration 119; **a financeira não está integrada à `main`**. `integracao/gestao-financeira` (`f2b1a40`) tem 120 e 121 em `database/migrations/` e a 122 só como proposta em `docs/gestao-financeira/proposta-122/`; nenhuma migration ≥ 123 existe ou está planejada em nenhuma branch.
- Como a trilha financeira reservou 120–122, a migration do Checklist foi renomeada para **`123_checklist_operacional_modulo.sql`** (+ `123_rollback.sql`), atualizando texto interno, comentários (`routes.js`, `config.js`, `modulos.js`), as duas travas de numeração (088/103: agora listam só a 123) e o teste do módulo (que descobre o arquivo pelo nome).
- **Continua sujeita a reconciliação no merge**: número = maior existente em `main` + 1. Sem dependência de dados com a financeira.
- Dry-run anterior (121 → 123 em cópia descartável) e a suíte atual confirmam que a renumeração não quebra nada.

### 10.2 Segurança e isolamento — Postgres REAL e descartável
Cluster local novo (PostgreSQL 17, porta 55411, vazio, fora do projeto). O teste recusa banco que não seja local e não vazio. Suíte `backend/test/checklist-operacional-pg.test.js` (pula sozinha sem `CHECKLIST_PG_URL`): **13/13 passam**.
- Aplica as migrations REAIS 101/102/103 (`ifood_pedidos`/`ifood_eventos`) e a do módulo, sobre tabelas mínimas com a mesma DDL da base; roda o **repositório e o service reais** do Checklist por um adaptador que executa SQL de verdade (o PostgREST não existe nesse ambiente — limitação: o adaptador é meu; a fidelidade dos filtros foi conferida por **mutação**: retirar o filtro de unidade do repositório faz 2 testes falharem).
- Isolamento: unidade integrada vê só os próprios pedidos; **mesma empresa, outra unidade (sem integração) não vê nada**; outra empresa vê só os seus; **acesso cruzado** (par org+unidade trocado, em 4 combinações) devolve vazio; escopo ausente é recusado; abertos antigos contam só na unidade dona.
- **RLS**: `anon` e `authenticated` (com privilégios padrão, como no Supabase) veem 0 linhas e não conseguem inserir em `ifood_pedidos`; `service_role` lê.
- **Migration em dados existentes**: antes sem o módulo; aplicar dá o módulo SÓ a quem tinha `ifood` (empresa e unidade), nada a ninguém mais; o acesso efetivo (empresa ∩ unidade) ganha A1 e B1, **não** ganha a unidade órfã (empresa sem `ifood`); idempotente; rollback remove só o módulo novo (ifood e demais intactos), é idempotente e reaplicável; não toca pedidos.
- HTTP (sem banco; auth/módulo/permissão reais): o módulo novo sozinho abre; o `ifood` sozinho (sessão antiga) abre; **sessão da TV** antiga (só `ifood`) abre; nenhum dos dois = 403; módulo sem permissão = 403; unidade/empresa na query ou em cabeçalhos são ignoradas (tenant só do contexto; o controller não lê query/corpo/params/headers); POST/PUT/PATCH/DELETE em `/resumo` = 404.
- **Banco de testes do projeto (Supabase de teste)**: continua indisponível (25 testes de backend pulam por "alvo não confirmado como teste"). O substituto acima é um Postgres descartável; **não** cobre PostgREST nem as políticas RLS por usuário do Supabase (o Checklist lê só pelo backend com `service_role`).

### 10.3 Regressão dos indicadores
Mantidas as definições (preparo PLC→DSP; entrega DSP→CON; vida total PLC→CON; vida decomposta PLC+DSP+CON). Cobertas por `checklist-operacional-calc` (43), `-medias` (12), pelo teste em Postgres real (preparo 15 + entrega 25 = vida 40; retirada sem tempos; teste/agendado fora), pelos testes de modelo/tela do frontend e pela suíte de navegador (cronômetros, decomposição, diálogo p75, TV/Tablet). Nenhuma alteração na máquina de estados do iFood.

### 10.4 Plano de implantação
`docs/checklist-universal-plano-implantacao.md` (pré-condições, ordem das migrations, backup/rollback, sequência do deploy, validação da Saci, piloto sem iFood, isolamento, ativação gradual, monitoramento, critérios de interromper/reverter). **Não executado.**

### 10.5 Revisão automatizada do PR (code-review, nível alto) — 8 achados e destino
| # | Achado | Destino |
|---|---|---|
| 1 | O `OU ifood` nunca expira; tirar `checklist_operacional` de uma empresa com `ifood` não revoga o acesso | **Aceito e documentado** (gate transitório pedido; remoção só em etapa própria — §8.5). O toggle do módulo novo só fecha empresas sem `ifood` enquanto o `OU` existir |
| 2 | Numeração 121 colide com a financeira | **Corrigido**: migration agora é **123** (§10.1); sujeita a reconciliação no merge |
| 3 | `modo` virava `sem_integracao` com loja vinculada sem credencial ou com pedidos existentes | **Corrigido**: `sem_integracao` só com `sem_loja_vinculada` E sem nenhum pedido a mostrar; teste novo |
| 4 | Cronômetro do preparo para pedido sem `tipo`/sem PLC | **Mantido de propósito** (é alerta em tempo real, não média; esconder o relógio de um pedido em andamento seria pior); comentário no código |
| 5 | `REFERENCIA_P75` embute dado de uma unidade e é oferecida a todas | **Mantido por decisão** (referência opcional, só preenche o formulário, rotulada "em uma unidade, 7 dias"); risco residual registrado |
| 6 | `agregarEntrega` usava elegibilidade diferente da dos outros indicadores | **Corrigido**: os três filtram `order_type === "DELIVERY"` |
| 7 | Medições repetidas por pedido e `foraDosTempos` recalculado 3× | **Corrigido**: calculado uma vez e reaproveitado |
| 8 | `requireAlgumModulo` duplicava `requireModulo`; mensagem citava só o 1º módulo | **Corrigido**: `requireModulo(id)` = `requireAlgumModulo(id)`; mensagem lista todos ("A" ou "B") |

### 10.6 Resultado final dos testes (rodada do Checkpoint F)
- **Backend** (`test/*.test.js`, com `CHECKLIST_PG_URL` apontando para o Postgres descartável): 5.353 testes — 5.325 passam, **3 falham** (as mesmas da `main`: "distribuições recompõem mês…" e "selecionarPerfil" ×2), 25 pulados (banco de teste do projeto não confirmado). A suíte nova em Postgres real (13/13) roda dentro desse total.
- **Frontend** (série, Playwright + Chrome): 1.593 testes — 1.578 passam, **4 falham** (`iFood — pedidos sem Financial, no navegador`, também falham na `main`), 11 pulados (Playwright de outros módulos).
- Autenticação/permissões/módulos/Checklist (subconjunto, após as correções): 168/168.
- **Nenhuma regressão introduzida por esta branch. A suíte global NÃO está totalmente verde.**
