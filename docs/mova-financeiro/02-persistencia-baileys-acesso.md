# Centro Financeiro MOVA — Execução 02: persistência, integração Baileys e acesso pelo grupo

Data: 20/11/2026 · Branch `feat/mova-centro-financeiro` (sobre a Execução 01, `6c99f9b`) · **Nada publicado, nada ligado.**
Sem dados reais: unidades "Alfa/Beta/Gama", grupos, participantes e valores dos testes e da tela são sintéticos.

**O MOVA NÃO está operacional.** Não houve leitura do grupo real, mensagem real, IA real nem lançamento real.

## 1. Situação por item

| Situação | Itens |
|---|---|
| **Implementado e testado** | Schema `mova` (migração 0001); armazenamento, fila com lease e evidências em PostgreSQL; acesso por grupo (Nível 1 / Nível 2); registro automático de participantes; política de privacidade; motor com transferência interna, pedidos de revisão, consultas do grupo e dados insuficientes; aprovação/aplicação administrativa pelos serviços reais do Financeiro v2; consulta da Caixa de Entrada; caminho MOVA no Gateway (`movaGrupo.js`) e rota HMAC `/eventos/mova-grupo` no backend |
| **Desligado por padrão** | Gateway: sem `WHATSAPP_MOVA_GRUPOS_JID` nada é lido. Backend: a rota só existe quando um receptor do MOVA é **injetado** em `montarWhatsappGatewayRouter` — `app.js` não injeta, então em produção ela não existe (404, testado). Grupo no banco nasce `ativo = false`. |
| **Simulado** | Extrator de IA (roteiro fixo); Centro Financeiro com dados sintéticos no formato real da consulta; respostas ficam na caixa de saída com estado `PENDENTE` (nada enviado). |
| **Pendente** | Montagem do MOVA na camada `fv2-integracao` (é ela que pode importar o núcleo); rota autenticada do Centro Financeiro (ler a Caixa, aprovar/rejeitar); envio das respostas ao grupo; laço do worker; provedor de IA e transcrição de áudio; cofre durável de evidências (hoje bytea no banco de teste); papel de banco próprio do MOVA com RLS; concessão `ver` da identidade de serviço em cada unidade; fontes da North Shopping. |
| **Homologado** | Nada. Todos os testes usam eventos sintéticos no formato real. |

## 2. Arquitetura real
```
WhatsApp ──(socket Baileys EXISTENTE)── gateway-whatsapp
   messages.upsert ─┬─► fluxo atual (inboundContrato → /eventos/mensagem-recebida; grupo continua IGNORED, sem conteúdo)
                    └─► movaGrupo.js (só grupos de WHATSAPP_MOVA_GRUPOS_JID; fromMe/stub/privado fora;
                         mídia baixada pela MESMA sessão, ≤15 MB, base64) ──HMAC──► POST /internal/comunicacao/eventos/mova-grupo
backend: rota (só se injetada) → receptor (valida contrato estrito; privado/grupo não autorizado descartados;
         banco fora ⇒ 503 para o Gateway reenviar) → mova.fila (PostgreSQL, lease, `for update skip locked`)
         → worker: evidência (sha256) → evento validado → motor → mova.proposta / mova.decisao / mova.resposta
Centro Financeiro (sessão da plataforma) → aprovador: financeiro_v2.aprovar + aplicar + registrar
         → registrarObrigacao / pagarContaAPagar (núcleo real) → mova.aprovacao + mova.auditoria
```
- **Isolamento do núcleo preservado**: `mova-financeiro` não importa o Financeiro v2; recebe `{ACAO, ErroFinanceiro, validarObrigacao, categoriaProvisoria}` e o núcleo por injeção (`test/financeiro-v2/isolamento-estatico.test.js` passa).
- A camada de comunicação também não importa o MOVA: o bootstrap do Gateway recebe `mova = { receptor, rota, limiteBytes, caminho }`.

## 3. Gateway Baileys (`gateway-whatsapp/`)
- `src/movaGrupo.js` (novo): filtro dos grupos autorizados, payload `contratoMova: 1`, `eventoId = bly:<id>` (o mesmo em reentrega e reconexão), `respostaA` preservado, participante = JID do autor (telefone só com PN explícito), `nomeExibicao` = pushName (rótulo, **não identidade**), origem por mensagem lida do rastreador sem consumi-la (`espiar`), dedupe de ids recentes no processo, best-effort (falha nunca afeta o fluxo atual), nada de conteúdo em log.
- `baileysSession.js`: um gancho no início de `aoMessagesUpsert` (`mova?.aoMensagens`), em `try/catch`; o resto do handler idêntico — a guarda estrutural do contrato (sem decidir por `type`, `fromMe` continua fora) segue passando.
- `inboundContrato.js`: `espiar(id)` no rastreador (leitura sem liberar).
- `config.js`/`server.js`: `WHATSAPP_MOVA_GRUPOS_JID` (vazio = desligado; formato inválido derruba o boot); `downloadMediaMessage` do próprio Baileys com `sock.updateMediaMessage`. Nenhuma credencial, sessão ou auth state alterado; nenhuma segunda conexão.
- `backendClient.js`: `notificarEventoMova`.
- **Sync offline do companion:** o texto anterior o chamava de "não resolvido" — errado: foi resolvido em 25/09/2026 por re-pareamento. Diagnóstico e verificação antes de homologar: doc 03, seção 9.

## 4. Estrutura PostgreSQL (`database/mova-financeiro/migracoes/0001_mova_fundacao.sql`, schema `mova`)
`instancia_gateway`, `grupo_autorizado` (nasce desligado), `grupo_unidade` (apelidos, documentos, fontes), `participante`, `evidencia` (bytea, ≤15 MB — em produção, bucket privado), `evento` (único por grupo+mensagem), `documento` (idempotência por sha256 + dados extraídos), `proposta` (estados com transição travada por gatilho; final em APLICADA/REJEITADA; sem exclusão), `decisao`, `aprovacao`, `auditoria` (só inserção), `mensagem_pendente` (esclarecimento sobrevive a reinício; tomada atômica), `resposta` (`provider_message_id` evita laço), `fila` (lease). Ordenação por sequência (`seq`). Nada de obrigação/lançamento/concessão: isso é do Financeiro v2.
Aplicada **somente** em bancos `fv2_teste_mova_*` do PostgreSQL local isolado (127.0.0.1:54329), um por teste.

## 5. Acesso pelo grupo
- **Nível 1** (qualquer participante do grupo autorizado, sem cadastro/login): conversa, consultas compartilháveis, documentos, áudios, propostas. Registrado na 1ª mensagem; origem gravada em cada proposta/decisão.
- **Nível 2** (administrador): aprovar/rejeitar/aplicar **só** pelo Centro Financeiro, com o contexto verificado da plataforma. "aprovar …" no grupo é bloqueado e orientado ao Dashboard.
- Consultas ao Financeiro: identidade de serviço configurada, contexto **só `financeiro_v2.ver`**, lista fechada de 3 leituras.
- Unidade: texto, destinatário do documento ou resposta à pergunta — nunca o histórico do participante. Dúvida ⇒ "Esse lançamento pertence à Subway Saci, Subway North Shopping ou Açaí no Grau Saci?" (gerada dos nomes configurados).

## 6. Motor (contratos)
Decisões: `IGNORADO | BLOQUEADO | PEDIR_INFORMACAO | DUPLICADO | CONSULTA | ORIENTACAO | PROPOSTA | FALHA_LEITURA`.
Propostas: `BAIXA_DE_OBRIGACAO` (`pagarContaAPagar`), `DESPESA_PAGA` (`registrarObrigacao` + `pagarContaAPagar`), `NOVA_OBRIGACAO` (`registrarObrigacao`), `SOLICITACAO_DE_REVISAO` (sem comando).
Distingue: despesa nova, obrigação já cadastrada (duplicidade), pagamento de obrigação existente (baixa), **transferência interna** (favorecido é unidade da empresa ou intenção `INFORMAR_TRANSFERENCIA` ⇒ nunca despesa), documento duplicado (sha256), consulta, informação insuficiente.
IA: saída estrita de 16 chaves; novas intenções `INFORMAR_TRANSFERENCIA`, `PEDIR_CLASSIFICACAO`, `APROVAR_PROPOSTA`; consultas `COMPARATIVO_UNIDADES`, `SITUACAO_PROPOSTAS`, `DADO_RESTRITO`. A IA não acessa banco nem serviços.

## 7. Aprovação e aplicação (`aplicacao/aprovacao.js`)
Exige aprovar+aplicar+registrar; proposta da **mesma** unidade do contexto; passagem condicional `AGUARDANDO_REVISAO → APLICANDO` (concorrência: aplica uma vez); unidade com requisitos incompletos ⇒ recusada; conta bancária escolhida pelo administrador; **revalida** competência aberta, saldo da obrigação e duplicidade; aplica com fonte `MANUAL / MOVA:<proposta>` (idempotência também no Financeiro); falha devolve a proposta para revisão e grava `FALHOU`. Comprovante não concilia extrato. Nenhum pagamento bancário. Efeito conferido em Contas a Pagar e no resumo (fluxo de caixa realizado).

## 8. Privacidade (`dominio/privacidade.js`)
No grupo: totais/quantidades por unidade, comparativo entre unidades, situação de propostas, confirmação do documento enviado. Restrito (vai ao Dashboard; decidido **antes** da IA, sem enviar o texto ao modelo): dados bancários e saldos, documentos pessoais, funcionários/entregadores, credenciais, DRE/resultado detalhado. Toda resposta passa por `mascararDadosSensiveis`.

## 9. Subway North Shopping
Sem fontes no cadastro ⇒ `A_CONFIRMAR`: o MOVA recebe e prepara propostas, avisa no grupo, **bloqueia a aplicação** (`REQUISITOS_FINANCEIROS_INCOMPLETOS`), não presume SAIPOS nem orienta receita. As outras unidades seguem normalmente.

## 10. Centro Financeiro (`frontend/financeiro-v2/centro-financeiro.html`)
Caixa de Entrada com lista + detalhe no formato exato de `caixaDeEntrada`: mensagem original (texto, nunca HTML), participante (com aviso de que o nome não prova identidade), unidade, tipo documental, valores/datas extraídos, processamento, proposta, categoria sugerida, pendências (unidade, cadastro incompleto, texto suspeito) e histórico. Indisponibilidades reais expostas: abrir arquivo e aprovar/rejeitar (com o motivo). Faixa "Simulação" permanente; fora do menu de produção.

## 11. Testes (20/11/2026)
| Suíte | Resultado |
|---|---|
| MOVA backend (24 cenários + 3 extras), PostgreSQL local, núcleo em memória | 27/27 |
| Idem com o núcleo do Financeiro v2 também no PostgreSQL (`FV2_REPOSITORIO=postgres`) | 27/27 |
| Gateway inteiro (`npm test`), inclui 8 novos do MOVA | 1083/1083 |
| Backend relacionado (isolamento FV2, whatsapp-*, comunicacao-*, varreduras de `src/`, MOVA) | 1198/1200 |
| Frontend `financeiroV2*` + inteligência | 170/170 |
| Centro Financeiro em Chrome real (desktop, 375 px, tema escuro) | 3/3 |

**Falhas pré-existentes (não são da Execução 02):** "migration 088 — existência, rollback e numeração" e "103 e 103_rollback existem; nada acima de 103 apareceu junto" — já falhavam na Execução 01 e na `main`; verificam `database/migrations`, pasta não tocada.
Observação: a primeira rodada criou bancos `mova_teste_*` fora do padrão do ambiente; a guarda recusou o servidor e esses 26 bancos (criados por esta execução) foram removidos. A guarda não foi alterada; o helper agora usa `fv2_teste_mova_*`. Como no helper do Financeiro, os bancos de teste não são apagados ao fim.

## 12. Configuração para futuras homologações
1. Ambiente de teste do backend com o MOVA montado em `fv2-integracao` e injetado no router do Gateway; migração 0001 em banco de homologação; papel de banco próprio.
2. `WHATSAPP_MOVA_GRUPOS_JID` = **grupo de teste** (nunca o grupo real primeiro); confirmar antes que o inbound chega (telemetria do sync: doc 03, seção 9).
3. `instalarConfiguracao` com as três unidades, apelidos e fontes reais do cadastro (North `A_CONFIRMAR`); identidade de serviço com concessão `ver`.
4. Provedor de IA real só na Execução 03, atrás do mesmo contrato estrito.

## 13. Próxima execução (03 — Inteligência Artificial Financeira)
Provedor de IA com visão/PDF/transcrição atrás de `validarSaidaDaIa`; montagem em `fv2-integracao` + rotas autenticadas do Centro Financeiro (Caixa, aprovar/rejeitar); envio das respostas pelo Gateway com registro de `provider_message_id`; worker em laço; homologação em grupo de teste.
