# Centro Financeiro Inteligente MOVA — Execução 01 (fundação)

> Continuação: Execução 02 em [02-persistencia-baileys-acesso.md](02-persistencia-baileys-acesso.md). As decisões de lá substituem as daqui onde divergem (Evolution descartada; acesso por grupo sem vínculo individual).

Data: 20/11/2026 · Branch: `feat/mova-centro-financeiro` (a partir da `main` em `d65346d`) · **Nada publicado, nada ligado.**

Este documento não contém dados reais. Unidades, grupos, participantes, fornecedores e valores dos testes e da tela são
sintéticos ("Unidade Alfa/Beta/Gama"). Nenhum JID, telefone, CNPJ ou identificador de loja está no código.

## 1. Resumo por situação

| Situação | O que é |
|---|---|
| **Implementado** (código + testes) | Módulo `backend/src/modules/mova-financeiro/`: contrato de evento neutro de provedor, adaptadores Evolution e Baileys, fila idempotente com novas tentativas e fila de mortos, armazenamento de evidências por hash, configuração (grupos, unidades, fontes, vínculos), identificação de unidade fail-closed, contratos de IA estritos, porta financeira somente leitura sobre o Financeiro v2, motor de decisão e propostas simuladas. Tela `frontend/financeiro-v2/centro-financeiro.html` com as 8 seções. 17 testes (15 cenários + 2 de base) passando em memória e no PostgreSQL local de teste. |
| **Simulado** | Propostas, histórico, documentos vistos e respostas ficam **em memória**. Respostas vão para uma caixa de saída simulada (nada é enviado ao WhatsApp). O extrator de IA é simulado. A tela usa dados sintéticos e não chama o backend. |
| **Pendente** | Persistência (tabelas do MOVA, com migração), rota de webhook, leitura real do grupo, provedor de IA real, transcrição de áudio, aprovação/aplicação das propostas pelo serviço real, cofre durável de evidências, cadastro das fontes da North Shopping. Ver seção 9. |
| **Homologado** | Nada. Nenhuma parte foi exercida contra WhatsApp, Evolution, IA ou banco reais. |

## 2. Diagnóstico da arquitetura (o que existe hoje)

### 2.1 MOVA e WhatsApp
- **Não existe nada chamado "MOVA" no código.** O agente atual é o *Agente Crescer* (`backend/src/modules/agente/`), um assistente
  dentro da plataforma, sem canal WhatsApp.
- **O canal real é o Gateway próprio com Baileys** (`gateway-whatsapp/`, `baileys@6.7.24`), processo separado, HMAC nas duas
  direções, sem acesso a Supabase. **Não há Evolution API configurada**: ela só aparece como opção em `docs/ARQUITETURA.md` e como
  item "não configurado" em `plataforma.monitoramento.service.js`.
- **Grupos hoje:** só a exceção estreita de `gateway-whatsapp/src/grupoInterno.js` — listar nome/JID (sem participantes) e **enviar
  texto** ao único grupo interno configurado (`WHATSAPP_GRUPO_INTERNO_JID`), usado pelos relatórios automáticos
  (`comunicacao/relatorioDashboardGrupo.js`, `administrativo.comunicacao.grupoInterno.js`).
- **Mensagens recebidas de grupo são descartadas por desenho:** o contrato inbound do Gateway
  (`gateway-whatsapp/src/inboundContrato.js`) só leva texto de chat direto de cliente com telefone real; grupo vai como
  `origemJidTipo: "group"` sem conteúdo nem mídia, e o backend o grava como `IGNORED`
  (`backend/src/modules/comunicacao/inbound/inbound.contrato.js`). Mídia nunca é encaminhada (só o tipo `midia`).
- Webhooks/eventos existentes: `POST /internal/comunicacao/eventos/{mensagem-recebida,status-provider,heartbeat,auth-state}`
  (Gateway → backend). Nenhum deles serve ao MOVA sem mudança no Gateway.
- Problema conhecido em aberto (memória do projeto): o companion do WhatsApp fica preso no sync offline e inbound/receipts não
  chegam à Central — **risco direto** para ler o grupo pelo Baileys.

### 2.2 Financeiro v2
- `backend/src/modules/financeiro-v2/` (núcleo puro, injeção de dependências) + `fv2-integracao/` (rotas `/api/fv2/*` e
  `/acoes/*`, contexto verificado pela sessão da plataforma, escrita só com `FV2_ESCRITA_HABILITADA=1`).
- Permissões próprias `financeiro_v2.*` por organização + unidade (`dominio/contexto.js`), concessões gravadas
  (`aplicacao/sessao.js`), política de escopo fechada.
- **Propostas** existem só na formação a partir de importações (`aplicacao/formacao.js`): `OPERACAO_PROPOSTA` é um conjunto fechado
  (VENDA, VENDA_AGREGADA, PAGAMENTO_STONE, OBRIGACAO_ENTREGADOR, MOVIMENTACAO_BANCARIA) amarrado a `importacaoId`. **Não há proposta
  genérica de obrigação/pagamento vinda de documento avulso** — por isso o MOVA guarda as próprias propostas (seção 4) e as
  emite já no formato dos comandos reais.
- Obrigações: `registrarObrigacao` (contrato `comandos.validarObrigacao`), `pagarContaAPagar` (movimentação + liquidação, parcial
  permitido), `vincularPagamentoDoExtrato` (baixa por extrato), `cancelarObrigacao`, `corrigirObrigacao`, reclassificação separada.
- Competência: estados ABERTA → FECHAMENTO_PRELIMINAR → FECHAMENTO_COM_PENDENCIAS → FECHAMENTO_HOMOLOGADO.
- Fontes de faturamento por unidade (`aplicacao/fontesDeFaturamento.js`): exatamente um sistema de loja (SAIPOS ou SWF) + plataformas
  oficiais (iFood, 99Food); iFood/99Food **só pela fonte oficial** (`CANAIS_SO_PELA_FONTE_OFICIAL`), o PDV só confere.

### 2.3 As três unidades
| Unidade | Fontes (o que o código/registro mostra) | No MOVA |
|---|---|---|
| Subway Saci | SWF + iFood + 99Food, configurado em produção em 19/11 (PR #139) | perfil "SWF" confirmado |
| Subway North Shopping | **Nenhuma configuração encontrada no código.** Sem configuração gravada, o Financeiro v2 cai no padrão histórico (SAIPOS + iFood + 99Food) — o que provavelmente **não** é verdade para uma Subway | **A_CONFIRMAR**: nada de receita é orientado ou presumido |
| Açaí no Grau Saci | SAIPOS + iFood (+ Anota AI por pedido na SAIPOS) | perfil "SAIPOS" confirmado |

### 2.4 Alterações pendentes e conflitos
- A pasta principal está na branch `feat/financeiro-v2-producao` com ~20 arquivos modificados e não commitados (Financeiro v2,
  `fv2-integracao`, `frontend/financeiro-v2/*`). **Não foram tocados.** Esta execução foi feita num worktree isolado
  (`C:\dev\mova-financeiro`) a partir da `main`.
- Esta execução **não altera nenhum arquivo existente**: só cria arquivos novos. Conflito de merge esperado: nenhum.

## 3. Componentes reutilizados (sem cópia)
- Da superfície pública do Financeiro v2, **injetados** por quem monta (o MOVA não importa o núcleo: a regra de isolamento do
  projeto, `test/financeiro-v2/isolamento-estatico.test.js`, só permite isso a `fv2-integracao/`): `ACAO` (permissões),
  `ErroFinanceiro`, `comandos.validarObrigacao` (o comando proposto é validado pelo contrato real),
  `planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR`; e o mesmo contrato de concessões (`listar({organizacaoId, usuarioId})`).
- Operações de leitura do núcleo: `consultarContasAPagar`, `consultarCompetencia`, `consultarResumoFinanceiro`.
- Regra de fontes (sistema de loja único; iFood/99Food só pela plataforma) espelhada de `fontesDeFaturamento.js`/`formacao.js`.
- Padrões do Gateway: contrato estrito com códigos fechados de erro (como `inbound.contrato.js`), JID mascarado em log (como
  `grupoInterno.js`), sem conteúdo em log (como `logsafe.js`).
- Telas: Contas a Pagar, Contas a Receber e Conciliação **não foram duplicadas** — o Centro Financeiro leva às telas existentes.
- Visual: tokens de `frontend/financeiro-v2/fv2.css` e `tema.js` (claro/escuro da plataforma).

## 4. Estrutura criada
```
backend/src/modules/mova-financeiro/
  index.js                       superfície pública + criarMovaSimulado()
  contratos/evento.js            evento neutro de provedor (chaves fechadas; unidade nunca vem do provedor)
  adaptadores/mensagemWhatsapp.js leitura de texto/legenda/imagem/PDF/documento/áudio/resposta (protocolo WhatsApp)
  adaptadores/evolution.js       webhook messages.upsert da Evolution API v2 → evento bruto (SIMULADO)
  adaptadores/baileys.js         item messages.upsert do Baileys → evento bruto (PREPARADO, não ligado)
  gateway/fila.js                fila idempotente por eventoId, espera crescente, FALHOU (mortos)
  gateway/evidencias.js          evidências por sha256 (idempotência por documento)
  gateway/receptor.js            webhook → filtro de grupo → fila → mídia → evidência → motor
  dominio/configuracao.js        grupos autorizados, unidades/apelidos/documentos/fontes, vínculos
  dominio/unidade.js             identificação de unidade (fail-closed)
  dominio/fontesDeReceita.js     fonte oficial por canal; nunca PDV + plataforma ao mesmo tempo
  ia/contratos.js                saída estrita da IA, catálogo fechado de ferramentas, delimitação anti-injeção
  aplicacao/portaFinanceira.js   único caminho ao Financeiro v2: lista fechada, contexto só "ver"
  aplicacao/motor.js             decisão determinística e propostas
  aplicacao/respostas.js         textos ao grupo (nunca ecoam a entrada)
  infra/memoria.js               propostas, histórico, documentos, mensagens relacionadas, caixa de saída
backend/test/mova-financeiro/cenarios.test.js
frontend/financeiro-v2/centro-financeiro.html, centroFinanceiro.js, centroFinanceiro.css, centroFinanceiroSimulacao.js
```
Nada está montado em `src/routes.js` (o teste 15 trava isso). A página não tem entrada no menu do Financeiro.

### 4.1 Centro Financeiro (tela)
Visão Operacional · Caixa de Entrada MOVA · Propostas e Aprovações · Contas a Pagar (→ tela existente) · Contas a Receber
(→ tela existente) · Conciliação (→ Importações e Conferências) · Histórico do Agente · Configurações MOVA. Seletor de unidade: cada
unidade só vê o que é dela. Aprovar/Rejeitar desligados. Faixa permanente "Simulação". Conferida em desktop, celular (375 px, sem
rolagem horizontal) e tema escuro.

## 5. Integrações preparadas

### 5.1 Fluxo
```
Provedor (Evolution | Baileys) ──webhook──► receptor.receber()
   ├─ grupo não autorizado → descarta (nada baixado, guardado ou respondido)
   ├─ mensagem própria (inclusive respostas do MOVA) → descarta
   └─ fila.enfileirar(eventoId)  ← reenvio = DUPLICADO
receptor.trabalhar() → mídia (base64 ou obterMidia) → evidência sha256 → validarEvento → motor.processar()
motor: vínculo → resposta relacionada → documento repetido → IA (estrita) → intenção proibida → unidade → permissão
       → consulta | receita (só orienta) | pagamento | conta → competência → obrigações → PROPOSTA (simulada)
```

### 5.2 Decisões do motor
| Situação | Decisão |
|---|---|
| Comprovante de conta já cadastrada | Proposta **BAIXA_DE_OBRIGACAO** (comando `pagarContaAPagar`; parcial quando menor que o saldo). Nunca despesa nova. |
| Comprovante sem conta correspondente | Proposta **DESPESA_PAGA** (comando `registrarObrigacao` + pagamento) |
| Boleto/nota não pago | Proposta **NOVA_OBRIGACAO** (comando `registrarObrigacao`, validado pelo contrato real) |
| Boleto já registrado (valor + vencimento + fornecedor) / arquivo repetido | **DUPLICADO** |
| Várias contas compatíveis / valor maior que o saldo / dado faltando | **PEDIR_INFORMACAO** |
| Relatório de vendas / receita | **ORIENTACAO**: informa a fonte oficial; nunca propõe receita |
| Pedido de pagamento, exclusão ou correção | **BLOQUEADO** |
| Competência (do caixa ou econômica) fora de ABERTA | **BLOQUEADO** |

Categoria: o comando usa sempre `DESPESAS_A_CLASSIFICAR`; a categoria sugerida pela IA vai **ao lado**, para quem aprova.
Conta bancária do pagamento: `contaId: null` — escolhida por quem aprova.

### 5.3 Competência × caixa
- Baixa: competência = a da obrigação (não muda); caixa = data do pagamento (o mês do caixa precisa estar ABERTO).
- Despesa paga: competência = informada/emissão; caixa = data do pagamento; as duas precisam estar ABERTAS.
- Conta a pagar: competência = informada/emissão/vencimento; sem efeito de caixa.

### 5.4 Contratos de IA
- Saída com 16 chaves fechadas (`ia/contratos.js`); qualquer campo extra (`sql`, `acao`, `unidadeId`...) invalida a leitura inteira.
- Enums fechados para tipo de documento, intenção, natureza, consulta e confiança. Valores em centavos inteiros; datas ISO.
- A IA **não chama ferramentas**: o catálogo `FERRAMENTAS` é acionado só pelo motor. Não existe ferramenta de SQL, escrita direta
  ou pagamento.
- Conteúdo da mensagem/documento vai ao modelo entre delimitadores, como dado (`montarEntradaDoModelo`); `sinaisDeInjecao` só marca
  a proposta/histórico para revisão humana. A segurança não depende do modelo obedecer: a decisão é do motor.

## 6. Isolamento e permissões
- **Participar do grupo não dá acesso.** Só participante com vínculo explícito a um usuário da plataforma age; as permissões são as
  da **concessão gravada** desse usuário **na unidade** (`financeiro_v2.ver` para consulta; `ver` + `enviar_documento` para documento).
- O contexto enviado ao Financeiro carrega **só `financeiro_v2.ver`**, mesmo que o usuário tenha mais: o MOVA não herda poder.
- Porta com **lista fechada** de 3 operações de leitura; qualquer outra é recusada antes de chegar ao núcleo.
- Unidade: grupo de uma unidade → ela; texto cita apelido → ela; identificador do destinatário no documento → a dona dele; a sugestão
  da IA só confirma. Conflito, documento de outra unidade ou de unidade fora do grupo → bloqueia. Grupo compartilhado sem evidência →
  pergunta, e a **resposta à mensagem** (mensagem relacionada) completa a identificação.
- Propostas, histórico e documentos ficam por organização + unidade; nenhuma listagem sem unidade.

## 7. Segurança
- Somente consultas e propostas simuladas; nenhuma escrita no Financeiro (o teste espia o núcleo e falha se algo fora da lista for chamado).
- Bloqueados: pagamentos, exclusões, correções, classificação definitiva, competências fora de ABERTA.
- Logs (`registrar`) só com códigos e JID mascarado (4 últimos dígitos); o histórico guarda códigos e hash do documento, nunca texto.
- Respostas ao grupo nunca repetem o texto recebido.
- Mídia: só tipos aceitos (JPEG/PNG/WebP/PDF/áudio OGG/MP3/MP4), até 15 MB; grupo não autorizado nem chega a baixar.

## 8. Testes e resultados
`node --test test/mova-financeiro/` (memória) e `FV2_REPOSITORIO=postgres node --test test/mova-financeiro/` (PostgreSQL local
isolado, porta 54329): **17/17 nos dois**. Os cenários usam o núcleo real do Financeiro v2 (obrigações, competências, concessões).

Regressão do que poderia ser afetado por arquivos novos: isolamento do Financeiro v2 + contrato inbound do WhatsApp (70/70); os
20 testes do backend que varrem `src/` (416/418 — as 2 falhas são as pré-existentes das migrations 088 e 103, sem relação; nenhuma
migração foi criada); todos os testes `frontend/test/financeiroV2*` (160/160). A tela foi conferida no navegador (abas, unidade
"a confirmar", ligação para Contas a Pagar, celular 375 px, tema escuro).

| # | Cenário | Prova |
|---|---|---|
| 01 | Comprovante com legenda | unidade pela legenda; DESPESA_PAGA com competência 2026-09 × caixa 2026-10-10; nada gravado |
| 02 | Boleto não pago | NOVA_OBRIGACAO; comando normalizado pelo `validarObrigacao`; Contas a Pagar continua vazia |
| 03 | Pagamento de obrigação existente | BAIXA da obrigação certa (total e parcial); saldo intacto |
| 04 | Documento duplicado | mesmo arquivo → DUPLICADO; boleto já cadastrado → OBRIGACAO_JA_REGISTRADA |
| 05 | Unidade não identificada | pergunta; resposta relacionada resolve; sugestão da IA sozinha não decide |
| 06 | Documento da unidade errada | legenda × destinatário → bloqueia; documento de unidade fora do grupo → bloqueia |
| 07 | Participante sem permissão | sem vínculo → bloqueia; vínculo sem concessão na unidade → bloqueia |
| 08 | Grupo não autorizado | nada baixado, guardado, enfileirado ou respondido |
| 09 | Reenvio de webhook | entra uma vez; 1 proposta, 1 resposta |
| 10 | Falha de leitura | extrator falha / ilegível / mídia indisponível (3 tentativas → FALHOU + aviso) |
| 11 | Erro de comunicação com o Financeiro | nova tentativa sem duplicar; indisponível de vez → aviso, nada criado |
| 12 | Instrução maliciosa | proposta marcada para revisão; IA com campo `sql` recusada; pedido de pagamento bloqueado; nenhuma escrita |
| 13 | Competência × caixa | baixa mantém competência da obrigação; caixa em mês em fechamento bloqueia |
| 14 | Três unidades separadas | obrigação de uma não é baixada por outra; propostas/histórico por unidade; fontes: nunca PDV + plataforma; "a confirmar" não presume |
| 15 | Compatibilidade com o atual | inbound de grupo segue IGNORED; módulo fora de `routes.js`; motor não importa comunicação; respostas próprias ignoradas |

## 9. Dependências, riscos e o que falta
**Dependências**
1. Decidir o provedor: Evolution API (instância nova, custo e hospedagem) **ou** rota nova no Gateway Baileys restrita aos grupos do MOVA.
2. Payload real capturado (sem dados pessoais) para homologar o adaptador escolhido.
3. Provedor de IA (candidato: `agente/agente.provider.js`) com visão para imagem/PDF e transcrição de áudio.
4. Fontes da North Shopping cadastradas no Financeiro v2.
5. Vínculos participante → usuário cadastrados por um administrador (e concessão `financeiro_v2.enviar_documento` nas unidades).

**Riscos**
- Companion do WhatsApp preso no sync offline: com Baileys, mensagens do grupo podem não chegar (inbound hoje já não chega à Central).
- Ler o grupo real expõe conversas de três unidades: precisa de base legal/aviso aos participantes e retenção definida.
- Identificação de unidade por apelido depende de nomes bem distintos (configuração recusa apelido ambíguo).
- Duplicidade de boleto compara valor + vencimento + fornecedor; o identificador (linha digitável) não aparece na consulta de Contas
  a Pagar — comparar por ele exige expor o campo na consulta.
- Mídia sem antimalware até o cofre durável existir.

**O que falta (pendente)**
- Persistência das propostas/histórico/fila (migração própria, RLS por unidade) — exige autorização.
- Rota HTTP do webhook (com assinatura do provedor) e laço do `trabalhar()`.
- Aprovar/aplicar: tela + ação que chama `registrarObrigacao`/`pagarContaAPagar` **como a pessoa que aprova** (`financeiro_v2.aprovar` +
  `aplicar` + `registrar`), com a evidência anexada pelo cofre real.
- Ligar a tela à API (hoje lê `centroFinanceiroSimulacao.js`) e criar a entrada no menu.
- Envio das respostas ao grupo (hoje caixa de saída simulada) sem mexer nas mensagens automáticas atuais.

## 10. Próxima execução recomendada (02)
1. Decisão do provedor e captura de um payload real anonimizado (com o usuário).
2. Migração das tabelas do MOVA (propostas, histórico, fila, documentos) em banco de teste; persistência + rota de webhook desligada por flag.
3. Fluxo de aprovação/aplicação pelo serviço real, com testes de permissão (`aprovar`/`aplicar`) e idempotência.
4. Cadastro das fontes da North Shopping e dos vínculos; homologação em grupo de teste (nunca o grupo real) antes de qualquer leitura real.
