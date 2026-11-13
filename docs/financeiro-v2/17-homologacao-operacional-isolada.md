# Financeiro v2 — 17. Homologação operacional isolada (Execução 08)

Data: 13/11/2026. Branch local `feat/financeiro-v2-homologacao-isolada`, derivada de `a0fe2d1` (07B).

> **Somente sintético.**
> - **Empresa e unidades:** fictícias, só com identificadores sintéticos.
> - **Valores:** inventados e identificados como fictícios.
> - **Infraestrutura:** só PostgreSQL local isolado; nenhuma conexão com produção.
> - **Credenciais:** geradas na hora, fora do Git.
> - **Exposição:** nenhum serviço público, nenhum push, merge ou deploy.

## 1. Ambiente utilizado

| Componente | Como foi montado | Limite |
|---|---|---|
| PostgreSQL | Cluster próprio PG17 em `127.0.0.1:54329`, pasta fora do repositório, marcador por banco, migrações 0001–0012 | Recriado nesta execução: uma queda da sessão de trabalho corrompeu o cluster descartável (`fsync=off`) |
| Gateway | `backend/scripts/fv2/gatewayTeste.mjs`, **processo separado**, só loopback. Lê `gateway.json` (credencial `fv2_autoridade` + identidades com senha e segundo fator em scrypt) numa pasta temporária fora do Git | Mesmo usuário do sistema operacional: os processos poderiam ler os arquivos um do outro. **Não equivale** a um gateway de produção |
| Serviço da aplicação | Núcleo + adaptador PostgreSQL com a credencial `fv2_app`. Só conhece o endereço do gateway e o token do usuário | Exercitado pelos testes de integração, não como servidor HTTP próprio |
| Cofre | `criarCofreDisco` em pasta temporária: hash, versões, reinício e adulteração | Serviço real (armazenamento e criptografia em repouso) é dependência |
| Frontend | Demonstração local (`fv2-demo-interface`, 127.0.0.1:5179) | A demonstração usa repositório em **memória** e sessões de demonstração, não o PostgreSQL nem o gateway (§ 8) |
| Auditoria | `fv2_historico`, `fv2_auditoria_concessao`, `fv2_sessao_banco`, `fv2_provisionamento_inicial` e eventos JSONL do gateway (sem token nem senha, conferido em teste) | — |
| Scripts | `fv2-banco-teste.mjs iniciar \| estado \| parar \| destruir`; gateway iniciado e encerrado pelo teste | — |

## 2. Arquitetura (contratos)

```
navegador ──▶ serviço da aplicação ──(Bearer do usuário)──▶ GATEWAY (credencial fv2_autoridade)
                    │                                              │ fv2_abrir_sessao / _de_provisionamento
                    │ token de sessão de banco ◀───────────────────┘
                    ▼
        PostgreSQL (fv2_app): fv2_assumir_sessao(token) → RLS por unidade + autorização POR AÇÃO
```

**Contrato exigido do login real:**
- identidade validada;
- organização;
- unidades da identidade;
- nível de autenticação confiável (`aal`);
- logout e revogação, que precisam chamar `fv2_encerrar_sessoes`;
- credencial da autoridade fora do processo da aplicação.

## 3. Configurações de segurança (sem segredos)

| Papel | Função |
|---|---|
| `fv2_app` | Login de aplicação. Sem BYPASSRLS, sem DELETE/TRUNCATE e sem escrita em concessão. Lê e grava só pelas políticas |
| `fv2_autoridade` | Só emite e encerra sessões de banco |
| `fv2_guardiao` | Sem login. É dono das funções protegidas |

**Políticas:**
- escopo da sessão em todas as tabelas;
- leitura só com sessão operacional;
- inclusão e alteração **por ação** (§ 4).

## 4. Autorização por ação no PostgreSQL (Fase B)

**Migração 0012.** `fv2_tem_acao(ações[])` (guardião, `search_path` fixo, EXECUTE só para `fv2_app`) confere a **concessão viva** do usuário da sessão, no próprio comando. A revogação vale no comando seguinte.

**Mapa tabela × operação.** Foi **medido**: a suíte inteira (292 testes) rodou com instrumentação temporária registrando ação autorizada → tabela gravada. A instrumentação foi removida com hash conferido. Exemplos do mapa:

| Tabela | Inclusão | Alteração |
|---|---|---|
| Contas, categorias, canais, configuração | `configurar` (categoria também `registrar`) | `configurar` |
| Competência | `fechar` | Por **transição** (gatilho): homologar → `homologar`; reabrir homologada → `revisar`; demais → `fechar` |
| Versão de fechamento | `fechar` / `homologar` | Nunca |
| Importação, registro de fonte | `importar` | `importar` |
| Correspondência | `conciliar` | `conciliar` |
| Obrigação, venda, recebível, lançamento, movimentação | `registrar` / `revisar` (aplicação de proposta) | Correções e cancelamentos: `corrigir` / `cancelar` / `revisar` / `registrar` conforme o mapa |
| Concessão | Só pela função protegida (`conceder`) | Idem |
| Tabelas sem alteração legítima (vínculo, ajuste, estorno, saldo informado) | Conforme o mapa | **Recusada sempre**, com erro (WITH CHECK) |

**Ações pedidas pela execução × catálogo:**

| Ação pedida | Ação no catálogo |
|---|---|
| Visualizar indicadores | `ver` |
| Visualizar documentos | ficha: `ver`; arquivo: `documentos` |
| Importar e confirmar importações | `importar` |
| Criar propostas | `registrar` / `importar` |
| Aprovar e aplicar propostas | `revisar` |
| Obrigações, liquidações, caixa | `registrar` |
| Conciliar | `conciliar` |
| Contas e categorias | `configurar` |
| Conceder e revogar | `conceder` |
| Iniciar fechamento | `fechar` |
| Homologar | `homologar` |
| Reabrir | `revisar` |

> **Pendente de decisão:** separar "aprovar" de "aplicar" proposta, ou "conceder" de "revogar", exige **ações novas** no catálogo, o que muda a interface e as concessões existentes. Fica registrado como decisão de produto.

**Evidência** (`postgres-permissao-por-acao.test.js`, SQL direto com sessões **legítimas** e concessões limitadas):
- leitura tentando gravar: nada;
- importação tentando homologar: nada;
- conciliação tentando gravar obrigação ou conceder acesso: nada / `FV032`;
- fechar tentando homologar: `42501` (gatilho);
- operador fechando ou mudando conta: nada;
- configurador alterando obrigação: nada;
- tabela sem alteração legítima: `42501`;
- controles positivos gravam;
- núcleo "ingênuo" (sem conferir concessão gravada), com contexto que alega tudo: o **banco** recusa;
- revogação de **uma** ação no meio da transação: o comando seguinte é recusado.

> **Sobre "nada":** um UPDATE barrado pelo RLS não dá erro; ele não alcança linha alguma. O teste prova "nenhuma linha alterada". Onde a linha é visível mas a mudança é proibida, há erro `42501`.

## 5. Gateway local (Fase C)

Teste: `homologacao-gateway.test.js`, com o gateway como processo real separado.

| Cenário | Observado |
|---|---|
| Atestante **sem MFA** (aal1) | O gateway repassa aal1 e o **banco** recusa o provisionamento (`FV021`) |
| Atestante com MFA | Provisiona o administrador financeiro; o atestante **não** obtém sessão (`SEM_CONCESSAO`) |
| Quem não é administrador da plataforma tenta atestar | 403 |
| Gestor (só ver) | Lê; gravação recusada |
| Operador (ver + registrar) | Grava; em A2 (permitida no gateway, sem concessão) o banco recusa |
| Usuário de outra unidade | `UNIDADE_NAO_PERMITIDA` |
| Revogado | Próxima ação recusada |
| Token falso | 401 |
| Logout | Sessões de banco encerradas; leitura recusada |
| Sessão expirada (2 s) | 401 |
| Eventos registrados | Login, emissões, provisionamento, recusas, logout; sem token e sem senha |

## 6. Competência sintética e livro independente (Fases D e E)

Teste: `homologacao-competencia-sintetica.test.js`, setembro/2026 **fictício**. O livro esperado foi calculado **à mão** e está no cabeçalho do teste.

**Vendas:**
- balcão em dinheiro, cartão (Stone com taxa), Pix direto;
- iFood (com comissão), Anota AI;
- misto (dinheiro + débito Stone com taxa);
- desconto da loja, subsídio do iFood comprovado por documento, desconto sem financiador;
- cancelamento, devolução parcial;
- 2 pedidos importados do SAIPOS.

**Recebimentos:**
- repasse Stone **agrupado** (2 transações) com conciliação **candidata → confirmada com evidência**;
- iFood parcial;
- Anota AI recebido em outubro (posterior).

**Despesas:**
- insumos em 3 parcelas (parcial);
- aluguel, energia (parcial), água (vencida), contabilidade (paga em outubro), publicidade, motoboys (pagos em outubro);
- empréstimo com principal (10 parcelas, patrimonial) e juros separados;
- categorias que o plano-modelo não tinha (aluguel, energia, água, contabilidade) criadas pela administração de categorias.

**Caixa:**
- saldos de referência;
- abertura do caixa;
- entradas;
- suprimento;
- sangria para o banco (transferência interna);
- fechamento com diferença de −2,00, registrada e **não** ajustada.

**Importação:** documento → prévia → importação → propostas → aprovação → aplicação. Arquivo repetido devolve a mesma importação; aplicação e geração repetidas não duplicam.

**Valores fictícios — esperado (à mão) × observado (motor):**

| Item | Esperado | Observado |
|---|---|---|
| Faturamento bruto | 820,00 (Balcão 630,00; iFood 130,00; Anota AI 60,00) | igual |
| Deduções | 20,00 | igual |
| Receita líquida comercial | 800,00 | igual |
| Custos operacionais | 150,00 | igual |
| Despesas operacionais | 313,00 | igual |
| Resultado financeiro | −6,00 | igual |
| Resultado gerencial (sem ajuste de estoque) | 331,00 | igual |
| Patrimonial (fora do resultado) | 300,00 | igual |
| Caixa físico em 30/09 | 260,00 | igual |
| Banco em 30/09 | 1.314,00 | igual |
| Banco em 15/10 | 1.331,00 | igual |
| Recebíveis em aberto em 30/09 | 148,00 | igual |
| Recebíveis em aberto em 15/10 | 88,00 | igual |
| Contas a pagar em aberto em 15/10 | 398,00 | igual |

**Mesmos valores em todas as áreas:** Visão Geral, DRE, Vendas (`brutoProprioCentavos`), Caixa e Bancos (duas datas), Contas a Receber e Contas a Pagar. O teste também confere que o resultado por competência **não** é a variação de caixa e banco.

**Fluxo realizado e previsto:** não foram comparados com valores escritos à mão nesta execução. Fica **NÃO TESTADO** como valor independente; os testes de 06A e da 07 cobrem as regras.

**Ciclo de fechamento:**
1. aberta;
2. preliminar;
3. com pendências (documentadas);
4. homologação **bloqueada** pelo desconto sem financiador;
5. resolução documentada (reclassificação com justificativa);
6. homologação (apresenta a versão homologada);
7. liquidações posteriores em outubro;
8. alteração proibida em setembro (venda e movimentação recusadas);
9. reabertura sem justificativa recusada; com justificativa e confirmação, aceita;
10. nova homologação; resultado da competência reproduzido; conservação sem erro.

Nenhum critério de homologação foi alterado para o teste passar.

## 7. Segurança operacional (Fase F)

| # | Ataque | Evidência | Resultado |
|---|---|---|---|
| 1 | Leitura tentando gravar | Permissão por ação | Bloqueado |
| 2 | Importação tentando homologar | Permissão por ação; núcleo | Bloqueado |
| 3 | Conciliação concedendo acesso | Permissão por ação (`FV032`); núcleo | Bloqueado |
| 4 | Acesso entre unidades | Segurança 13/14; gateway | Bloqueado |
| 5 | Autoconcessão | Segurança 3/4 | Bloqueado |
| 6 | Escalada administrativa | Segurança 3/4 e 9 | Bloqueado |
| 7 | Sessão falsificada | Segurança 5/6; gateway | Bloqueado |
| 8 | Token revogado | Segurança 9; gateway (logout) | Bloqueado |
| 9 | Sessão expirada | Gateway | Bloqueado |
| 10 | Reutilização de conexão | Segurança 7/8; recuperação (conexão derrubada) | Bloqueado |
| 11 | SQL direto | Todas as suítes adversariais | Bloqueado |
| 12 | Funções privilegiadas | Segurança 5/6 (dono, `search_path`, EXECUTE) | Bloqueado |
| 13 | Concorrência de concessões | Segurança 9 (6 rodadas) | Bloqueado |
| 14 | Concorrência de homologação | `postgres-concorrencia`, `postgres-auditoria` | Bloqueado |
| 15 | Aplicação duplicada | Competência sintética; `formacao` | Bloqueado |
| 16 | Acesso documental indevido | Segurança 15 | Bloqueado |
| 17 | Arquivo do cofre modificado | Recuperação (adulteração detectada) | Bloqueado |
| 18 | Manipulação de identificadores | Segurança 3/4; `configuracoes-fechamento` 25–30 | Bloqueado |
| 19 | Contornar CSRF | Testes da interface (06C/06D: token por perfil, origem, confirmação) | Bloqueado na demonstração; **não** reexecutado contra o gateway |
| 20 | Requisições repetidas | Recuperação (3 envios simultâneos = 1 venda) | Bloqueado |

## 8. Jornadas no navegador (Fase J)

Executadas na demonstração local, por cliques e preenchimento de formulários na própria interface (sem chamar métodos internos):

| Jornada | Resultado |
|---|---|
| Gestor, operador e administrador abrem as 8 áreas | Todas carregam sem alerta |
| Perfil sem acesso | "Acesso negado" em todas |
| Operador rejeita uma proposta pendente na Central | Formulário com justificativa e confirmação; histórico registra **uma** rejeição com a justificativa. A tentativa sem confirmar não teve efeito |
| Administrador concede `ver` ao perfil sem acesso em Configurações | Aparece na lista com justificativa; o perfil passa a ver a Visão Geral, sem ações de escrita |
| Administrador revoga | O perfil volta a ter acesso negado imediatamente |
| Celular (375 px), 8 áreas | Sem rolagem horizontal |
| Só o administrador vê ações de configuração | Confirmado |

**Bloqueio declarado:** a interface **não** foi ligada ao PostgreSQL nem ao gateway; a demonstração usa memória. As jornadas comprovam a interface e as regras do núcleo, mas **não** a pilha de homologação completa pelo navegador. Por isso, interface operacional = **PASS parcial**: a jornada visual de ponta a ponta com o gateway está **NÃO TESTADA**.

## 9. Cofre (Fase G) e recuperação (Fase H)

Teste: `homologacao-recuperacao.test.js`.

| Item | Resultado |
|---|---|
| Backup (`pg_dump`) e restauração num banco novo | Mesma impressão da apuração; competência ainda homologada e protegida; mesmo número de linhas de histórico. Arquivo em pasta temporária fora do repositório |
| Conexão encerrada pelo servidor no meio da transação | Nada gravado pela metade |
| Requisição repetida (3 envios simultâneos) | Uma única venda |
| Reinício do backend e do cofre | Nova instância lê o mesmo estado; arquivo íntegro por hash; arquivo adulterado no disco é recusado |

**Defeito encontrado e corrigido.** Com a conexão derrubada, o erro emitido pela conexão ficava **sem tratamento** (exceção não capturada no processo) e a conexão podia voltar ao pool. Agora o adaptador escuta o erro e descarta a conexão.

**Coberto em execuções anteriores (não refeito aqui):** falha durante aplicação de proposta, conciliação e homologação (07, 06D).

**Não testado:** reinício do **gateway** (as sessões do gateway ficam em memória; reiniciar exige novo login), reinício do **servidor de banco** durante operação, e upload, PDF e download do cofre **pelo navegador** com o cofre em disco.

## 10. Desempenho e consultas remanescentes (Fase I)

Sem nova otimização nesta execução. Seguem os gargalos medidos na 07B (12 meses sintéticos):
- Vendas: ~430 ms;
- Central: ~424 ms;
- Pendências: ~393 ms;
- Fechamento: ~407 ms;
- Contas a Receber: ~222 ms.

**Causa:** essas telas montam a visão de vendas de todo o histórico. A correção exige carregar a competência junto com **todos** os vínculos dela (uma venda de setembro com liquidação em outubro precisa continuar investigável), com prova de equivalência.

**Risco:** o custo cresce com o histórico. **Prioridade:** alta antes de unidades com anos de dados. A permissão por ação acrescenta uma subconsulta por comando; não foi remedida.

## 11. Testes e regressões

| Suíte | `a0fe2d1` | Agora |
|---|---|---|
| Financeiro v2, memória | 292 | **301**, todos passando |
| Financeiro v2, PostgreSQL | 292 | **301**, todos passando |
| Frontend | 1.931 | 1.931, 0 falhas |
| Backend | 6.469 testes: 22 falhas e 1 cancelado | **Idêntico** a `a0fe2d1` (mesmas linhas de falha, todas preexistentes) |

**Mutação** (6): **5 mortos**.
- **Mortos:**
  - escrita genérica;
  - transição sem ação;
  - `fv2_tem_acao` sem concessão;
  - gateway ignorando unidades;
  - gateway tratando todo login como aal2.
- **Sobrevivente:** "conexão perdida volta ao pool". O pool do driver descarta conexões encerradas; a proteção efetiva é o tratamento do erro da conexão.

## 12. Limitações

- O gateway é sintético e roda no mesmo usuário do sistema operacional que a aplicação.
- A demonstração não usa a pilha de homologação.
- Fluxo realizado e previsto não foram conferidos com valores calculados à mão.
- Vendas, Central e Fechamento não foram otimizados.
- A granularidade das ações segue o catálogo atual (aprovar = aplicar; conceder = revogar).

## 13. Dependências reais

1. Login da plataforma entregando identidade, organização, unidades e **aal confiável**.
2. Gateway real com a credencial `fv2_autoridade` fora do processo da aplicação.
3. Operação de atestação (superadmin + MFA) e decisão de quem atesta.
4. Banco de homologação e de produção com os papéis; conexão PostgreSQL direta (pooler em modo transação).
5. Cofre real (armazenamento privado, criptografia, backup).
6. Políticas de materialidade e retenção (propostas; **não aprovadas** por teste).
7. Decisão sobre ações mais finas (aprovar ≠ aplicar; conceder ≠ revogar).

## 14. Plano de integração futura (Fase K — somente plano)

| Tema | Proposta |
|---|---|
| Implantação | Módulo **desligado** por padrão: rota inexistente sem flag; flag por unidade na configuração do servidor |
| Ativação de uma unidade | Escopo provisionado + administrador inicial atestado + homologação de uma competência real **autorizada** + aprovação do responsável |
| Monitoramento | Recusas `42501`/`FV0xx` por minuto; sessões emitidas e revogadas; eventos do gateway; tempo das consultas |
| Backup e recuperação | `pg_dump` diário do esquema `fv2_*` + cofre na mesma janela, com restauração testada |
| Reversão | Desligar a flag; dados preservados (nada se apaga); o financeiro antigo nunca é alterado |
| Infraestrutura | **Não presumida.** O uso de serviços existentes (inclusive Atlaz Cloud) não está autorizado por esta execução e precisa de validação |

## 15. Matriz PASS / FAIL

| # | Domínio | Classificação | Evidência |
|---|---|---|---|
| 1 | Segurança por ação | **PASS** | 0012; testes de permissão por ação; mutantes M1–M3 mortos |
| 2 | Isolamento entre unidades | **PASS** | Segurança 13/14; gateway |
| 3 | Gateway sintético | **PASS** (sintético; não equivale a produção) | Teste com processo separado; M5–M6 mortos |
| 4 | Provisionamento sintético | **PASS** | Gateway + banco (aal2, atestante sem acesso) |
| 5 | Integridade de vendas | **PASS** | Competência sintética (livro à mão) |
| 6 | Recebíveis | **PASS** | Repasse agrupado, parcial, posterior |
| 7 | Obrigações | **PASS** | Parcelada, parcial, mês seguinte, empréstimo |
| 8 | Tesouraria | **PASS** (saldos); fluxo **NÃO TESTADO** contra livro | Caixa e banco em duas datas |
| 9 | Importações | **PASS** | Cadeia completa + idempotência |
| 10 | Conciliações | **PASS** | Candidata → confirmada com evidência |
| 11 | DRE | **PASS** | Todas as linhas iguais ao livro |
| 12 | Documentos | **PASS** (cofre em disco por teste); navegador **NÃO TESTADO** | Recuperação |
| 13 | Fechamento | **PASS** | Ciclo 1–10 |
| 14 | Concorrência | **PASS** | Suítes 06D/07/07B + permissão revogada no meio |
| 15 | Recuperação | **PASS parcial** | Backup, restauração, conexão, reinício; gateway e servidor de banco **NÃO TESTADOS** |
| 16 | Interface operacional | **PASS parcial** | Jornadas na demonstração; pilha com gateway **NÃO TESTADA** |
| 17 | Desempenho | **FAIL** (gargalos conhecidos e não corrigidos) | Medição da 07B |
| 18 | Plano de integração | **PASS** (documento); execução **BLOQUEADA POR DEPENDÊNCIA EXTERNA** | § 14 |

## 16. Critérios de GO/NO-GO

- **GO** para a próxima etapa de engenharia em ambiente isolado:
  1. ligar a interface ao gateway e ao PostgreSQL;
  2. otimizar Vendas, Central e Fechamento com prova de equivalência;
  3. decidir a granularidade das ações.
- **NO-GO** para produção, dados reais ou integração com o login publicado, enquanto § 13 (itens 1–5) não estiver resolvido.
