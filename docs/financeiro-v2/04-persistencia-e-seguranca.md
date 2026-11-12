# Financeiro v2 — Execução 01B · Persistência PostgreSQL, integridade e segurança

Este documento descreve como o núcleo do Financeiro v2 passou a gravar em PostgreSQL e como isso foi testado. Tudo aconteceu num banco **local, exclusivo e descartável**, com dados sintéticos. Nenhuma migração foi aplicada em produção e nenhuma conexão com o Supabase foi aberta.

Ele não contém valores financeiros reais, credenciais, endereços de servidores ou dados pessoais.

---

## 1. Estratégia de PostgreSQL local

**Docker.** O cliente está instalado, mas o daemon não estava rodando. Iniciar o Docker Desktop seria mexer num serviço da máquina, então não foi usado.

**Alternativa adotada.** Já existe uma instalação do PostgreSQL 17 na máquina, servindo a porta padrão. O script [`backend/scripts/fv2-banco-teste.mjs`](../../backend/scripts/fv2-banco-teste.mjs) usa os binários dessa instalação (`initdb`, `pg_ctl`, `psql`) para criar um servidor separado:

| Item | Valor |
|---|---|
| Pasta | `%LOCALAPPDATA%\fv2-pg-teste`: fora do repositório e fora da pasta sincronizada com nuvem |
| Endereço | só `127.0.0.1`, numa porta própria (padrão 54329) |
| Usuários | `fv2_admin` (dono do servidor) e `fv2_teste_app` (aplicação, sem privilégio de dono) |
| Senhas e marcador | aleatórios, gerados na criação; gravados só em `ambiente.json`, dentro da pasta |
| Durabilidade | `fsync` desligado: os dados são descartáveis |

**O que o script não faz.** Não instala nada, não cria serviço do Windows, não toca no servidor da porta 5432, não lê o `backend/.env` e não usa variáveis do sistema atual.

```bash
cd backend
node scripts/fv2-banco-teste.mjs iniciar     # cria/liga e aplica as migrações no banco-modelo
node scripts/fv2-banco-teste.mjs estado
node scripts/fv2-banco-teste.mjs parar       # desliga, mantém os dados
node scripts/fv2-banco-teste.mjs destruir    # desliga e apaga SÓ a pasta do ambiente (que tem um arquivo-marca)
```

**Banco-modelo e bancos de teste.** As migrações são aplicadas uma vez num *banco-modelo*. Cada teste cria um banco novo copiando esse modelo (`create database … template`). Os testes não compartilham estado e nada é limpo com `DELETE`.

## 2. Configuração segura e guarda de destino

O módulo [`infra/postgres/destinoSeguro.js`](../../backend/src/modules/financeiro-v2/infra/postgres/destinoSeguro.js) põe duas barreiras antes de qualquer SQL. Recusar é o padrão: qualquer dúvida bloqueia.

**Barreira 1 — endereço declarado**, conferido antes de conectar. Só passa se todas as condições valerem:
- protocolo PostgreSQL;
- servidor `127.0.0.1` ou `::1`, como IP literal (nome de máquina não prova nada, nem `localhost`);
- porta explícita e diferente de 5432;
- banco `fv2_teste…` e usuário `fv2_…`;
- nenhum parâmetro que redirecione a conexão (`host`, `hostaddr`, `options`…).

A mensagem de recusa não repete o endereço nem a senha.

**Barreira 2 — destino efetivo**, a primeira consulta de cada conexão nova. O servidor precisa confirmar:
- que está no loopback, na porta, banco e usuário declarados;
- que o banco tem o **marcador secreto** do ambiente, gravado como comentário na criação;
- que não existe nenhum esquema ou papel típico de plataforma compartilhada (`auth`, `storage`, `service_role`, `authenticator`…);
- que não hospeda bancos de outros sistemas.

Conexão que não passa é descartada. O nome de uma variável conter "test" não vale nada: o que conta é o destino real.

**Quem usa as barreiras.** Toda conexão de script ou teste passa por [`scripts/fv2/ambiente.mjs`](../../backend/scripts/fv2/ambiente.mjs) (`abrirPoolSeguro`). O aplicador de migrações recusa qualquer conexão que não tenha vindo dele.

## 3. Estrutura de persistência

A migração [`database/financeiro-v2/migracoes/0001_fundacao.sql`](../../database/financeiro-v2/migracoes/0001_fundacao.sql) cria tabelas de prefixo `fv2_`. Elas ficam **fora** da sequência `database/migrations/` do sistema atual.

| Tabela | Conteúdo |
|---|---|
| `fv2_escopo` | Pares organização+unidade autorizados (provisionados fora da aplicação) |
| `fv2_conta`, `fv2_contraparte` | Contas financeiras (bancária, caixa físico) e contrapartes |
| `fv2_categoria` | Plano de contas hierárquico por unidade |
| `fv2_lancamento` | Fatos econômicos (receita, dedução, despesa, patrimonial) |
| `fv2_venda`, `fv2_pagamento_venda` | Venda e cada um de seus pagamentos |
| `fv2_obrigacao`, `fv2_recebivel` | Títulos a pagar e a receber (base, liquidado, ajustes, saldo) |
| `fv2_movimentacao`, `fv2_liquidacao`, `fv2_transferencia` | Dinheiro andando e seu vínculo com títulos |
| `fv2_ajuste`, `fv2_estorno` | Ajustes documentados de título e estornos (o original nunca muda de dono) |
| `fv2_documento`, `fv2_vinculo_documental` | Ficha do documento (hash, versão) e vínculos |
| `fv2_correspondencia`, `fv2_competencia` | Conciliação e estado de fechamento |
| `fv2_historico` | Auditoria: só acréscimo |
| `fv2_migracao` | Controle de migrações (nome + SHA-256) |

**Tipos.**
- Dinheiro é `BIGINT` em centavos. Nenhuma coluna é `numeric`, `real`, `double` ou `money`, e um teste confere isso no catálogo do banco.
- Datas civis são `DATE`; instantes são `TIMESTAMPTZ`.
- Identificadores são `UUID`.
- Origem externa vai em duas colunas: `*_sistema` e `*_id_externo`.
- Campos ainda não modelados como coluna ficam em `extras jsonb`, sem se perder.

**Adaptador.** [`infra/postgres/repositorioPostgres.js`](../../backend/src/modules/financeiro-v2/infra/postgres/repositorioPostgres.js) cumpre a mesma porta do adaptador em memória e não importa driver: recebe um pool já conferido.
- Os centavos trafegam como texto e voltam como inteiro seguro; valor fora da faixa segura é erro.
- **Nenhuma fórmula financeira foi reimplementada em SQL.** O núcleo calcula; o banco só confere somas e igualdades.

## 4. Transações

- Cada operação do núcleo é **uma transação**: `begin`, depois o escopo declarado na sessão (`set_config(..., true)`), as gravações e o `commit`. Qualquer erro faz `rollback` integral.
- As verificações que dependem de vários registros rodam **no commit**: integridade referencial, conservação de saldos, histórico obrigatório e par de transferência. São chaves estrangeiras e gatilhos de restrição `deferrable initially deferred`, porque uma operação composta grava registros que se referenciam mutuamente.
- Leituras usam transação `repeatable read read only`, um retrato consistente.

## 5. Unicidade

| Regra | Onde |
|---|---|
| Mesma origem externa não entra duas vezes **no mesmo escopo** | Índice único `(organizacao_id, unidade_id, chave_idempotencia)` em toda tabela |
| A mesma chave em outra organização/unidade é permitida | O índice inclui o escopo |
| Linha de extrato é única **por conta** | A chave da movimentação inclui a conta |
| Movimentações sem identificador externo nunca colidem | Dois pagamentos iguais no mesmo dia são dois pagamentos |
| Uma venda tem no máximo uma receita ativa | Índice único parcial em `fv2_lancamento` |
| Código de categoria único por unidade; documento único por SHA-256 no escopo | Restrições `unique` |

Mesma origem com o **mesmo** conteúdo devolve o registro existente (`repetido: true`). Com conteúdo **diferente**, é conflito: nunca sobrescreve.

## 6. Concorrência

O adaptador combina quatro mecanismos:

1. **Reserva de linha.** `obter` dentro de transação faz `SELECT … FOR UPDATE`: quem vai alterar um título ou uma movimentação espera quem chegou antes.
2. **Versão otimista.** Todo `UPDATE` confere `versao = esperada`. No banco, um gatilho exige que a versão suba de 1 em 1 e que identidade, escopo e autoria de criação não mudem.
3. **Reexecução.** Ao perder uma disputa (versão mudou, chave única já gravada, `serialization_failure`, `deadlock`), a operação inteira é refeita sobre o estado novo, até 5 vezes. Daí sai o resultado correto: registro repetido devolvido, saldo insuficiente recusado.
4. **Travas consultivas da competência.** Toda escrita toma a trava **compartilhada** do mês; mudança de estado de fechamento toma a **exclusiva**. Assim a homologação espera as escritas em andamento, e as escritas seguintes já veem a competência homologada.

## 7. Isolamento

- Toda tabela tem **RLS ligado e forçado**. A política só mostra e só aceita linhas do escopo declarado na transação. Sessão sem escopo não vê nada, nem a lista de escopos.
- Toda chave estrangeira leva `(organizacao_id, unidade_id)` junto: é impossível apontar para registro de outra organização ou unidade.
- O papel de aplicação (`fv2_app`) só tem `SELECT/INSERT/UPDATE` nas tabelas de dados e `SELECT/INSERT` no histórico. Não tem `DELETE` nem `TRUNCATE`, não cadastra escopos e não vê `fv2_migracao`.
- Mesmo o dono do banco esbarra em gatilhos que proíbem `DELETE`/`TRUNCATE` e qualquer `UPDATE` no histórico.

## 8. Migrações

- São aplicadas em ordem, cada uma numa transação, com nome e SHA-256 registrados. Migração já aplicada é pulada.
- Se o arquivo de uma migração aplicada mudar, o aplicador **para**: migração aplicada não se edita, cria-se outra.
- A 0001 foi testada **somente** no ambiente isolado: aplicada do zero num banco vazio, depois de novo (idempotência) e com arquivo adulterado (recusa).
- **Não existe caminho de aplicação em produção.** Quando chegar a hora, isso será um procedimento próprio, autorizado à parte.

## 9. Restrições de segurança cumpridas nesta execução

- O `backend/.env` não foi lido nem carregado. A regressão do backend rodou com variáveis fictícias apontando para uma porta fechada local.
- Nenhuma conexão com Supabase, nem consulta de preparação. Nenhuma migração em produção.
- Sem deploy, sem push, sem merge.
- `02-referencia-setembro.md` continua fora do Git. Nenhum valor real em código, teste ou documento versionado.
- Credenciais do banco de teste são temporárias, aleatórias e ficam só na pasta do ambiente, fora do repositório.

## 10. Cofre de documentos (contrato e estratégia)

O núcleo guarda só a **ficha** do documento. O arquivo original fica num cofre privado. O contrato está em [`contratos/cofre.js`](../../backend/src/modules/financeiro-v2/contratos/cofre.js); o adaptador em memória, em `infra/cofreMemoria.js`, serve só para testes com arquivos sintéticos. Nenhum serviço de nuvem foi integrado.

| Requisito | Como o contrato o garante |
|---|---|
| Controle de acesso | Toda operação recebe o escopo de um contexto já autorizado pelo núcleo |
| Organização e unidade | Arquivo de outro escopo responde como inexistente (não revela que existe) |
| Integridade | SHA-256 calculado ao guardar e **conferido a cada leitura**; adulteração é recusada |
| Armazenamento privado | O arquivo nunca vai para o Git nem para o banco financeiro; o identificador não traz nome, pessoa nem conteúdo |
| Vinculação documental | Ficha (`fv2_documento`) com o hash do cofre; vínculos por `fv2_vinculo_documental`, só acréscimo; cancelar ou estornar não remove evidência |
| Retenção e recuperação | Sem operação de exclusão; o mesmo conteúdo devolve o mesmo identificador; nova versão aponta para a anterior. O prazo legal de retenção e o backup do adaptador definitivo ficam para decidir |
| Sem URL pública | O contrato não tem como gerar link nem tornar público; a leitura devolve bytes a quem já passou pela autorização. Link temporário, se um dia existir, será decisão explícita e auditada |

## 11. Resultados dos testes

Cada suíte foi rodada duas vezes: com o adaptador em memória e com a mesma suíte inteira sobre o PostgreSQL isolado (`FV2_REPOSITORIO=postgres`).

| Arquivo | Testes | Cobre |
|---|---|---|
| 8 arquivos da Execução 01 | 63 | Fundação (ajustados à regra corrigida das taxas e ao plano de contas) |
| `pagamentos-vendas` | 7 | Dinheiro, Pix direto e pela Stone, Stone fora do balcão, pagamento misto, parcial + complemento, estorno parcial e total |
| `cancelamentos-estornos` | 7 | Cancelar venda/recebível, operação compensatória, estorno total/parcial de liquidação, movimentação e transferência, correção auditada, homologada |
| `plano-de-contas-taxas` | 6 | Hierarquia, modelos BASE/ACAITERIA, cadastro, classificação das taxas, Faturamento Líquido Gerencial × DRE sem dupla redução |
| `fechamento-cofre` | 5 | Regra de escrita por estado, reabertura auditada, cofre |
| `postgres-destino` | 6 | Rejeição de destino não autorizado (endereço e destino efetivo) |
| `postgres-integridade` | 6 | Migrações, integridade referencial, unicidade, RLS, sem exclusão/alteração silenciosa, homologada no banco |
| `postgres-concorrencia` | 10 | Venda simultânea, conflito de conteúdo, liquidações e alocações concorrentes, transferência repetida, estornos concorrentes, cancelar × liquidar, homologação × escritas, trava de competência, rollback |

**Total: 110 testes, todos passando nas duas rodadas.**

**Checagem por mutação.** Retirar a trava de competência (do lado da escrita ou do lado da decisão) derruba o teste determinístico de trava. Retirar só o `FOR UPDATE` ou só a reexecução **não** derruba teste nenhum: a outra camada cobre. Isso é defesa em profundidade, mas significa que cada uma dessas duas camadas, sozinha, não tem teste que a isole.

## 12. Riscos e limites conhecidos

- O PostgreSQL de teste é a versão 17 local. O de produção (Supabase) pode ter outra versão e extensões; a migração precisa ser revalidada lá antes de qualquer uso.
- O papel `fv2_app` e as políticas de RLS foram pensados para conexão direta. O formato da sessão no Supabase (`authenticated`, `service_role`, JWT) ainda não foi desenhado.
- A trava de competência só existe no adaptador PostgreSQL; em memória as transações já são serializadas.
- `extras jsonb` guarda campos auxiliares sem coluna própria (ex.: `grupoId` de parcelas já é coluna; `pagamentoIndice` e índices de retenção não). Se algum virar critério de consulta, merece coluna.

## Atualização — Execução 02 (12/11/2026)

- **Lacuna de testes da 01B fechada.** `postgres-trava-repeticao.test.js` força, com barreiras, os cenários em que
  `FOR UPDATE` e a repetição de transações são necessários: reserva de linha, corrida pela mesma origem e impasse (deadlock).
  Mutantes conferidos com cópia de segurança: sem `FOR UPDATE` falham os testes 1 e 3; sem repetição falham 2 e 3.
- Migração `0002_importacoes.sql`: `fv2_importacao` e `fv2_registro_fonte` com o mesmo molde (escopo, RLS forçado,
  histórico obrigatório, sem DELETE/TRUNCATE, chave de origem única por escopo), conteúdo importado imutável (`FV011`) e
  máquina de estados da importação no banco (`FV012`). Correspondência ganhou `relacao`, `regra`, `forca`, o estado
  `AGUARDANDO_DOCUMENTO` e a exigência de evidência para candidatas automáticas.
- O cofre local em disco (`infra/cofreDisco.js`) implementa os requisitos da seção do cofre para desenvolvimento; o cofre
  de produção continua pendente (requisitos em `05-importacoes-e-fontes.md`, seção 6).
