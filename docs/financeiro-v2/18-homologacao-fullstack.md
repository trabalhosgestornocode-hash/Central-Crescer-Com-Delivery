# Financeiro v2 — 18. Homologação full stack isolada (Execução 08B)

Data: 13/11/2026. Branch local `feat/financeiro-v2-homologacao-fullstack`, derivada de `5052c05` (08).

> **Homologação técnica sintética, não homologação operacional real.**
> - Identidades, empresa, unidades e valores são fictícios.
> - Só 127.0.0.1. Credenciais geradas localmente, fora do Git.
> - Produção não acessada; o financeiro antigo não foi tocado.

## 0. Decisão de integração (registrada a pedido do usuário)

O **login, o gateway e as identidades sintéticas existem somente para esta homologação.**

A integração definitiva **reaproveitará**:
- o login da plataforma Crescer com Delivery;
- a seleção de empresa/unidade (`requireAuth` + `requireContexto`);
- a navegação.

**Não haverá login financeiro separado.** O Financeiro v2 mantém próprias apenas:
- as **permissões por ação** (concessões `financeiro_v2.*`, gravadas e auditadas);
- a **proteção PostgreSQL** (sessão de banco, RLS por unidade, autorização por ação, funções protegidas).

## 1. Arquitetura integrada

```
navegador ──(cookie HttpOnly, SameSite=Strict, CSRF por sessão)──▶ serviço da aplicação (127.0.0.1:5181)
   serviço: credencial fv2_app (aplicacao.json) ──(Bearer do usuário)──▶ gateway de teste (127.0.0.1:5182, processo separado)
   gateway: credencial fv2_autoridade (gateway.json) ──fv2_abrir_sessao──▶ PostgreSQL isolado (banco fv2_teste_homologacao_*)
   serviço ──fv2_assumir_sessao(token)──▶ PostgreSQL: RLS por unidade + autorização por ação + funções protegidas
   cofre: disco local (pasta da homologação), hash conferido a cada abertura
```

**Scripts** (`backend/scripts/fv2-homologacao.mjs`):
- `preparar`: cria o banco a partir do banco-modelo do ambiente isolado; gera identidades e credenciais; faz a carga sintética.
- `iniciar`: sobe o gateway (filho) e o serviço.
- A interface é a mesma da demonstração, com modo homologação: seletor de perfil oculto, usuário logado, "Sair" e redirecionamento ao login.

**Limites (sem afirmar isolamento de produção):**
- Os processos rodam no mesmo usuário do Windows: o serviço *poderia* ler o `gateway.json`. Ele não lê, mas isso não é garantia do sistema operacional.
- As sessões do serviço e do gateway ficam em memória: reiniciar exige novo login (falha fechada, testado).
- A carga inicial é feita como "DBA": usa a autoridade de teste com fixture, **sem** `conceder`/`revogar`. O administrador vem do provisionamento atestado.
- Resíduo de configuração: um banco de teste sem uso (`fv2_homolog_*`) foi criado pela primeira tentativa de `preparar`, antes da correção do nome. Fica no cluster descartável; nada usa esse banco.

## 2. Configuração local (sem segredos)

| Item | Valor |
|---|---|
| Pasta | `%LOCALAPPDATA%\fv2-homologacao\` (fora do repositório): `gateway.json`, `aplicacao.json`, `credenciais-sinteticas.txt`, `cofre/`, `eventos-gateway.jsonl` |
| Endereços | Serviço 127.0.0.1:5181; gateway 127.0.0.1:5182; PostgreSQL 127.0.0.1:54329 |
| Cookie | `fv2_sid` HttpOnly, SameSite=Strict, Path=/ |
| Escritas | Mesma origem + JSON + token CSRF da sessão + `confirmar: true` |
| Logs | Eventos do gateway sem token e sem senha (conferido em teste) |

## 3. Contratos de autenticação (o que o login real precisará fornecer)

| Contrato | Origem futura |
|---|---|
| Identidade validada (`user.id`, `ativo`) | `requireAuth` |
| Organização e unidade escolhidas | `requireContexto` |
| Expiração e revogação do contexto | Sessão de contexto da plataforma; ao revogar, chamar `fv2_encerrar_sessoes` |
| Nível de autenticação confiável (`aal`) para atestar o administrador inicial | A plataforma precisa expor |
| Credencial `fv2_autoridade` | Fora do processo comum da aplicação |

## 4. Permissões granulares (Fase C)

**Ações novas** (migração local `0013_acoes_granulares.sql`; núcleo e banco):

| Ação | O que permite |
|---|---|
| `aprovar` | Aprovar ou rejeitar proposta |
| `aplicar` | Aplicar proposta **já aprovada** |
| `revogar` | Revogar acessos (≠ `conceder`) |
| `confirmar_importacao` | Confirmar ou rejeitar importação (≠ `importar`) |
| `reabrir` | Reabrir competência homologada (antes: `revisar`) |

| Garantia | Como |
|---|---|
| **Migração restritiva** | Nenhuma concessão anterior recebeu as ações novas (testado: perfil "legado" com `revisar` não aprova) |
| **Banco** | Mapa tabela × operação **remedido**. Proposta e competência conferidas por **transição de estado** (gatilhos): APROVADA/REJEITADA exige `aprovar`, APLICADA exige `aplicar`, reabrir exige `reabrir`. `fv2_gravar_concessao`: acrescentar exige `conceder`, retirar exige `revogar` |
| **Alcançar/reservar ≠ alterar** | USING das políticas de UPDATE = qualquer ação de escrita (necessário para reservar registros referenciados, ex.: a conta do caixa ao aplicar uma venda); WITH CHECK = só as ações da tabela. Quem tem escrita mas não a ação certa recebe **erro explícito** |
| **UPDATE silencioso** | O adaptador confere as linhas alteradas. Se a linha está visível e intacta na versão esperada e nada mudou → **acesso negado**, nunca sucesso nem conflito a repetir (testado) |
| **Concorrência** | Revogação de `aplicar` × aplicação, em rodadas: nenhuma aplicação gravada depois da revogação |

## 5. Fluxo de caixa: esperado × observado (Fase E)

Teste: `fluxo-de-caixa-livro.test.js`. Livro **escrito à mão**, item a item, com valores fictícios. O esperado de cada período é somado no próprio teste a partir da lista do livro.

| Conferência | Esperado | Observado |
|---|---|---|
| Realizado 01–15/10 (entradas / saídas) | 90,00 / 115,00 | igual |
| Saldo consolidado (início / hoje) | 600,00 / 575,00 | igual |
| Banco / caixa (hoje) | 470,00 / 105,00 | igual |
| Transferência interna anulada | 25,00 (consolidado inalterado) | igual |
| Previsto até 31/10: entradas / saídas | 50,00 / 34,00 (inclui estimativa de 15,00) | igual |
| Projetado em 31/10 | 591,00 (parcial: estimativa + recebível sem previsão) | igual |
| Recebível sem previsão | 20,00, **sem data inventada** | igual |
| Contas a pagar (recorrência estimada **não** é dívida) | 79,00 | igual |
| Séries por **dia** e **semana**, período personalizado, conta e consolidado | Soma do livro em cada intervalo | igual em todos |
| Setembro sem âncora | Saldo **desconhecido** (nulo, não zero); o recebimento de outubro não entra | igual |
| Saldo negativo; conta sem âncora | −5,00 aparece; projeção desconhecida com motivo | igual |

**Achado (regra do motor, não defeito).** A recorrência estimada é suprimida no mês em que já existe obrigação constituída do mesmo fornecedor e categoria. A previsão pode subestimar, nunca duplica. O primeiro livro errava por desconsiderar isso; foi corrigido no **livro**, não no motor.

## 6. Consultas otimizadas (Fase F)

**Não otimizadas nesta execução:**
- Vendas;
- recebimentos consolidados;
- Central;
- Pendências;
- Fechamento.

**Causa precisa:** essas telas montam a visão de vendas (`montarVisao`) sobre o histórico inteiro. A apuração de pendências e impedimentos usa vínculos de outros meses: liquidação posterior, conciliação entre períodos, propostas e registros de fonte de importações que cruzam o mês.

**Como corrigir sem alterar resultado:** carregar a competência e o **fecho de vínculos** dela (venda → pagamentos → recebíveis → liquidações → movimentações → documentos, e o inverso), com prova de equivalência nos cenários pedidos.

Não foi feito nesta rodada porque o orçamento foi para a pilha completa, as permissões granulares e o fluxo de caixa, e uma otimização apressada arriscaria a exatidão.

**Classificação: FAIL**, com gargalo medido no § 11.

## 7. Evidências de navegador (pilha completa: gateway + PostgreSQL)

Login com teclado; ações por cliques nos formulários reais. Os dados vêm do PostgreSQL da homologação.

| Jornada | Resultado |
|---|---|
| **Gestor** | Login → Visão Geral (bruto 15.364,50 = DRE = Vendas), Contas a Receber, Contas a Pagar (10.750,90), Caixa, Central, Configurações; abriu uma venda (detalhe). Seletor de perfil oculto; usuário logado exibido |
| **Operador** | Login → duas unidades → Central: importou arquivo sintético → prévia real (3 válidos, 0 rejeitados) → confirmou → gerou propostas (3, em outubro) → sem botões de aprovar/aplicar. Pedido forjado (mesma sessão, CSRF válido): aprovar **403**, aplicar **403**; sem CSRF: **403 CSRF** |
| **Aprovador** | Aprovou pela tela, com justificativa. O histórico mostra "Aprovada (não aplicada)"; não vê "Aplicar"; aplicação forjada **403** |
| **Aplicador** | Aplicou a aprovada pela tela → venda **persistida** (Vendas de outubro: 1 venda, R$ 28,00). Repetição: idempotente, continua 1. Aplicar proposta não aprovada: **409** |
| **Administrador (MFA)** | Login com segundo fator → consultou concessões → concedeu `documentos` ao gestor (persistido, com justificativa) → autoconcessão recusada na tela ("Ninguém concede nem revoga o próprio acesso") → revogou → gestor negado **imediatamente (403)** |
| **Documentos** | Gestor autorizado: PDF visualizado inline e baixado; PDF com conteúdo ativo só baixa (visualizar recusado); id inventado **404**; outra unidade **403**; após revogação **403** |
| **Reinício** | Serviço e gateway reiniciados: a sessão antiga cai (falha fechada) e o novo login funciona. Dados preservados (venda de outubro, bruto de setembro) |
| **Celular (375 px)** | 8 áreas sem rolagem horizontal |
| **Troca de competência e unidade** | Competência setembro → outubro (propostas de outubro aparecem); operador com duas unidades |
| **Fechamento (outubro)** | Preliminar ✓; homologação **bloqueada** (impedimento real: lançamento com classificação provisória) ✓; propostas abertas rejeitadas com justificativa ✓; reabertura sem justificativa recusada ✓ |

**Bloqueio da jornada visual de fechamento.** **Não existe na interface a ação de reclassificar lançamento** (resolver a classificação provisória). Sem ela, a homologação e a reabertura de uma competência *homologada* não podem ser concluídas pelo navegador. O critério não foi alterado.

O ciclo completo (bloqueio → resolução → homologação → liquidação posterior → alteração proibida → reabertura → nova homologação → reprodução) está comprovado no PostgreSQL pela suíte (`homologacao-competencia-sintetica`). Pelo navegador ficou **PARCIAL**.

**Não executado no navegador:**
- teclado/foco/modais em profundidade (só login por teclado e Esc em modais);
- paginação;
- sessão expirada pela interface (coberta no teste do gateway).

## 8. Documentos (Fase G)

Ver § 7. Também cobertos por teste:
- hash, versões e substituição (06D);
- adulteração e reinício do cofre (08).

Nenhum caminho de arquivo é exposto: as referências são opacas.

## 9. Recuperação (Fase H)

| Teste | Resultado |
|---|---|
| Reinício do serviço + gateway (navegador) | Sessões caem; dados preservados |
| Conexão perdida, backup e restauração do banco sintético, cofre (08) | Mantidos e passando nesta branch |
| Revogação concorrente × aplicação | Teste granular |

**Não testado:**
- reinício do PostgreSQL durante uma operação;
- interrupção durante conciliação e homologação no full stack (cobertas por rollback em testes de núcleo e banco da 07/08).

## 10. Testes adversariais (Fase I)

Passando nesta branch:
- suítes da 07B e da 08 (sem sessão, organização e unidade manipuladas, token falso/revogado, MFA insuficiente, autoconcessão, SQL direto, RLS, pool, documentos de outra unidade, concorrência);
- novos granulares (aprovar≠aplicar, revogar≠conceder, importar≠confirmar/homologar, conciliar≠reabrir, UPDATE silencioso, concorrência revogação×aplicação);
- no serviço integrado (navegador): CSRF ausente → 403, ações forjadas sem permissão → 403, origem/JSON exigidos.

**Mutação:** não reexecutada para as barreiras novas da 0013 nesta rodada (**NÃO TESTADO**). As mutações da 07B e da 08 seguem válidas.

## 11. Desempenho

Medição real: 12 meses sintéticos (4.800 vendas, 3.600 recebíveis, 480 obrigações, 6.480 lançamentos, 480 propostas, 84 documentos), PostgreSQL isolado, mesmo script e volume da 07B.

| Consulta (mediana) | 07B depois | 08B (com autorização por ação) |
|---|---|---|
| Apuração / DRE | 34 ms | 37 ms |
| Visão Geral | 303 ms | 292 ms |
| Contas a pagar | 46 ms | 48 ms |
| Contas a receber | 222 ms | 200 ms |
| Caixa e bancos | 250 ms | 209 ms |
| Vendas | 429 ms | 388 ms |
| Central | 424 ms | 408 ms |
| Pendências | 393 ms | 393 ms |
| Fechamento | 407 ms | 417 ms |
| 10 telas simultâneas | 1.891 ms | 1.805 ms |
| Memória (RSS / heap) | 272 / 187 MB | 358 / 260 MB |

A autorização por ação (uma subconsulta por comando) não teve custo perceptível; as diferenças estão no ruído da medição.

**Gargalos sem mudança:** Vendas, Central, Pendências e Fechamento (~0,4 s em 12 meses), crescendo com o histórico.

**Memória:** o pico de memória variou entre as execuções (o coletor de lixo do Node); não é comparação controlada.

## 11b. Testes e regressões

| Suíte | `5052c05` | Agora |
|---|---|---|
| Financeiro v2, memória | 301 | **306**, todos passando |
| Financeiro v2, PostgreSQL | 301 | **306**, todos passando |
| Frontend | 1.931 | 1.931, 0 falhas |
| Backend | 22 falhas e 1 cancelado | **Idêntico** a `5052c05` |

O teste do frontend do fluxo local (receber → aplicar) foi ajustado à separação de papéis:
- o operador da demonstração recebe **403** ao aprovar e ao aplicar e não vê os botões;
- aprovar e aplicar passam a ser feitos pelo administrador;
- idempotência e efeito único na DRE mantidos.

## 12. Matriz de homologação (técnica sintética)

| # | Domínio | 08 | 08B | Evidência / risco |
|---|---|---|---|---|
| 1 | Segurança por ação | PASS | **PASS** | Ações granulares no núcleo e no banco; transições; UPDATE silencioso → negado. Risco: mutação das barreiras da 0013 não executada |
| 2 | Isolamento entre unidades | PASS | **PASS** | Também no navegador (documento de outra unidade 403) |
| 3 | Gateway sintético | PASS | **PASS** (sintético) | Processo separado; não equivale a produção |
| 4 | Provisionamento sintético | PASS | **PASS** | MFA exigido; atestante sem acesso |
| 5 | Integridade de vendas | PASS | **PASS** | Livro sintético + aplicação idempotente no full stack |
| 6 | Recebíveis | PASS | **PASS** | Fluxo: sem data inventada |
| 7 | Obrigações | PASS | **PASS** | Parcela paga não volta na projeção |
| 8 | Tesouraria | PARCIAL | **PASS** | Fluxo de caixa = livro independente em todos os recortes |
| 9 | Importações | PASS | **PASS** | Cadeia completa pelo navegador |
| 10 | Conciliações | PASS | **PASS** (suíte) | Não exercitada pelo navegador |
| 11 | DRE | PASS | **PASS** | Sem regressão; mesmo valor em todas as telas |
| 12 | Documentos | PASS/parcial | **PASS** | Navegador integrado |
| 13 | Fechamento | PASS | **PARCIAL** (navegador) | Falta a ação "reclassificar lançamento" na interface |
| 14 | Concorrência | PASS | **PASS** | + revogação × aplicação |
| 15 | Recuperação | PARCIAL | **PARCIAL** | Reinício do PostgreSQL durante operação não testado |
| 16 | Interface operacional | PARCIAL | **PARCIAL** | Pilha completa funcionando; fechamento e teclado/paginação incompletos |
| 17 | Desempenho | FAIL | **FAIL** | Vendas, Central e Fechamento não otimizados |
| 18 | Plano de integração | PASS (doc) | **PASS (doc) / BLOQUEADO POR DEPENDÊNCIA EXTERNA** | § 0 e § 14 |

## 13. Bloqueios externos

1. Login da plataforma expondo `aal` confiável e revogação de contexto.
2. Onde roda a credencial `fv2_autoridade` (fora do processo da aplicação).
3. Conexão PostgreSQL direta e papéis no banco de homologação e produção.
4. Cofre real.
5. Aprovação das políticas de materialidade e retenção.

## 14. Critérios para a futura integração real

- Integração **dentro** da plataforma (login, empresa/unidade, navegação existentes); sem login financeiro próprio.
- `exigirConcessaoPersistida: true`. Concessões só pelo fluxo auditado. Administrador inicial atestado com MFA real.
- Rotas sob `requireContexto`, com flag por unidade (desligado por padrão). Reversão = desligar a flag, sem apagar dados.
- Antes de ativar qualquer unidade:
  - reclassificação de lançamento na interface;
  - otimização de Vendas, Central e Fechamento com equivalência;
  - mutação das barreiras da 0013.
